// The Postgres half of the production-simulating Supabase stack (see
// ./index.ts for the whole picture): the five tables the game write path
// actually touches, plus the parts of their server-side behavior that a test
// replaying a real game would otherwise silently lose — Row Level Security,
// the `game_state_sync_meta` trigger, and `game_state.version`'s
// compare-and-swap contract.
//
// Everything here is transcribed from supabase/migrations/*.sql rather than
// invented, and each rule below cites the migration it comes from. That's the
// whole point: these tests exist to catch the class of bug that only shows up
// once a real client, a real Edge Function and a real database policy are all
// in play, so a test double that quietly permits what production forbids
// would be worse than no test at all. Where a behavior is deliberately NOT
// modeled (Realtime, storage, Postgres types/constraints beyond primary keys)
// the request path throws loudly instead of guessing — see ./postgrestServer.ts.

import type { GameRow, PlayerRow } from '../../lib/dbTypes.ts'
import type { StoredGameState } from '../../lib/gameStateCompression.ts'

export type Row = Record<string, unknown>

/** Only the tables the game write path touches — anything else is a loud 404 from ./postgrestServer.ts. */
export type TableName = 'profiles' | 'games' | 'players' | 'game_state' | 'game_state_meta'

/**
 * Who a request runs as. `service_role` bypasses RLS entirely (Supabase's
 * usual behavior, and the reason the Edge Functions can write a
 * `ruleEnforcementEnabled` game's state at all — see
 * 0026_rule_enforcement_flag.sql); `authenticated` is a signed-in user whose
 * id is `auth.uid()` in every policy below.
 */
export interface Actor {
  role: 'service_role' | 'authenticated' | 'anon'
  userId: string | null
}

export interface ProfileRow {
  user_id: string
  display_name: string | null
  is_admin: boolean
}

export interface GameStateRow {
  game_id: string
  state: StoredGameState
  turn: number
  active_player_id: string | null
  version: number
  updated_at: string
}

export interface GameStateMetaRow {
  game_id: string
  status: string
  round_phase: string | null
  turn: number
  version: number
  pending_player_ids: string[]
  active_player_id: string | null
  updated_at: string
}

/** Thrown for anything the double deliberately doesn't model, so a test fails loudly instead of passing against a fiction. */
export class UnsupportedQueryError extends Error {}

/** A Postgres error the way PostgREST surfaces it — `code` is what gameApi.ts's insertGameState checks for (23505). */
export class DatabaseError extends Error {
  readonly status: number
  readonly code: string
  readonly details: string | null
  readonly hint: string | null

  constructor(status: number, code: string, message: string, details: string | null = null, hint: string | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.hint = hint
  }
}

const PRIMARY_KEY: Record<TableName, string> = {
  profiles: 'user_id',
  games: 'id',
  players: 'id',
  game_state: 'game_id',
  game_state_meta: 'game_id',
}

export type SqlCommand = 'select' | 'insert' | 'update' | 'delete'

export class Database {
  private rows: Record<TableName, Row[]> = {
    profiles: [],
    games: [],
    players: [],
    game_state: [],
    game_state_meta: [],
  }

  /** Direct, RLS-free access for arranging a test's starting fixture — the equivalent of seeding via `psql`, not via the API. */
  seed(table: TableName, row: Row): void {
    this.rows[table].push(structuredClone(row))
  }

  /** Direct, RLS-free read for asserting on what actually landed in the table. */
  table<T = Row>(table: TableName): T[] {
    return structuredClone(this.rows[table]) as T[]
  }

  /** Direct, RLS-free write of a whole row, matched on its primary key — for arranging a state the API itself cannot reach (a room moved back to the lobby, say). */
  replaceRow(table: TableName, row: Row): void {
    const key = PRIMARY_KEY[table]
    const existing = this.rows[table].find((candidate) => candidate[key] === row[key])
    if (!existing) throw new Error(`No ${table} row with ${key}=${String(row[key])} to replace.`)
    Object.assign(existing, structuredClone(row))
  }

  // ---------------------------------------------------------------------------
  // Row Level Security, transcribed from the migrations.
  //
  // Only the policies that matter to the game write path are modeled. Every
  // one is *permissive* (Postgres OR's multiple permissive policies for the
  // same command together), matching how the migrations are written; a
  // command with no policy at all is denied for `authenticated`, exactly like
  // a real RLS-enabled table.
  // ---------------------------------------------------------------------------
  private visible(actor: Actor, table: TableName, command: SqlCommand, row: Row): boolean {
    if (actor.role === 'service_role') return true
    if (actor.role !== 'authenticated' || !actor.userId) return false
    const uid = actor.userId

    switch (table) {
      // 0001_init_schema.sql: any signed-in user can read games/players and
      // create a game of their own (`created_by = auth.uid()`); only the
      // owner may change or delete it afterwards (0008_room_lifecycle.sql).
      case 'games':
        return command === 'select' || row.created_by === uid
      case 'players':
        return command === 'select' || row.user_id === uid
      case 'profiles':
        return row.user_id === uid || this.isAdmin(uid)

      case 'game_state': {
        const gameId = row.game_id as string
        const seated = this.isSeated(uid, gameId)
        if (command === 'select') {
          // 0021_remove_observers.sql + 0024_admin_read_all_game_state.sql,
          // narrowed by 0028_hidden_information_rls_lockdown.sql: a
          // hiddenInformationEnabled game denies direct SELECT outright, to
          // a seated player and a stranger alike — RLS can't redact within a
          // row, so get-game-state (service role, unaffected here) is the
          // only read path once this is on. An admin is untouched either
          // way, same as production's separate, additive admin policy.
          if (this.isAdmin(uid)) return true
          if (this.hiddenInformationEnabled(gameId)) return false
          const game = this.game(gameId)
          return seated || (game !== undefined && game.status !== 'lobby')
        }
        // 0001_init_schema.sql: the one genesis insert is any seated player's
        // to make, deliberately left untouched by 0026.
        if (command === 'insert') return seated
        if (command === 'update') {
          // 0026_rule_enforcement_flag.sql: a rule-enforced game's state is
          // service-role-write-only, i.e. only the Edge Functions may write it.
          return seated && !this.ruleEnforcementEnabled(gameId)
        }
        return false
      }

      // 0025_game_state_meta.sql: readable by the same audience as
      // game_state; never writable by `authenticated` — only the security
      // definer trigger writes it (see syncGameStateMeta below).
      case 'game_state_meta': {
        if (command !== 'select') return false
        const gameId = row.game_id as string
        const game = this.game(gameId)
        return this.isSeated(uid, gameId) || (game !== undefined && game.status !== 'lobby') || this.isAdmin(uid)
      }
    }
  }

  private isSeated(userId: string, gameId: string): boolean {
    return (this.rows.players as unknown as PlayerRow[]).some((p) => p.game_id === gameId && p.user_id === userId)
  }

  private isAdmin(userId: string): boolean {
    return (this.rows.profiles as unknown as ProfileRow[]).some((p) => p.user_id === userId && p.is_admin)
  }

  private game(gameId: string): GameRow | undefined {
    return (this.rows.games as unknown as GameRow[]).find((g) => g.id === gameId)
  }

  private ruleEnforcementEnabled(gameId: string): boolean {
    return Boolean(this.game(gameId)?.settings?.ruleEnforcementEnabled)
  }

  private hiddenInformationEnabled(gameId: string): boolean {
    return Boolean(this.game(gameId)?.settings?.hiddenInformationEnabled)
  }

  // ---------------------------------------------------------------------------
  // The three statements PostgREST turns a request into.
  // ---------------------------------------------------------------------------

  select(actor: Actor, table: TableName, match: (row: Row) => boolean): Row[] {
    return this.rows[table].filter((row) => match(row) && this.visible(actor, table, 'select', row)).map((row) => structuredClone(row))
  }

  insert(actor: Actor, table: TableName, values: Row[]): Row[] {
    const inserted: Row[] = []
    for (const values_ of values) {
      const row = { ...this.defaults(table), ...structuredClone(values_) }
      const key = PRIMARY_KEY[table]
      if (this.rows[table].some((existing) => existing[key] === row[key])) {
        throw new DatabaseError(409, '23505', `duplicate key value violates unique constraint "${table}_pkey"`)
      }
      // A row RLS rejects is `new row violates row-level security policy`, a
      // 42501 — not a silent no-op the way a filtered-out UPDATE is.
      if (!this.visible(actor, table, 'insert', row)) {
        throw new DatabaseError(403, '42501', `new row violates row-level security policy for table "${table}"`)
      }
      this.rows[table].push(row)
      inserted.push(structuredClone(row))
      this.afterWrite(table, row)
    }
    return inserted
  }

  /**
   * PostgREST's UPDATE: rows the filter doesn't select, and rows RLS hides,
   * are simply not updated — no error, an empty result set. That silence is
   * exactly what `writeGameStateCAS` (and gameApi.ts's `writeGameState`)
   * read as "someone else got there first", so it has to stay silent here too.
   */
  update(actor: Actor, table: TableName, match: (row: Row) => boolean, patch: Row): Row[] {
    const updated: Row[] = []
    for (const row of this.rows[table]) {
      if (!match(row)) continue
      if (!this.visible(actor, table, 'update', row)) continue
      Object.assign(row, structuredClone(patch))
      if (table === 'games' || table === 'game_state') row.updated_at = new Date().toISOString()
      updated.push(structuredClone(row))
      this.afterWrite(table, row)
    }
    return updated
  }

  delete(actor: Actor, table: TableName, match: (row: Row) => boolean): Row[] {
    const deleted: Row[] = []
    for (let i = this.rows[table].length - 1; i >= 0; i--) {
      const row = this.rows[table][i]
      if (!match(row) || !this.visible(actor, table, 'delete', row)) continue
      this.rows[table].splice(i, 1)
      deleted.push(structuredClone(row))
      if (table === 'games') this.cascadeFromGame(row.id as string)
    }
    return deleted
  }

  /**
   * `on delete cascade` from `games` (0001_init_schema.sql for players and
   * game_state, 0025_game_state_meta.sql for the meta projection). Deleting a
   * room really does take its rows with it — without this, anything that
   * cleans up after itself by deleting the room (the production smoke runner,
   * ../productionSmoke/) would look like it worked while leaving orphans.
   */
  private cascadeFromGame(gameId: string): void {
    for (const table of ['players', 'game_state', 'game_state_meta'] as const) {
      this.rows[table] = this.rows[table].filter((row) => row.game_id !== gameId)
    }
  }

  /** `on delete cascade` from `auth.users` to `profiles` (0005_discord_webhooks.sql). */
  deleteProfileFor(userId: string): void {
    this.rows.profiles = this.rows.profiles.filter((row) => row.user_id !== userId)
  }

  private defaults(table: TableName): Row {
    const now = new Date().toISOString()
    switch (table) {
      case 'game_state':
        return { turn: 0, active_player_id: null, version: 0, updated_at: now }
      case 'game_state_meta':
        return { round_phase: null, turn: 0, version: 0, pending_player_ids: [], active_player_id: null, updated_at: now }
      // `gen_random_uuid()` on the primary key (0001_init_schema.sql) — a row
      // inserted through the API supplies no id, only a seeded fixture does.
      case 'games':
        return { id: globalThis.crypto.randomUUID(), created_at: now, updated_at: now, config_version: 1, visibility: 'private', status: 'lobby' }
      case 'players':
        return { id: globalThis.crypto.randomUUID(), avatar_url: null, is_active: true, joined_at: now }
      case 'profiles':
        return { display_name: null, is_admin: false }
      default:
        return {}
    }
  }

  private afterWrite(table: TableName, row: Row): void {
    if (table === 'game_state') this.syncGameStateMeta(row as unknown as GameStateRow)
  }

  /**
   * `game_state_sync_meta`, the after-insert-or-update trigger from
   * 0028_hidden_information_rls_lockdown.sql (which replaced
   * 0027_game_state_meta_pending_players.sql, which replaced
   * 0025_game_state_meta.sql's simpler version).
   *
   * Transcribed field for field, including the detail that makes it worth
   * modeling at all: it reads `status`/`roundPhase`/`turn`/`pendingPlayerIds`/
   * `turnOrder`/`boardSetup` straight off the stored JSON with `->>`/`->`,
   * so it can only see them if they're in plaintext. A rule-enforced game's
   * state column is gzipped (gameStateCompression.ts), which is why that
   * encoding duplicates exactly these keys alongside the blob — issue #451.
   * Reading the stored row here rather than a decompressed GameState is what
   * lets a test notice if that duplication ever regresses.
   */
  private syncGameStateMeta(row: GameStateRow): void {
    const state = row.state as unknown as Record<string, unknown>
    const status = (state.status as string | undefined) ?? 'unknown'
    const roundPhase = (state.roundPhase as string | undefined) ?? null
    const turnOrder = (state.turnOrder as string[] | undefined) ?? []
    const boardSetup = state.boardSetup as Record<string, unknown> | null | undefined

    let pending: string[] = []
    if (status === 'boardSetup') {
      if (boardSetup && ((boardSetup.tileTierQueue as unknown[] | undefined) ?? []).length > 0) {
        const builderId = boardSetup.builderId as string | null | undefined
        if (builderId != null) pending = [builderId]
        else if (turnOrder.length > 0) pending = [turnOrder[Number(boardSetup.tilePlacerIndex ?? 0) % turnOrder.length]]
      } else if (boardSetup && Object.keys((boardSetup.unitsRemainingByPlayerId as Record<string, unknown> | undefined) ?? {}).length > 0) {
        if (turnOrder.length > 0) pending = [turnOrder[Number(boardSetup.unitPlacerIndex ?? 0) % turnOrder.length]]
      }
    } else if (status === 'active' && (roundPhase === 'selectCards' || roundPhase === 'decline')) {
      pending = ((state.pendingPlayerIds as string[] | undefined) ?? []).slice()
    }

    const meta: GameStateMetaRow = {
      game_id: row.game_id,
      status,
      round_phase: roundPhase,
      turn: Number(state.turn ?? 0),
      version: row.version,
      pending_player_ids: pending,
      active_player_id: row.active_player_id,
      updated_at: new Date().toISOString(),
    }
    const existing = this.rows.game_state_meta.find((m) => m.game_id === row.game_id)
    if (existing) Object.assign(existing, meta)
    else this.rows.game_state_meta.push(meta as unknown as Row)
  }
}

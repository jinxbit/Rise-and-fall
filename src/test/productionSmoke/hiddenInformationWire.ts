// HIDDEN_INFORMATION_PLAN.md §8 phase 9: proves the secret an opponent isn't
// entitled to yet never reaches their browser over the wire — in any
// response, not just that the UI declines to render it — against a real,
// deployed project (or, for the half that doesn't need a socket, the
// in-process stack).
//
// Reuses this directory's existing provisioning (provisionLiveRoom,
// runSmoke.ts's fixtureForRoom/replayFixtureThroughStack) rather than a
// second path to a live project, per this directory's README: private room,
// 'live' play mode, room deleted before its throwaway users. The only new
// surface on `LiveRoom` is `clientFor` (liveProject.ts), needed for the raw
// (uncollapsed) Edge Function response and the real Realtime subscription
// this check makes — `applyAction`/`getGameState` already collapse the wire
// response before a caller ever sees it, which is exactly what this file
// needs to bypass.
//
// A three-seat room, not two: issue #478's write-path leak (apply-action's
// own response handing the acting player another still-pending seat's pick)
// only shows up when someone *other* than the last-to-act player submits —
// in a two-player game the acting player is always last, so the phase has
// already resolved by the time their own response comes back. See
// ../__tests__/writePathRedaction.test.ts, which pins the same reasoning at
// the Edge Function level.
//
// Split into a wire half (get-game-state/apply-action raw response bodies)
// and a Realtime half: the in-process stack (src/test/supabaseStack/)
// patches only `fetch`, not WebSocket, so it can run the wire half on every
// PR (../__tests__/hiddenInformationWireRunner.test.ts) but not the Realtime
// half, which only ever runs against a live project
// (./hiddenInformationWire.smoke.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { applyAction } from '../../engine/applyAction.ts'
import type { Action } from '../../engine/actions.ts'
import { getTile, neighborCoords } from '../../engine/board.ts'
import { coordKey, type Coordinate, type GameState } from '../../engine/types.ts'
import { buildGenesisState } from '../../lib/gameGenesis.ts'
import type { GameRow, GameSettings, PlayerRow } from '../../lib/dbTypes.ts'
import { buildFixture, type ProductionGameFixture } from '../fixtures/productionGames/loadFixtures.ts'
import { nextLegalAction, resolveGameContent } from '../supabaseStack/sampleGame.ts'
import { replayFixtureThroughStack } from '../supabaseStack/replayFixture.ts'
import { provisionLiveRoom, type LiveProjectConfig } from './liveProject.ts'
import { fixtureForRoom, type SmokeLogger } from './runSmoke.ts'

const GAME_ID = '3f1c2d4e-0000-4000-8000-0000000000f9'

const SEATS: PlayerRow[] = [0, 1, 2].map(
  (index) =>
    ({
      id: `hiw-seat-${index}`,
      game_id: GAME_ID,
      user_id: `hiw-user-${index}`,
      display_name: `Wire Check Player ${index + 1}`,
      avatar_url: null,
      seat_index: index,
      color: ['#e11', '#11e', '#1e1'][index],
      is_active: true,
    }) as PlayerRow,
)

function settingsForWireCheck(): GameSettings {
  return {
    mapTemplateId: 'classic',
    mapPoolBoard: null,
    mapPoolMapId: null,
    mapPoolRandomAtStart: false,
    soloBuildMap: false,
    soloBuilderSelection: 'owner',
    soloBuilderId: null,
    soloBuilderUnitOrder: 'last',
    soloBuilderTurnOrder: null,
    skipHotseatPassGate: false,
    ruleEnforcementEnabled: true,
    hiddenInformationEnabled: true,
    lockRevealedInformationEnabled: false,
    activeTaleIds: [],
    gameLength: 3,
  }
}

function gameRowForWireCheck(settings: GameSettings): GameRow {
  return {
    id: GAME_ID,
    room_code: 'HIWTST',
    name: 'hidden-information wire self-test',
    play_mode: 'live',
    status: 'active',
    min_players: SEATS.length,
    max_players: SEATS.length,
    created_by: SEATS[0].user_id,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    settings,
    config_version: 1,
    visibility: 'private',
  }
}

const TARGET_SEAT_ID = SEATS[0].id
const TEMPLE_TERRAINS = new Set(['plain', 'mountain'])

function applyOne(state: GameState, action: Action, content: ReturnType<typeof resolveGameContent>): GameState {
  const result = applyAction(state, action, content.unitContent, content.achievementContent, content.boardGenerationContent, content.taleContent)
  if (!result.ok) throw new Error(`Setup action ${JSON.stringify(action)} was rejected: ${result.error}`)
  return result.state
}

/**
 * BFS over the target seat's own movement-eligible, unoccupied terrain from
 * `start`, returning the first step toward the nearest tile whose terrain is
 * in `targetTerrains` — or null if none is reachable that way within 40
 * hex-steps (comfortably more than this file's small generated boards ever
 * need). `nextLegalAction` (sampleGame.ts) always takes the first legal
 * option, which is fine for passing turns but useless for actually walking
 * a unit somewhere in particular — this is that missing piece, kept local to
 * this file rather than sampleGame.ts since nothing else needs it.
 */
function stepToward(state: GameState, start: Coordinate, movableTerrains: Set<string>, targetTerrains: Set<string>): Coordinate | null {
  const startKey = coordKey(start)
  const cameFrom = new Map<string, string>()
  const visited = new Set([startKey])
  let frontier = [start]
  for (let depth = 0; depth < 40 && frontier.length > 0; depth++) {
    const next: Coordinate[] = []
    for (const coord of frontier) {
      for (const neighbor of neighborCoords(state.board, coord)) {
        const key = coordKey(neighbor)
        if (visited.has(key)) continue
        const tile = getTile(state.board, neighbor)
        if (!tile) continue
        const occupied = state.units.some((u) => coordKey(u.coord) === key)
        const isTarget = targetTerrains.has(tile.terrain)
        if (occupied && !isTarget) continue
        if (!movableTerrains.has(tile.terrain) && !isTarget) continue
        visited.add(key)
        cameFrom.set(key, coordKey(coord))
        if (isTarget && !occupied) {
          let cursor = key
          while (cameFrom.get(cursor) !== startKey) cursor = cameFrom.get(cursor)!
          const [q, r] = cursor.split(',').map(Number)
          return { q, r }
        }
        next.push(neighbor)
      }
    }
    frontier = next
  }
  return null
}

/**
 * Drives toward Temple mastery (content/achievements.json: the first player
 * to simultaneously control their full per-player supply of Temples claims
 * it) via the one path to a Temple that doesn't depend on already owning
 * one: a Nomad's own `transform-to-temple` (self, no City/Temple involved,
 * content/units.json), which costs 2 stone and only works standing on
 * Plain or Mountain. So: City creates a Nomad on a free adjacent hex (free);
 * that Nomad walks to the nearest Mountain (stepToward, for the stone its
 * `produce-resource` earns there); once it's holding 2 stone, it
 * transforms in place. Repeated three times over — reusing the City's hex
 * once its previous Nomad has walked off it — this is the cheapest mastery
 * to reach without needing a live board's actual terrain/adjacency known in
 * advance, chosen because content/units.json caps Temple's per-player
 * supply at 3, the lowest of the six kinds.
 *
 * Split into "which card kind to pick" (below, for the selectCards phase)
 * and "what to do with it" (this function, for the actions phase) rather
 * than one combined decision recomputed at both points: a card, once
 * chosen, sits in the target's hand for the whole round regardless of what
 * else changes, but *which* kind that will be next isn't decided again
 * until it actually needs to be — recomputing "what does the target want"
 * from scratch at actions time, instead of asking "what should the
 * `cardKind` actually in play this round do", risks answering for a kind
 * that isn't the one that got chosen (RESOLVE_UNIT_ACTION requires
 * `actingUnit.kind === card.kind`, ../../engine/applyAction.ts).
 */
function templeMasteryAction(state: GameState, cardKind: string): Action | null {
  if (state.units.filter((u) => u.ownerId === TARGET_SEAT_ID && u.kind === 'temple').length >= 3) return null

  if (cardKind === 'city') {
    const nomad = state.units.find((u) => u.ownerId === TARGET_SEAT_ID && u.kind === 'nomad')
    if (nomad) return null // Already have one to work with this round instead — see chooseCardKindForTemple.
    const city = state.units.find((u) => u.ownerId === TARGET_SEAT_ID && u.kind === 'city')
    if (!city) return null
    const emptyNeighbor = neighborCoords(state.board, city.coord).find((c) => {
      const tile = getTile(state.board, c)
      if (!tile || tile.terrain === 'water' || tile.terrain === 'glacier') return false
      return !state.units.some((u) => coordKey(u.coord) === coordKey(c))
    })
    return emptyNeighbor ? { type: 'RESOLVE_UNIT_ACTION', playerId: TARGET_SEAT_ID, unitActions: [{ unitId: city.id, actionId: 'create-nomad', target: emptyNeighbor }] } : null
  }

  if (cardKind === 'nomad') {
    const nomad = state.units.find((u) => u.ownerId === TARGET_SEAT_ID && u.kind === 'nomad')
    if (!nomad) return null
    const player = state.players.find((p) => p.id === TARGET_SEAT_ID)!
    const onTempleTerrain = TEMPLE_TERRAINS.has(getTile(state.board, nomad.coord)?.terrain ?? '')
    if (onTempleTerrain && player.resources.stone >= 2) {
      return { type: 'RESOLVE_UNIT_ACTION', playerId: TARGET_SEAT_ID, unitActions: [{ unitId: nomad.id, actionId: 'transform-to-temple' }] }
    }
    if (getTile(state.board, nomad.coord)?.terrain === 'mountain') {
      return { type: 'RESOLVE_UNIT_ACTION', playerId: TARGET_SEAT_ID, unitActions: [{ unitId: nomad.id, actionId: 'produce-resource' }] }
    }
    const step = stepToward(state, nomad.coord, new Set(nomad.movement.terrains), new Set(['mountain']))
    return step ? { type: 'RESOLVE_UNIT_ACTION', playerId: TARGET_SEAT_ID, unitActions: [{ unitId: nomad.id, actionId: 'move', target: step }] } : null
  }

  return null
}

/** Which card kind the target seat wants in hand for templeMasteryAction's next move — a Nomad to walk/produce/transform if it has one, otherwise a City to create one, or nothing once Temple mastery is already secured. */
function chooseCardKindForTemple(state: GameState): 'city' | 'nomad' | null {
  if (state.units.filter((u) => u.ownerId === TARGET_SEAT_ID && u.kind === 'temple').length >= 3) return null
  return state.units.some((u) => u.ownerId === TARGET_SEAT_ID && u.kind === 'nomad') ? 'nomad' : 'city'
}

/**
 * Plays board setup, then reaches a freshly-opened `phase` (everyone
 * pending, nobody's committed yet), then plays exactly one CHOOSE_CARD/
 * MOVE_TO_DECLINE — landing on one seat committed and the other two still
 * pending. Driven straight against the pure engine (no stack, no network);
 * this is only a script for a short, valid history — `buildHiddenInformation
 * Fixture` below is what turns it into something `provisionLiveRoom` can
 * replay for real.
 *
 * `selectCards` opens for free at genesis's first round, so nextLegalAction
 * (sampleGame.ts, always the first legal option) gets there in a couple
 * dozen board-setup actions. `decline` only opens once an achievement is
 * claimed this round (isDeclineTriggered, ../../engine/decline.ts) — never
 * true if every actions-phase turn just passes — so reaching it needs the
 * target seat to actually play toward one instead (chooseCardKindForTemple/
 * templeMasteryAction above).
 */
function playToFreshPhase(phase: 'selectCards' | 'decline'): GameState {
  const settings = settingsForWireCheck()
  const genesis = buildGenesisState(gameRowForWireCheck(settings), SEATS)
  const content = resolveGameContent(genesis)

  let state = genesis
  for (let guard = 0; ; guard++) {
    if (guard > 5000) throw new Error(`Setup ran on far longer than reaching a fresh ${phase} phase should take.`)
    if (state.status === 'active' && state.roundPhase === phase && state.pendingPlayerIds.length === SEATS.length) break

    let action: Action | null
    if (phase === 'decline' && state.status === 'active' && state.roundPhase === 'selectCards' && state.pendingPlayerIds.includes(TARGET_SEAT_ID)) {
      const player = state.players.find((p) => p.id === TARGET_SEAT_ID)!
      const wantedKind = chooseCardKindForTemple(state)
      const wantedCardId = wantedKind && player.handCardIds.find((id) => id.endsWith(`_${wantedKind}`))
      action = wantedCardId ? { type: 'CHOOSE_CARD', playerId: TARGET_SEAT_ID, cardId: wantedCardId } : nextLegalAction(state, content)
    } else if (phase === 'decline' && state.status === 'active' && state.roundPhase === 'actions' && state.activePlayerId === TARGET_SEAT_ID) {
      const chosenCardId = state.chosenCardIdByPlayerId[TARGET_SEAT_ID]
      const cardKind = chosenCardId ? state.cards[chosenCardId]?.kind : undefined
      action = (cardKind ? templeMasteryAction(state, cardKind) : null) ?? { type: 'PASS_ACTIONS', playerId: TARGET_SEAT_ID }
    } else {
      action = nextLegalAction(state, content)
    }

    if (!action) throw new Error(`Setup ran out of legal actions before reaching a fresh ${phase} phase.`)
    state = applyOne(state, action, content)
  }

  const firstAction = nextLegalAction(state, content)
  if (!firstAction) throw new Error(`No legal first ${phase} action was found.`)
  return applyOne(state, firstAction, content)
}

/** A short, self-verifying fixture (loadFixtures.ts's buildFixture replays it and checks it reproduces itself) ending mid-`phase`, for provisionLiveRoom to open a real room from. */
export function buildHiddenInformationFixture(phase: 'selectCards' | 'decline'): ProductionGameFixture {
  const finalState = playToFreshPhase(phase)
  return buildFixture(
    `hidden-information-wire-${phase}`,
    { exportedAt: new Date(0).toISOString(), gameState: finalState },
    {
      settings: settingsForWireCheck(),
      createdBy: SEATS[0].user_id,
      roomCode: 'HIWTST',
      name: 'hidden-information wire self-test',
      userIdByPlayerId: Object.fromEntries(SEATS.map((seat) => [seat.id, seat.user_id])),
    },
  )
}

interface RawWireResponse {
  status: number
  /** Parsed JSON exactly as the server sent it — before gameApi.ts's toClientGameState collapses/truncates it, which is the one step this file exists to look behind. */
  body: unknown
}

/** Mirrors liveProject.ts's own `invoke()`, minus the toClientGameState collapse — see this file's own doc comment for why that collapse is exactly what has to be bypassed here. */
async function rawInvoke(client: SupabaseClient, name: 'get-game-state' | 'apply-action', body: Record<string, unknown>): Promise<RawWireResponse> {
  const { data, error } = await client.functions.invoke(name, { body })
  if (error) {
    const context = (error as { context?: Response }).context
    if (!context) return { status: 0, body: { ok: false, error: error.message } }
    try {
      return { status: context.status, body: await context.clone().json() }
    } catch {
      return { status: context.status, body: { ok: false, error: error.message } }
    }
  }
  return { status: 200, body: data }
}

/** The raw shape a get-game-state/apply-action success body's `state` has on the wire — RedactedGameState (../../engine/redaction.ts), read structurally rather than importing that type, since this file is deliberately looking at bytes a client never runs through it. */
interface WireStateLike {
  turn?: number
  chosenCardIdByPlayerId?: Record<string, { chosen: boolean; cardId?: string | null }>
  players?: { declineCardIds?: (string | null)[] }[]
  actionHistory?: { turn: number; action: { type: string; cardId?: string | null } }[]
}

/**
 * Every card id this response actually discloses through one of the three
 * places redactStateForPlayer (../../engine/redaction.ts) ever masks —
 * `chosenCardIdByPlayerId`, `players[].declineCardIds`, or a CHOOSE_CARD/
 * MOVE_TO_DECLINE `actionHistory` entry's own `cardId`. Deliberately not a
 * blind "does this string appear anywhere in the response" scan: a card id
 * is not itself secret (HIDDEN_INFORMATION_PLAN.md §2 — hands, supply and
 * discard are public, and `state.cards` lists every card that exists) —
 * only whether one of *these* fields ties a still-pending pick to it is. A
 * blind scan would find the acting seat's own chosen card sitting in plain
 * sight in its own (never-masked) hand/discard and misreport it as a leak.
 *
 * `actionHistory` is scoped to `entry.turn === state.turn`, exactly like
 * redactStateForPlayer's own masking condition — a card cycles through
 * hand/discard/supply many times over a real game, so an old, already-
 * resolved round's own CHOOSE_CARD/MOVE_TO_DECLINE entry can legitimately
 * name the very same cardId this phase is trying to keep secret, without
 * that being a leak of anything.
 */
function disclosedCardIds(response: RawWireResponse): Set<string> {
  const state = (response.body as { state?: WireStateLike }).state
  const disclosed = new Set<string>()
  if (!state) return disclosed
  for (const choice of Object.values(state.chosenCardIdByPlayerId ?? {})) {
    if (choice.chosen && choice.cardId) disclosed.add(choice.cardId)
  }
  for (const player of state.players ?? []) {
    for (const cardId of player.declineCardIds ?? []) {
      if (cardId) disclosed.add(cardId)
    }
  }
  for (const entry of state.actionHistory ?? []) {
    if (entry.turn !== state.turn) continue
    if ((entry.action.type === 'CHOOSE_CARD' || entry.action.type === 'MOVE_TO_DECLINE') && entry.action.cardId) {
      disclosed.add(entry.action.cardId)
    }
  }
  return disclosed
}

function assertOk(response: RawWireResponse, where: string): void {
  const body = response.body as { ok?: boolean; error?: string }
  if (body?.ok !== true) {
    throw new Error(`${where} failed (status ${response.status}): ${body?.error ?? JSON.stringify(response.body)}`)
  }
}

function assertNoLeak(response: RawWireResponse, secret: string, where: string): void {
  if (disclosedCardIds(response).has(secret)) {
    throw new Error(
      `${where} disclosed a still-secret cardId (${secret}) through chosenCardIdByPlayerId, declineCardIds or actionHistory — exactly the leak HIDDEN_INFORMATION_PLAN.md §8 phase 9 exists to catch:\n${JSON.stringify(response.body)}`,
    )
  }
}

/** The inverse of assertNoLeak, so a masking assertion earlier in the same run can't pass merely because the value never appears anywhere at all. */
function assertRevealed(response: RawWireResponse, secret: string, where: string): void {
  if (!disclosedCardIds(response).has(secret)) {
    throw new Error(`${where} should have revealed the now-resolved pick (${secret}) but didn't.`)
  }
}

function secretCardIdOf(action: Action): string {
  if (action.type !== 'CHOOSE_CARD' && action.type !== 'MOVE_TO_DECLINE') {
    throw new Error(`Expected a CHOOSE_CARD or MOVE_TO_DECLINE action, got ${action.type}.`)
  }
  return action.cardId
}

function assertThat(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * Subscribes exactly the way gameApi.ts's subscribeToPlayers/subscribeToGame/
 * subscribeToGameState do (same tables, same filters) — but through this
 * room's own throwaway client rather than the app's singleton, and forwarding
 * every raw payload instead of a typed refetch callback, so this file can
 * inspect literal wire bytes rather than trust the client library's own
 * shape for them.
 *
 * Returns `ready`, which resolves only once the channel actually reaches
 * `SUBSCRIBED` (or rejects with whatever status it ended up in instead).
 * The caller must await it before making the writes this check watches for:
 * `.subscribe()` returns before the server has registered this socket's
 * replication filter, so a write made right after calling it can complete —
 * and be missed — before the subscription is actually live. Without this,
 * that race surfaces as "no payload arrived at all", indistinguishable from
 * a real deployment problem (see this check's own error message below).
 */
function subscribeForLeakCheck(client: SupabaseClient, gameId: string, onPayload: (payload: unknown) => void): { ready: Promise<void>; stop: () => void } {
  let settle: (error: Error | null) => void
  const ready = new Promise<void>((resolve, reject) => {
    settle = (error) => (error ? reject(error) : resolve())
  })
  const channel = client
    .channel(`hidden-info-wire-check:${gameId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `game_id=eq.${gameId}` }, onPayload)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, onPayload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'game_state_meta', filter: `game_id=eq.${gameId}` }, onPayload)
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') settle(null)
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        settle(new Error(`Realtime channel for the leak-check watcher ended up ${status} instead of SUBSCRIBED${err ? `: ${err.message}` : ''}.`))
      }
    })
  return {
    ready,
    stop: () => {
      client.removeChannel(channel)
    },
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export interface HiddenInformationWireReport {
  phase: 'selectCards' | 'decline'
  gameId: string
  realtimeChecked: boolean
  /** Only set when realtimeChecked — absence of this being > 0 would mean the check proved nothing. */
  realtimePayloadsObserved?: number
}

/**
 * Opens a real three-seat room via provisionLiveRoom, plays it to a freshly-
 * opened `phase` with one seat committed, then:
 *
 *  1. Confirms neither still-pending seat's own get-game-state response
 *     carries the committed seat's pick.
 *  2. Confirms the *middle* seat's own apply-action response doesn't either
 *     (issue #478's write-path scenario — needs the third seat still
 *     pending, which is why this is three seats, not two).
 *  3. Has the last seat resolve the phase, and confirms its own response
 *     (and, once Realtime is included, nothing the middle seat's Realtime
 *     subscription saw along the way) ever revealed either pick early — then
 *     confirms the resolving response *does* reveal both, so an assertion
 *     that never fires isn't mistaken for one that never leaks.
 *
 * `includeRealtime: false` runs everything except the Realtime subscription,
 * for the in-process stack, which has no socket for one to connect to.
 */
export async function checkHiddenInformationWire(
  config: LiveProjectConfig,
  phase: 'selectCards' | 'decline',
  options: { includeRealtime: boolean },
  log: SmokeLogger = () => {},
): Promise<HiddenInformationWireReport> {
  const label = `hidden-information-wire/${phase}`
  const fixture = buildHiddenInformationFixture(phase)
  log(`start ${label}: provisioning a 3-seat room`)
  const room = await provisionLiveRoom(config, fixture)
  const capturedRealtime: unknown[] = []
  let stopRealtime = () => {}

  try {
    const roomFixture = fixtureForRoom(fixture, room)
    await replayFixtureThroughStack(room, roomFixture)

    let state = (await room.readGameState())!.state
    assertThat(state.status === 'active' && state.roundPhase === phase, `[${label}] expected the room mid-${phase}, got ${state.status}/${state.roundPhase}.`)
    assertThat(state.pendingPlayerIds.length === 2, `[${label}] expected two seats still pending after the first pick, got ${state.pendingPlayerIds.length}.`)

    const secret0 = secretCardIdOf(room.remapped.history.at(-1)!.action)

    // 1. Neither still-pending seat's own get-game-state call sees it.
    for (const seatId of state.pendingPlayerIds) {
      const userId = room.remapped.userIdForPlayer(seatId)
      const raw = await rawInvoke(room.clientFor(userId), 'get-game-state', { gameId: room.game.id })
      assertOk(raw, `[${label}] get-game-state as still-pending seat ${seatId}`)
      assertNoLeak(raw, secret0, `[${label}] get-game-state response to still-pending seat ${seatId}`)
    }

    // The watcher is whichever of the two still-pending seats nextLegalAction
    // does *not* pick next — it won't act again until it resolves the phase
    // in step 3, so subscribing it to Realtime now covers every write in
    // between without it ever having submitted anything itself yet.
    const watcherSeatId = state.pendingPlayerIds[1]
    const watcherUserId = room.remapped.userIdForPlayer(watcherSeatId)
    if (options.includeRealtime) {
      const subscription = subscribeForLeakCheck(room.clientFor(watcherUserId), room.game.id, (payload) => capturedRealtime.push(payload))
      stopRealtime = subscription.stop
      await subscription.ready
    }

    // 2. The middle seat's own apply-action response — issue #478's exact
    // scenario — must not hand back the still-pending watcher's pick either.
    const content = resolveGameContent(state)
    const midSeatId = state.pendingPlayerIds[0]
    const midAction = nextLegalAction(state, content)
    assertThat(midAction !== null, `[${label}] no legal action for the middle seat ${midSeatId}.`)
    const secret1 = secretCardIdOf(midAction)
    const midRaw = await rawInvoke(room.clientFor(room.remapped.userIdForPlayer(midSeatId)), 'apply-action', { gameId: room.game.id, action: midAction })
    assertOk(midRaw, `[${label}] the middle seat's (${midSeatId}) own action`)
    assertNoLeak(midRaw, secret0, `[${label}] apply-action response to the middle seat ${midSeatId}, before the phase resolved`)

    // 3. The watcher's own action resolves the phase.
    state = (await room.readGameState())!.state
    assertThat(
      state.pendingPlayerIds.length === 1 && state.pendingPlayerIds[0] === watcherSeatId,
      `[${label}] expected only the watcher seat (${watcherSeatId}) still pending, got ${JSON.stringify(state.pendingPlayerIds)}.`,
    )
    const lastAction = nextLegalAction(state, resolveGameContent(state))
    assertThat(lastAction !== null, `[${label}] no legal action for the last seat ${watcherSeatId}.`)
    const lastRaw = await rawInvoke(room.clientFor(watcherUserId), 'apply-action', { gameId: room.game.id, action: lastAction })
    assertOk(lastRaw, `[${label}] the last seat's (${watcherSeatId}) own action`)
    assertRevealed(lastRaw, secret0, `[${label}] apply-action response once the phase resolved`)
    assertRevealed(lastRaw, secret1, `[${label}] apply-action response once the phase resolved`)

    let realtimePayloadsObserved: number | undefined
    if (options.includeRealtime) {
      // 60s, not 20s (issue #555): this file's own two `.smoke.ts` entry
      // points run as separate vitest files, which vitest parallelizes by
      // default (see vitest.smoke.config.ts) — issue #513's own root-cause
      // analysis already documented that `productionSmoke.smoke.ts` can be
      // mid-replay of a 200+ action fixture at the same time this check is
      // waiting on a single game_state_meta row's Realtime delivery, and a
      // 20s window turned out tight enough for that shared load to blow
      // through it with zero payloads observed rather than a late one. The
      // leak-scan below is unaffected by a wider window: it only widens how
      // long a payload can arrive before this check gives up on ever seeing
      // one, not what counts as a leak once one does.
      await waitUntil(() => capturedRealtime.length >= 1, 60_000)
      assertThat(
        capturedRealtime.length > 0,
        // Deliberately does NOT blame the connection: `subscribeForLeakCheck`
        // resolves its `ready` promise only on SUBSCRIBED and rejects on
        // CHANNEL_ERROR/TIMED_OUT/CLOSED, and that promise is awaited before
        // any action is dispatched — so a subscription that never connected
        // threw earlier, with a different message. Reaching here means it
        // connected and then delivered nothing, which this check cannot tell
        // apart from a real delivery failure. The message used to say "likely
        // never connected" and cost a real investigation: run #42 on
        // 2026-09-13 was read as Realtime being broken on Preview, when a
        // concurrent deploy had in fact altered the supabase_realtime
        // publication underneath this subscription (smoke.yml and
        // deploy-supabase.yml now share a concurrency group so that cannot
        // recur).
        `[${label}] the watcher's subscription connected (SUBSCRIBED) but no Realtime payload arrived within 60s, so this check could not prove anything either way. Rule out a deploy or migration touching this project mid-run before treating it as a delivery fault.`,
      )
      for (const payload of capturedRealtime) {
        const text = JSON.stringify(payload)
        if (text.includes(secret0) || text.includes(secret1)) {
          throw new Error(`[${label}] a Realtime payload delivered to the watcher (who hadn't acted yet) carried a still-secret cardId:\n${text}`)
        }
      }
      realtimePayloadsObserved = capturedRealtime.length
    }

    log(
      `ok    ${label}: no secret crossed the wire before it resolved, revealed once it did` +
        (options.includeRealtime ? ` (${realtimePayloadsObserved} Realtime payload(s) inspected)` : ''),
    )
    return { phase, gameId: room.game.id, realtimeChecked: options.includeRealtime, realtimePayloadsObserved }
  } finally {
    stopRealtime()
    await room.teardown()
  }
}

/** Runs checkHiddenInformationWire for both simultaneous-phase windows §5.1 defines — selectCards and decline. */
export async function runHiddenInformationWireSuite(
  config: LiveProjectConfig,
  options: { includeRealtime: boolean },
  log: SmokeLogger = () => {},
): Promise<HiddenInformationWireReport[]> {
  const reports: HiddenInformationWireReport[] = []
  for (const phase of ['selectCards', 'decline'] as const) {
    reports.push(await checkHiddenInformationWire(config, phase, options, log))
  }
  return reports
}

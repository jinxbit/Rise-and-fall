// Who a `game_state` UPDATE newly owes a turn to — the decision behind both
// turn pings, notify-discord-turn and notify-web-push. Both functions keep
// their own delivery code (Discord webhook vs. Web Push) but share this, so
// the two can't drift apart again: they were separate hand-kept copies until
// todo.md #152, and notify-web-push's copy had already lost "Build alone"
// mode's `builderId` (pinging the turn-order tile placer instead of the one
// builder).
//
// Pure and dependency-free on purpose, so vitest can import it directly
// (src/test/__tests__/turnNotify.test.ts) and check it against the engine's
// own pendingActorIds() on every state of every checked-in production game,
// in the shape a Database Webhook actually delivers. It deliberately does not
// import the engine itself: the webhook payload's `state` is a rule-enforced
// game's *stored* row — gzipped, with only a few fields in plaintext
// (src/lib/gameStateCompression.ts) — so these functions must work from that
// partial view, not a full GameState. That partial view is exactly what the
// test exercises. Keep this in sync with src/engine/turnOrder.ts's
// pendingActorIds() and src/engine/boardSetup.ts's
// currentTilePlacerId/currentUnitPlacerId; the test fails if it isn't.

export interface BoardSetupState {
  tileTierQueue: unknown[]
  tilePlacerIndex: number
  unitsRemainingByPlayerId: Record<string, unknown[]>
  unitPlacerIndex: number
  /** "Build alone" map mode (GameSettings.soloBuildMap) — see src/engine/types.ts's BoardSetupState.builderId doc comment. */
  builderId?: string | null
}

export type RoundPhase = 'selectCards' | 'actions' | 'decline' | 'purchase'

/** The fields of GameState these functions read — all but `activePlayerId` are in a compressed row's plaintext. */
export interface GameState {
  status: 'lobby' | 'boardSetup' | 'active' | 'completed'
  turnOrder: string[]
  boardSetup: BoardSetupState | null
  activePlayerId: string | null
  pendingPlayerIds: string[]
  /** Round number — increments each time a round finishes (see src/engine/round.ts). */
  turn: number
  roundPhase: RoundPhase
}

/** A `game_state` row as a Database Webhook delivers it in `record`/`old_record`. */
export interface GameStateRow {
  game_id: string
  state: GameState
  active_player_id: string | null
}

function currentTilePlacerId(state: GameState): string | null {
  const boardSetup = state.boardSetup
  if (state.status !== 'boardSetup' || !boardSetup || boardSetup.tileTierQueue.length === 0) return null
  if (boardSetup.builderId) return boardSetup.builderId
  if (state.turnOrder.length === 0) return null
  return state.turnOrder[boardSetup.tilePlacerIndex % state.turnOrder.length]
}

function currentUnitPlacerId(state: GameState): string | null {
  const boardSetup = state.boardSetup
  if (state.status !== 'boardSetup' || !boardSetup || boardSetup.tileTierQueue.length > 0) return null
  if (Object.keys(boardSetup.unitsRemainingByPlayerId).length === 0) return null
  if (state.turnOrder.length === 0) return null
  return state.turnOrder[boardSetup.unitPlacerIndex % state.turnOrder.length]
}

export function pendingActorIds(state: GameState): string[] {
  if (state.status === 'boardSetup') {
    const id = currentTilePlacerId(state) ?? currentUnitPlacerId(state)
    return id ? [id] : []
  }
  if (state.status === 'active') {
    if (state.roundPhase === 'selectCards' || state.roundPhase === 'decline' || state.roundPhase === 'purchase') {
      return state.pendingPlayerIds
    }
    return state.activePlayerId ? [state.activePlayerId] : []
  }
  return []
}

// The acting player during the turn-order `actions` phase, read from the
// row's `active_player_id` column rather than `state.activePlayerId`. A
// rule-enforced game stores `state` gzipped under `__gz` with only
// status/roundPhase/turn/pendingPlayerIds/turnOrder/boardSetup duplicated
// in plaintext (src/lib/gameStateCompression.ts) — `activePlayerId` isn't
// one of them, so reading it off `state` saw `undefined` and silently sent
// no ping for any action-phase turn in an enforced game, while the other
// phases still pinged: the "intermittent" notifications (todo.md #150).
// Both write paths (gameApi.ts's writeGameState and gameEnforcement.ts's
// writeGameStateCAS) keep the column in sync, so it's right for either
// encoding.
export function rowState(row: GameStateRow): GameState {
  return { ...row.state, activePlayerId: row.active_player_id ?? row.state.activePlayerId ?? null }
}

/** Players owed a turn after this write who weren't before it — the ones to ping. */
export function newlyPendingActorIds(oldRow: GameStateRow, newRow: GameStateRow): string[] {
  const wasPending = new Set(pendingActorIds(rowState(oldRow)))
  return pendingActorIds(rowState(newRow)).filter((id) => !wasPending.has(id))
}

// A game_state UPDATE that moves the state to `completed` is the "game
// finished" event. `status` is one of the fields gameStateCompression.ts
// duplicates in plaintext alongside a rule-enforced game's gzipped state, so
// this reads correctly on both write paths without decompressing anything.
export function justFinished(oldState: GameState, newState: GameState): boolean {
  return oldState.status !== 'completed' && newState.status === 'completed'
}

const ROUND_PHASE_LABEL: Record<RoundPhase, string> = {
  selectCards: 'select a card',
  actions: 'take your action',
  decline: 'decline a card',
  purchase: 'make a purchase',
}

/** Human-readable phase for the ping text — mirrors src/lib/discordNotify.ts's. */
export function phaseLabel(state: GameState): string {
  if (state.status === 'boardSetup') return currentTilePlacerId(state) ? 'place a tile' : 'place a unit'
  return ROUND_PHASE_LABEL[state.roundPhase]
}

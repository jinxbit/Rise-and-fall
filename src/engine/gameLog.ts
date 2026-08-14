import type { Action, LoggedAction } from './actions'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import type { AchievementContent } from './achievementContent'
import { applyAction } from './applyAction'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { UNIT_KINDS, cardIdFor, findCardZone } from './cards'
import { describeResourceDelta } from './resources'
import { EMPTY_TALE_CONTENT } from './taleContent'
import type { TaleContent } from './taleContent'
import type { GameEvent, GameState } from './types'
import { EMPTY_UNIT_CONTENT } from './unitContent'
import type { UnitContent } from './unitContent'

/** One derived log line, not yet stamped with an id/turn — see describeStep below. */
interface DraftEvent {
  playerId: string | null
  message: string
}

/**
 * Renders the primary, one-line narration for whatever action was just
 * dispatched — the direct equivalent of what each apply* handler used to
 * write straight into GameState.log. Everything it needs (card names, tile
 * terrain, resource deltas, purchase cost) is either already on the
 * action's own payload or cheaply recovered by diffing `before`/`after`,
 * the same before/after-snapshot technique ./turnReview.ts already uses for
 * its per-unit event extraction.
 */
function describePrimaryAction(action: Action, before: GameState, after: GameState, unitContent: UnitContent): DraftEvent[] {
  switch (action.type) {
    case 'PLACE_TILE': {
      // A placed tile can land on an already-tracked hex (e.g. converting a
      // seeded water tile to its real terrain) as easily as a brand-new
      // one, so the signal is a terrain *change* at a key, not a new key.
      const changedKey = Object.keys(after.board.tiles).find((key) => before.board.tiles[key]?.terrain !== after.board.tiles[key].terrain)
      const terrain = changedKey ? after.board.tiles[changedKey].terrain : 'unknown'
      return [{ playerId: action.playerId, message: `Player ${action.playerId} placed a ${terrain} tile` }]
    }
    case 'PLACE_UNIT':
      return [{ playerId: action.playerId, message: `Player ${action.playerId} placed a starting ${action.unitKind}` }]
    case 'CHOOSE_CARD': {
      const name = after.cards[action.cardId]?.name ?? action.cardId
      return [{ playerId: action.playerId, message: `Player ${action.playerId} chose to play ${name}` }]
    }
    case 'RESOLVE_UNIT_ACTION': {
      const cardId = before.chosenCardIdByPlayerId[action.playerId]
      const card = cardId ? before.cards[cardId] : undefined
      const actionNames: string[] = []
      for (const assignment of action.unitActions) {
        const def = card ? unitContent.actionsByKind[card.kind]?.find((a) => a.id === assignment.actionId) : undefined
        const name = def?.name ?? assignment.actionId
        if (!actionNames.includes(name)) actionNames.push(name)
      }
      const resourcesBefore = before.players.find((p) => p.id === action.playerId)?.resources
      const resourcesAfter = after.players.find((p) => p.id === action.playerId)?.resources
      const delta = resourcesBefore && resourcesAfter ? describeResourceDelta(resourcesBefore, resourcesAfter) : ''
      const kindLabel = card?.kind ?? 'unit'
      const events: DraftEvent[] = [
        { playerId: action.playerId, message: `Player ${action.playerId}'s ${kindLabel} resolved ${actionNames.join(', ')}${delta}` },
      ]
      // Skipped once the round itself has also turned over in this same
      // dispatch (e.g. the last player's last unit closes out the round):
      // by then `after.pendingPlayerIds` has already been reset for the
      // *next* round's select-cards phase, which can coincidentally put
      // this same player back at the front — and the "Round N begins" line
      // below already implies their turn ended, so it'd be redundant
      // anyway.
      if (after.turn === before.turn && before.pendingPlayerIds[0] === action.playerId && after.pendingPlayerIds[0] !== action.playerId) {
        events.push({ playerId: action.playerId, message: `Player ${action.playerId}'s ${kindLabel} finished acting — turn ends` })
      }
      return events
    }
    case 'PASS_ACTIONS':
      return [{ playerId: action.playerId, message: `Player ${action.playerId} passed on resolving further actions` }]
    case 'MOVE_TO_DECLINE':
      return [{ playerId: action.playerId, message: `Player ${action.playerId} moved a card into decline` }]
    case 'PURCHASE_CARD': {
      const goldBefore = before.players.find((p) => p.id === action.playerId)?.resources.gold ?? 0
      const goldAfter = after.players.find((p) => p.id === action.playerId)?.resources.gold ?? 0
      const cost = goldBefore - goldAfter
      return [{ playerId: action.playerId, message: `Player ${action.playerId} purchased a card back from decline for ${cost} gold` }]
    }
    case 'PASS_PURCHASE':
      return [{ playerId: action.playerId, message: `Player ${action.playerId} passed on purchasing` }]
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown action: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * Everything that used to be logged as a side effect cascading out of a
 * single dispatched action (achievement claims, eliminations, phase
 * transitions, card-zone syncs, game end) — derived generically by diffing
 * `before`/`after`, rather than replicated per action type, since the same
 * cascade (e.g. a round ending) can be triggered from several different
 * action types once every nested phase-transition function has run.
 */
function describeCascade(before: GameState, after: GameState, achievementContent: AchievementContent): DraftEvent[] {
  const events: DraftEvent[] = []

  for (const [achievementId, claimantId] of Object.entries(after.claimedByAchievementId)) {
    if (before.claimedByAchievementId[achievementId]) continue
    const kind = achievementContent.unitKindByAchievementId[achievementId] ?? achievementId
    events.push({ playerId: claimantId, message: `Player ${claimantId} claimed the ${kind} mastery achievement` })
  }

  for (const player of after.players) {
    const beforePlayer = before.players.find((p) => p.id === player.id)
    if (beforePlayer && !beforePlayer.eliminated && player.eliminated) {
      events.push({ playerId: player.id, message: `Player ${player.id} was eliminated — no card available to play` })
    }
  }

  if (before.boardSetup && before.boardSetup.tileTierQueue.length > 0 && after.boardSetup && after.boardSetup.tileTierQueue.length === 0) {
    events.push({ playerId: null, message: 'All tiles placed — starting-unit placement begins' })
  }

  for (const player of after.players) {
    const beforePlayer = before.players.find((p) => p.id === player.id)
    if (!beforePlayer) continue
    for (const kind of UNIT_KINDS) {
      const cardId = cardIdFor(player.id, kind)
      if (!after.cards[cardId]) continue
      const beforeZone = findCardZone(beforePlayer, cardId)
      const afterZone = findCardZone(player, cardId)
      if (beforeZone === afterZone) continue
      if (afterZone === 'supply') {
        events.push({ playerId: null, message: `${player.displayName}'s ${kind} card returned to supply (no units left on the board)` })
      } else if (beforeZone === 'supply' && afterZone === 'hand') {
        events.push({ playerId: null, message: `${player.displayName}'s ${kind} card entered their hand (first unit placed)` })
      }
    }
  }

  if (after.turn !== before.turn) {
    // (The "discard recycled into hand" system note isn't derived here: by
    // the time this whole action's cascade finishes, whether a mid-cascade
    // discard->hand recycle happened is no longer reliably distinguishable
    // from "this player simply had an empty discard the whole time" using
    // only the before/after snapshot pair — the intermediate state that
    // would disambiguate it isn't kept around. Low-value line to lose:
    // the round transition itself is still reported below regardless.)
    if (after.turnOrder.length > 0 && after.turnOrder[0] !== before.turnOrder[0]) {
      events.push({ playerId: after.turnOrder[0], message: `Player ${after.turnOrder[0]} becomes the first player` })
    }
    events.push({ playerId: null, message: `Round ${after.turn} begins` })
  }

  if (before.status !== 'completed' && after.status === 'completed') {
    const totalAchievementsClaimed = Object.keys(after.claimedByAchievementId).length
    events.push({
      playerId: null,
      message: `Game ends — ${totalAchievementsClaimed} achievements claimed. Winner(s): ${after.winnerPlayerIds.join(', ') || 'none'}`,
    })
  }

  return events
}

/**
 * Continues narrating on top of a `state` already derived from some prefix
 * of a game's actionHistory (e.g. a previous buildGameLog/buildGameLogFrom/
 * extendGameLog call's own result) — the same per-action replay+diff
 * buildGameLog does, just factored out so a caller that's already holding
 * that intermediate state doesn't have to replay all the way from genesis
 * again merely to narrate a handful of new actions appended on top (see
 * GamePage.tsx's incrementally-extended gameLog cache, which is what makes
 * the log affordable to keep live-updating across a long game instead of
 * re-deriving the entire history on every single action). `nextEventId`
 * seeds the running `evt_N` counter so ids stay unique/increasing across a
 * caller's earlier and newly-appended halves.
 */
export function extendGameLog(
  state: GameState,
  actions: LoggedAction[],
  nextEventId: number,
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = []
  let id = nextEventId

  for (const logged of actions) {
    const before = state
    const result = applyAction(before, logged.action, unitContent, achievementContent, boardGenerationContent, taleContent)
    if (!result.ok) break // a validly-logged action should never fail to reapply; bail defensively rather than throw mid-log
    const after = result.state

    const drafts = [
      ...describePrimaryAction(logged.action, before, after, unitContent),
      ...describeCascade(before, after, achievementContent),
    ]
    for (const draft of drafts) {
      events.push({ id: `evt_${id++}`, turn: after.turn, playerId: draft.playerId, message: draft.message, timestamp: logged.timestamp })
    }

    state = after
  }

  return { state, events }
}

/**
 * Rebuilds the game's narration log purely from `actionHistory` — nothing
 * about it is stored on GameState (see GameEvent's doc comment in
 * ./types.ts). Replays each logged action from `genesis` exactly like
 * ./replay.ts's replayActions (via extendGameLog above), deriving one or
 * more display lines per step from the before/after state pair rather than
 * threading a log array through every mutator. `id`/`turn` are assigned
 * fresh on every call (they only need to be unique within this one derived
 * list, e.g. for a React key); `timestamp` comes from the LoggedAction
 * itself, the real moment that action was dispatched. Also returns the
 * final replayed `state`, for a caller that wants to keep extending this
 * same log later (see extendGameLog) without redoing this full replay.
 */
export function buildGameLogFrom(
  genesis: GameState,
  actionHistory: LoggedAction[],
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): { state: GameState; events: GameEvent[] } {
  const initial: GameEvent[] = []
  if (genesis.status === 'boardSetup') {
    initial.push({ id: 'evt_1', turn: genesis.turn, playerId: null, message: 'Board setup begins', timestamp: '' })
  }

  const { state, events } = extendGameLog(
    genesis,
    actionHistory,
    initial.length + 1,
    unitContent,
    achievementContent,
    boardGenerationContent,
    taleContent,
  )
  return { state, events: [...initial, ...events] }
}

/** Same as buildGameLogFrom, but for a caller that only wants the log itself (e.g. every existing caller before GamePage.tsx started caching its own copy of `state` too — see buildGameLogFrom's doc comment). */
export function buildGameLog(
  genesis: GameState,
  actionHistory: LoggedAction[],
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): GameEvent[] {
  return buildGameLogFrom(genesis, actionHistory, unitContent, achievementContent, boardGenerationContent, taleContent).events
}

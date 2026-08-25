import type { Action, LoggedAction } from './actions'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import type { AchievementContent } from './achievementContent'
import { applyAction } from './applyAction'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { EMPTY_TALE_CONTENT } from './taleContent'
import type { TaleContent } from './taleContent'
import type { Coordinate, GameState, Resources, RoundPhase } from './types'
import { applyUnitActionEffect } from './unitActions'
import type { UnitActionEffect, UnitContent } from './unitContent'

/**
 * "What happened since I last acted" — reviewed on demand (see
 * RoundView.tsx's history toggle) rather than stored: every event here is
 * re-derived from `GameState.actionHistory`, the same event-sourcing this
 * engine already relies on for Undo (./replay.ts) and multiplayer sync.
 */
export type UnitReviewEventType = 'moved' | 'created' | 'produced' | 'income' | 'traded' | 'converted'

export interface UnitReviewEvent {
  unitId: string
  playerId: string
  type: UnitReviewEventType
  /** Set for 'moved': the hex it moved from. */
  from?: Coordinate
  /** The unit's hex after this event (its current one, if this is the last event for it). */
  to?: Coordinate
  /** Set for 'produced'/'income'/'traded': the resource(s) that changed and by how much, e.g. `{ gold: 5 }` or `{ gold: -5, wood: 1 }` for a Merchant's Buy Wood. */
  resourceDelta?: Partial<Resources>
}

export interface TurnReview {
  /** In the order they happened; a single unit can appear more than once (e.g. moved, then produced). */
  events: UnitReviewEvent[]
  /** Net resource change per player across the whole reviewed window. */
  resourceDeltaByPlayerId: Record<string, Resources>
}

/**
 * The index in `actionHistory` right after the last action `playerId`
 * themselves took — i.e. where "since my last turn" begins. 0 (the whole
 * history) if they haven't acted yet.
 */
export function findReviewWindowStart(actionHistory: LoggedAction[], playerId: string): number {
  for (let i = actionHistory.length - 1; i >= 0; i--) {
    if (actionHistory[i].action.playerId === playerId) return i + 1
  }
  return 0
}

/**
 * The three step "shapes" issue #322 wants "Show history" to walk through
 * (each a `RoundPhase`, see types.ts, except `purchase` — merged into
 * `decline`'s stop): `selectCards` and `decline`/`purchase` are simultaneous
 * (round.ts) — nobody is "active" and the map shows no per-player action
 * resolution — so every action in one of those round phases collapses into
 * a single stop, aggregated across all players. `actions` is turn-order and
 * sequential, so it keeps one stop per acting player. `boardSetup` (the
 * PLACE_TILE/PLACE_UNIT phase before round 1) isn't part of that request,
 * so it keeps its original per-player-change granularity.
 */
export type ReviewPhaseGroup = 'boardSetup' | 'selectCards' | 'actions' | 'declinePurchase'

/**
 * Maps a logged action to the `ReviewPhaseGroup` it always belongs to —
 * every action type but CONCEDE is only ever submitted during one specific
 * round phase (see actions.ts's file-level comment). CONCEDE is the one
 * exception (submittable "at any point"), so it has no group of its own:
 * it simply inherits whichever group precedes it.
 */
function reviewPhaseGroupFor(action: Action, precedingGroup: ReviewPhaseGroup): ReviewPhaseGroup {
  switch (action.type) {
    case 'PLACE_TILE':
    case 'PLACE_UNIT':
      return 'boardSetup'
    case 'CHOOSE_CARD':
      return 'selectCards'
    case 'RESOLVE_UNIT_ACTION':
    case 'PASS_ACTIONS':
      return 'actions'
    case 'MOVE_TO_DECLINE':
    case 'PURCHASE_CARD':
    case 'PASS_PURCHASE':
      return 'declinePurchase'
    case 'CONCEDE':
      return precedingGroup
  }
}

/**
 * Splits `actionHistory` from `windowStart` to its end into history-review
 * stops, for GamePage's "Show history" turn-by-turn stepping (issue #261,
 * refined by #322 to be phase-aware instead of splitting on every change of
 * acting player): a boundary is inserted wherever the `ReviewPhaseGroup`
 * changes, and additionally wherever the acting player changes within the
 * `boardSetup`/`actions` groups (see `ReviewPhaseGroup`'s doc comment for
 * why `selectCards`/`declinePurchase` don't also split on actor). Always
 * starts with `windowStart` and ends with `actionHistory.length`; indices
 * are absolute positions into `actionHistory` (also valid `reviewIndex`
 * values for GamePage's replay cache, since a stop is just a particular
 * point in the action list). Pass `windowStart: 0` to cover the whole game.
 * A one-element result means nothing happened in `[windowStart, end]`.
 */
export function findTurnStops(actionHistory: LoggedAction[], windowStart: number): number[] {
  const stops = [windowStart]
  if (windowStart >= actionHistory.length) return stops

  let group = reviewPhaseGroupFor(actionHistory[windowStart].action, windowStart > 0 ? reviewPhaseGroupFor(actionHistory[windowStart - 1].action, 'boardSetup') : 'boardSetup')
  let playerId = actionHistory[windowStart].action.playerId

  for (let i = windowStart + 1; i <= actionHistory.length; i++) {
    if (i === actionHistory.length) {
      stops.push(i)
      break
    }
    const nextGroup = reviewPhaseGroupFor(actionHistory[i].action, group)
    const nextPlayerId = actionHistory[i].action.playerId
    const splitsWithinGroup = nextGroup === 'boardSetup' || nextGroup === 'actions'
    if (nextGroup !== group || (splitsWithinGroup && nextPlayerId !== playerId)) stops.push(i)
    group = nextGroup
    playerId = nextPlayerId
  }
  return stops
}

/**
 * The `ReviewPhaseGroup` governing a history-review stop ending at `stopEnd`
 * (one of `findTurnStops`'s return values, `stopEnd > 0`) — lets GamePage's
 * "Show history" banner (issue #324) tell a simultaneous phase
 * (`selectCards`/`declinePurchase`, where nobody is "next" to play) from a
 * turn-order one, so it can show the phase name instead of a misleading
 * player. Walks from the start of `actionHistory` the same way
 * `findTurnStops` does, since every action's group depends on the one
 * before it (see `reviewPhaseGroupFor`'s CONCEDE case).
 */
export function reviewPhaseGroupAt(actionHistory: LoggedAction[], stopEnd: number): ReviewPhaseGroup {
  let group: ReviewPhaseGroup = 'boardSetup'
  for (let i = 0; i < stopEnd; i++) {
    group = reviewPhaseGroupFor(actionHistory[i].action, group)
  }
  return group
}

/**
 * Whether RoundView's card-choice recap overlay (CardChoiceHistoryPanel)
 * should be shown for a history-review stop at `roundPhase` (issue #326
 * follow-up to #314/#316) — never for `selectCards`/`decline` themselves (a
 * partial "n of N chosen" picture while eligible players are still
 * mid-pick), and for `actions`/`purchase` only at the FIRST review stop that
 * shows the phase's completed picks, not every stop after it.
 *
 * In turn-step mode, `actions` gets one stop per acting player
 * (`findTurnStops`'s `splitsWithinGroup`), and `selectCards` collapses to a
 * single stop that — because `applyChooseCard` flips `roundPhase` straight
 * to `'actions'` the instant the last player picks (see applyAction.ts) —
 * already replays as `roundPhase: 'actions'` itself; there's no reachable
 * stop where it's still `'selectCards'` with every pick in. So "is this the
 * first stop showing `'actions'`/`'purchase'`" can't be read off *this*
 * stop's own action types (a CHOOSE_CARD-classified stop can itself already
 * be the `'actions'`-phase state) — it has to compare against the roundPhase
 * the PREVIOUS turn-stop actually replayed to. `previousStopRoundPhase` is
 * that comparison point, supplied by the caller (GamePage's replay cache
 * already holds every stop's state) — `null` when there is no previous stop
 * (genesis, or reviewing the very first stop in the window), which compares
 * unequal to any real `RoundPhase` and so still shows. Action-by-action
 * ("Review history") mode has no multi-stop group at all, so
 * `historyStepMode !== 'turn'` always passes once the phase itself is right.
 */
export function shouldShowCardChoiceRecap(roundPhase: RoundPhase, previousStopRoundPhase: RoundPhase | null, historyStepMode: 'action' | 'turn'): boolean {
  if (roundPhase !== 'actions' && roundPhase !== 'purchase') return false
  if (historyStepMode !== 'turn') return true
  return previousStopRoundPhase !== roundPhase
}

function diffResources(before: Resources, after: Resources): Partial<Resources> {
  const delta: Partial<Resources> = {}
  for (const key of ['gold', 'wood', 'stone'] as const) {
    const amount = after[key] - before[key]
    if (amount !== 0) delta[key] = amount
  }
  return delta
}

const REVIEW_EVENT_TYPE_BY_ACTION_TYPE: Partial<Record<UnitActionEffect['actionType'], UnitReviewEventType>> = {
  produce: 'produced',
  'trade-resource': 'traded',
  income: 'income',
  trade: 'income', // Ship's Trade action is a pure gold gain, same as Temple/City/Merchant's Income actions.
}

/**
 * Diffs every unit across one granular sub-step (one RESOLVE_UNIT_ACTION
 * assignment's effect, applied via applyUnitActionEffect restricted to just
 * `actingUnitId`) and appends whatever events actually happened. Scans
 * *all* units, not just the acting one — create/transform's effect lands on
 * a brand-new unit id, and convert's lands on a different, already-existing
 * unit (the target), so the acting unit itself is often unchanged while
 * some other unit is exactly what needs an event. The resource delta (for
 * produce/income/trade/trade-resource) is the one exception: that always
 * belongs to the acting unit, since it's the acting player's resources that
 * moved, not the target's.
 */
function recordAssignmentEvents(
  before: GameState,
  after: GameState,
  actingUnitId: string,
  actingPlayerId: string,
  actionType: UnitActionEffect['actionType'],
  events: UnitReviewEvent[],
): void {
  const beforeById = new Map(before.units.map((u) => [u.id, u]))
  const afterById = new Map(after.units.map((u) => [u.id, u]))

  // A destroySelf transform to an adjacent hex (e.g. Nomad -> Ship, Ship ->
  // Nomad/Merchant, Merchant -> Ship) destroys the acting unit and creates a
  // brand-new unit id at the target hex, so the loop below only ever sees
  // the new id as 'created' — nothing links it back to where it came from.
  // Surface that link as an extra 'moved' event (same as a plain move) so
  // it renders as an arrow rather than vanishing/appearing with no trail.
  // Same-hex transforms (e.g. Nomad -> City, targetHex.location 'self')
  // don't qualify since there's no coordinate change to draw.
  const actingUnitBefore = beforeById.get(actingUnitId)
  const transformRelocated = actionType === 'transform' && !!actingUnitBefore && !afterById.has(actingUnitId)

  for (const [id, afterUnit] of afterById) {
    const beforeUnit = beforeById.get(id)
    if (!beforeUnit) {
      events.push({ unitId: id, playerId: afterUnit.ownerId, type: 'created', to: afterUnit.coord })
      if (
        transformRelocated &&
        afterUnit.ownerId === actingUnitBefore!.ownerId &&
        (afterUnit.coord.q !== actingUnitBefore!.coord.q || afterUnit.coord.r !== actingUnitBefore!.coord.r)
      ) {
        events.push({ unitId: id, playerId: afterUnit.ownerId, type: 'moved', from: actingUnitBefore!.coord, to: afterUnit.coord })
      }
      continue
    }
    if (beforeUnit.coord.q !== afterUnit.coord.q || beforeUnit.coord.r !== afterUnit.coord.r) {
      events.push({ unitId: id, playerId: afterUnit.ownerId, type: 'moved', from: beforeUnit.coord, to: afterUnit.coord })
    }
    if (beforeUnit.ownerId !== afterUnit.ownerId || beforeUnit.kind !== afterUnit.kind) {
      events.push({ unitId: id, playerId: afterUnit.ownerId, type: 'converted', to: afterUnit.coord })
    }
  }

  const reviewType = REVIEW_EVENT_TYPE_BY_ACTION_TYPE[actionType]
  if (!reviewType) return
  const beforePlayer = before.players.find((p) => p.id === actingPlayerId)
  const afterPlayer = after.players.find((p) => p.id === actingPlayerId)
  if (!beforePlayer || !afterPlayer) return
  const resourceDelta = diffResources(beforePlayer.resources, afterPlayer.resources)
  if (Object.keys(resourceDelta).length === 0) return
  const actingUnit = afterById.get(actingUnitId) ?? beforeById.get(actingUnitId)
  events.push({ unitId: actingUnitId, playerId: actingPlayerId, type: reviewType, to: actingUnit?.coord, resourceDelta })
}

/**
 * Rebuilds "what happened" across `actionsInWindow`, starting from
 * `stateAtWindowStart` (the real state right before the first of those
 * actions — see findReviewWindowStart). Two passes per RESOLVE_UNIT_ACTION:
 * the official one (applyAction, whose result is what every later action in
 * the window actually builds on — achievement claims, log entries,
 * resolvedUnitIdsThisTurn, all exactly as they really happened) and a
 * parallel per-assignment one (applyUnitActionEffect, one call per unit)
 * purely to see what each individual unit did — the official dispatch
 * only returns the *combined* before/after, which isn't enough to tell
 * two different units' effects apart within the same submission.
 */
export function buildTurnReview(
  stateAtWindowStart: GameState,
  actionsInWindow: LoggedAction[],
  unitContent: UnitContent,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): TurnReview {
  const events: UnitReviewEvent[] = []
  let state = stateAtWindowStart

  for (const { action } of actionsInWindow) {
    const beforeState = state

    if (action.type === 'RESOLVE_UNIT_ACTION') {
      const cardId = beforeState.chosenCardIdByPlayerId[action.playerId]
      const card = cardId ? beforeState.cards[cardId] : undefined
      if (card) {
        const actionsForKind = unitContent.actionsByKind[card.kind] ?? []
        let subState = beforeState
        for (const assignment of action.unitActions) {
          const unitAction = actionsForKind.find((a) => a.id === assignment.actionId)
          if (!unitAction) continue
          const targets = assignment.target ? { [assignment.unitId]: assignment.target } : {}
          const beforeSub = subState
          subState = applyUnitActionEffect(subState, action.playerId, card.kind, unitAction, targets, unitContent, [assignment.unitId])
          recordAssignmentEvents(beforeSub, subState, assignment.unitId, action.playerId, unitAction.effect.actionType, events)
        }
      }
    }

    // trustedReplay: `action` comes straight from actionHistory, already
    // validated once when originally submitted (see applyAction's own doc
    // comment) — reviewing it again doesn't need PLACE_TILE's expensive
    // room-search recheck.
    const result = applyAction(state, action, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!result.ok) break // a validly-logged action should never fail to reapply; bail defensively rather than throw mid-review
    const afterState = result.state

    if (action.type !== 'RESOLVE_UNIT_ACTION') {
      // Covers PLACE_UNIT — the only other action type that can add a unit.
      const beforeIds = new Set(beforeState.units.map((u) => u.id))
      for (const unit of afterState.units) {
        if (!beforeIds.has(unit.id)) events.push({ unitId: unit.id, playerId: unit.ownerId, type: 'created', to: unit.coord })
      }
    }

    state = afterState
  }

  const resourceDeltaByPlayerId: Record<string, Resources> = {}
  for (const startPlayer of stateAtWindowStart.players) {
    const endPlayer = state.players.find((p) => p.id === startPlayer.id)
    if (!endPlayer) continue
    resourceDeltaByPlayerId[startPlayer.id] = {
      gold: endPlayer.resources.gold - startPlayer.resources.gold,
      wood: endPlayer.resources.wood - startPlayer.resources.wood,
      stone: endPlayer.resources.stone - startPlayer.resources.stone,
    }
  }

  return { events, resourceDeltaByPlayerId }
}

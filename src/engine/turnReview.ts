import type { LoggedAction } from './actions'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import type { AchievementContent } from './achievementContent'
import { applyAction } from './applyAction'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { EMPTY_TALE_CONTENT } from './taleContent'
import type { TaleContent } from './taleContent'
import type { Coordinate, GameState, Resources } from './types'
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
 * Splits `actionHistory` from `windowStart` to its end into per-player-turn
 * segments, for GamePage's "Show history" turn-by-turn stepping (issue
 * #261) — each boundary is where the acting player changes. Always starts
 * with `windowStart` and ends with `actionHistory.length`; indices are
 * absolute positions into `actionHistory` (also valid `reviewIndex` values
 * for GamePage's replay cache, since a turn boundary is just a particular
 * point in the action list). Pass `windowStart: 0` to cover the whole game.
 * A one-element result means nothing happened in `[windowStart, end]`.
 */
export function findTurnStops(actionHistory: LoggedAction[], windowStart: number): number[] {
  const stops = [windowStart]
  for (let i = windowStart + 1; i <= actionHistory.length; i++) {
    if (i === actionHistory.length || actionHistory[i].action.playerId !== actionHistory[i - 1].action.playerId) stops.push(i)
  }
  return stops
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

  for (const [id, afterUnit] of afterById) {
    const beforeUnit = beforeById.get(id)
    if (!beforeUnit) {
      events.push({ unitId: id, playerId: afterUnit.ownerId, type: 'created', to: afterUnit.coord })
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

import type { LoggedAction } from './actions'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import type { AchievementContent } from './achievementContent'
import { applyAction } from './applyAction'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { calculatePurchaseCost } from './purchaseCost'
import { calculateTerrainControlVPByKind } from './scoring'
import { EMPTY_TALE_CONTENT } from './taleContent'
import type { TaleContent } from './taleContent'
import type { GameState } from './types'
import { applyUnitActionEffect } from './unitActions'
import { EMPTY_UNIT_CONTENT } from './unitContent'
import type { UnitActionEffect, UnitContent } from './unitContent'
import { calculateBoardCountDetail } from './victoryPoints'

/**
 * Cumulative gold gained per (player, unit kind) across the whole game
 * (issue #335's "gold produced by the unit over the entire game"), not just
 * whatever's currently in the bank — replays `actionHistory` from `genesis`
 * the same way calculateScoreHistory does, since GameState itself only ever
 * tracks a player's *current* gold, not a running production total.
 *
 * Mirrors buildTurnReview's (./turnReview.ts) two-pass approach for
 * RESOLVE_UNIT_ACTION: the official applyAction call is what every later
 * action in the replay actually builds on, while a parallel per-assignment
 * pass (applyUnitActionEffect, one call per unit) is what tells two
 * different units' gold gains apart within the same submission. Unlike
 * buildTurnReview's events (which only cover the actionType subset it maps
 * to a UnitReviewEventType — notably missing region-unit-count-income),
 * this attributes ANY positive gold delta an assignment produces, so every
 * gold-producing effect (income, produce, trade, region-unit-count-income,
 * and a trade-resource sell) is counted. A trade-resource buy (spends gold)
 * simply produces no positive delta to attribute. All assignments in one
 * RESOLVE_UNIT_ACTION are attributed to the chosen card's kind, same
 * convention as buildTurnReview — a companion piece's own gold gain is
 * folded into the card's kind rather than the companion's, matching how the
 * engine's own turn-review already treats it.
 */
export function calculateGoldProducedByKind(
  genesis: GameState,
  actionHistory: LoggedAction[],
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): Record<string, Record<string, number>> {
  const goldByPlayerAndKind: Record<string, Record<string, number>> = {}
  let state = genesis

  for (const { action } of actionHistory) {
    if (action.type === 'RESOLVE_UNIT_ACTION') {
      const cardId = state.chosenCardIdByPlayerId[action.playerId]
      const card = cardId ? state.cards[cardId] : undefined
      if (card) {
        const actionsForKind = unitContent.actionsByKind[card.kind] ?? []
        let subState = state
        for (const assignment of action.unitActions) {
          const unitAction = actionsForKind.find((a) => a.id === assignment.actionId)
          if (!unitAction) continue
          const targets = assignment.target ? { [assignment.unitId]: assignment.target } : {}
          const goldBefore = subState.players.find((p) => p.id === action.playerId)?.resources.gold ?? 0
          subState = applyUnitActionEffect(subState, action.playerId, card.kind, unitAction, targets, unitContent, [assignment.unitId])
          const goldAfter = subState.players.find((p) => p.id === action.playerId)?.resources.gold ?? 0

          const delta = goldAfter - goldBefore
          if (delta > 0) {
            const byKind = goldByPlayerAndKind[action.playerId] ?? {}
            goldByPlayerAndKind[action.playerId] = byKind
            byKind[card.kind] = (byKind[card.kind] ?? 0) + delta
          }
        }
      }
    }

    // trustedReplay: `action` comes straight from actionHistory, already
    // validated once when originally submitted — see applyAction's own doc
    // comment (same convention as buildTurnReview/calculateScoreHistory).
    const result = applyAction(state, action, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!result.ok) break
    state = result.state
  }

  return goldByPlayerAndKind
}

export interface UnitValueBreakdown {
  /** This kind's achievement VP, if the player has claimed it (0 otherwise/if unclaimed). */
  achievement: number
  /** This kind's board-count VP (calculateBoardCountDetail) — 0 while the card is in decline, per that function's own rule. */
  presence: number
  /** This kind's share of the player's terrain-control VP (calculateTerrainControlVPByKind). */
  territoryControl: number
  /** Cumulative gold this kind has produced over the whole game, converted to VP at achievementContent.goldPerVictoryPoint (kept fractional — see calculateUnitValueDetail's doc comment for why). */
  goldProduced: number
}

export interface UnitValueDetail {
  kind: string
  breakdown: UnitValueBreakdown
  total: number
}

/**
 * Per (player, unit kind) "unit value" breakdown for the end-of-game screen
 * (issue #335): how much of a player's score any one unit kind is actually
 * responsible for, split into the four contributing factors requested —
 * achievement, board presence, territory control, and cumulative gold
 * production — for a stacked bar chart that distinguishes them. All four
 * factors are expressed in VP-equivalent points so they stack on a common
 * scale; goldProduced divides by goldPerVictoryPoint but, unlike
 * calculateGoldVP's single floor of the player's total gold, is left
 * fractional per kind — flooring each kind separately could make the kinds'
 * shares add up to less than floor(total gold / rate) would, which would
 * read as "missing" points on the chart.
 *
 * Only kinds that contributed something to at least one of the four
 * factors appear in a player's list (an all-zero kind is simply absent,
 * same convention as the individual calculate*Detail functions this
 * combines).
 */
export function calculateUnitValueDetail(
  state: GameState,
  genesis: GameState,
  actionHistory: LoggedAction[],
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): Record<string, UnitValueDetail[]> {
  const achievementByPlayerAndKind: Record<string, Record<string, number>> = {}
  for (const [achievementId, playerId] of Object.entries(state.claimedByAchievementId)) {
    const kind = achievementContent.unitKindByAchievementId[achievementId]
    if (!kind) continue
    const byKind = achievementByPlayerAndKind[playerId] ?? {}
    achievementByPlayerAndKind[playerId] = byKind
    byKind[kind] = (byKind[kind] ?? 0) + (achievementContent.achievementVictoryPoints[achievementId] ?? 0)
  }

  const presenceDetailByPlayerId = calculateBoardCountDetail(state.units, achievementContent.unitBoardCountVP, state.players)
  const presenceByPlayerAndKind: Record<string, Record<string, number>> = {}
  for (const [playerId, details] of Object.entries(presenceDetailByPlayerId)) {
    presenceByPlayerAndKind[playerId] = Object.fromEntries(details.map((d) => [d.kind, d.vp]))
  }

  const territoryByPlayerAndKind = calculateTerrainControlVPByKind(state.board, state.units, achievementContent.terrainVictoryPoints, achievementContent.terrainScoresAs)
  const goldByPlayerAndKind = calculateGoldProducedByKind(genesis, actionHistory, unitContent, achievementContent, boardGenerationContent, taleContent)
  const goldPerVictoryPoint = achievementContent.goldPerVictoryPoint

  const detailByPlayerId: Record<string, UnitValueDetail[]> = {}
  for (const player of state.players) {
    const kinds = new Set<string>([
      ...Object.keys(achievementByPlayerAndKind[player.id] ?? {}),
      ...Object.keys(presenceByPlayerAndKind[player.id] ?? {}),
      ...Object.keys(territoryByPlayerAndKind[player.id] ?? {}),
      ...Object.keys(goldByPlayerAndKind[player.id] ?? {}),
    ])

    const details: UnitValueDetail[] = [...kinds].map((kind) => {
      const goldProduced = goldPerVictoryPoint ? (goldByPlayerAndKind[player.id]?.[kind] ?? 0) / goldPerVictoryPoint : 0
      const breakdown: UnitValueBreakdown = {
        achievement: achievementByPlayerAndKind[player.id]?.[kind] ?? 0,
        presence: presenceByPlayerAndKind[player.id]?.[kind] ?? 0,
        territoryControl: territoryByPlayerAndKind[player.id]?.[kind] ?? 0,
        goldProduced,
      }
      const total = breakdown.achievement + breakdown.presence + breakdown.territoryControl + breakdown.goldProduced
      return { kind, breakdown, total }
    })

    details.sort((a, b) => b.total - a.total)
    detailByPlayerId[player.id] = details
  }

  return detailByPlayerId
}

export type SpendingCategory = 'unitCreation' | 'transform' | 'convert' | 'tradeResource'

/** Maps a RESOLVE_UNIT_ACTION assignment's effect type to the spending category its cost belongs to — a kind not listed here (move/income/produce/trade/region-unit-count-income) never costs gold. */
const SPENDING_CATEGORY_BY_ACTION_TYPE: Partial<Record<UnitActionEffect['actionType'], SpendingCategory>> = {
  create: 'unitCreation',
  'site-create': 'unitCreation',
  transform: 'transform',
  convert: 'convert',
  'trade-resource': 'tradeResource',
}

/** One PURCHASE_CARD action's worth of decline-buyback spending — kept per-purchase rather than summed by kind, so a card bought back more than once shows up that many times in the spending chart (issue #336 follow-up), each with its own card icon. */
export interface DeclineBuybackPurchase {
  /** The bought-back card's unit kind, for rendering its icon in the chart. */
  kind: string
  /** This purchase's cost, in VP-equivalent points (see calculateGoldSpendingByCategory's doc comment). */
  cost: number
}

export interface SpendingBreakdown {
  /** Gold spent creating new units (create/site-create effects), in VP-equivalent points. */
  unitCreation: number
  /** Gold spent transforming a unit into another kind, in VP-equivalent points. */
  transform: number
  /** Gold spent converting an enemy or own unit, in VP-equivalent points. */
  convert: number
  /** Gold spent buying wood/stone (a trade-resource effect's buy mode; sell produces gold instead, so it's never counted here), in VP-equivalent points. */
  tradeResource: number
  /** Every PURCHASE_CARD action's cost, one entry per purchase (not summed by kind) — see DeclineBuybackPurchase. */
  declineBuybacks: DeclineBuybackPurchase[]
}

const EMPTY_SPENDING_BREAKDOWN: SpendingBreakdown = { unitCreation: 0, transform: 0, convert: 0, tradeResource: 0, declineBuybacks: [] }

/**
 * Cumulative gold a player has spent over the whole game, split by what it
 * went toward (issue #336 follow-up: "a spending chart, stacked with the
 * different types of spending amounts, one bar per player") — replays
 * `actionHistory` the mirror image of calculateGoldProducedByKind: instead of
 * attributing a RESOLVE_UNIT_ACTION assignment's *positive* gold delta to the
 * acting card's kind, it attributes a *negative* delta to the resolved
 * action's effect type (SPENDING_CATEGORY_BY_ACTION_TYPE above) — a
 * trade-resource *sell* produces a positive delta, so it's naturally
 * excluded, same as any other income effect. A PURCHASE_CARD's cost
 * (calculatePurchaseCost, priced at the moment of purchase since the cost
 * table is indexed by achievements claimed *so far* — see that function's own
 * doc comment) is tracked separately as declineBuybacks, one entry per
 * purchase, since it isn't a RESOLVE_UNIT_ACTION at all. Every value is
 * converted to VP-equivalent points at achievementContent.goldPerVictoryPoint
 * (a further follow-up: "add to the spending graph that it is in VPs"), kept
 * fractional per category rather than floored, same rationale as
 * calculateUnitValueDetail's goldProduced — flooring each category
 * separately could make them add up to less than the true VP-equivalent
 * total, which would read as "missing" points on the chart. A player who
 * never spent any gold is simply absent from the result, same "absent means
 * zero" convention as calculateGoldProducedByKind.
 */
export function calculateGoldSpendingByCategory(
  genesis: GameState,
  actionHistory: LoggedAction[],
  unitContent: UnitContent = EMPTY_UNIT_CONTENT,
  achievementContent: AchievementContent = EMPTY_ACHIEVEMENT_CONTENT,
  boardGenerationContent: BoardGenerationContent = EMPTY_BOARD_GENERATION_CONTENT,
  taleContent: TaleContent = EMPTY_TALE_CONTENT,
): Record<string, SpendingBreakdown> {
  const breakdownByPlayerId: Record<string, SpendingBreakdown> = {}
  const addSpend = (playerId: string, category: SpendingCategory, amount: number) => {
    const breakdown = breakdownByPlayerId[playerId] ?? { ...EMPTY_SPENDING_BREAKDOWN, declineBuybacks: [] }
    breakdownByPlayerId[playerId] = { ...breakdown, [category]: breakdown[category] + amount }
  }
  const addDeclineBuyback = (playerId: string, kind: string, cost: number) => {
    const breakdown = breakdownByPlayerId[playerId] ?? { ...EMPTY_SPENDING_BREAKDOWN, declineBuybacks: [] }
    breakdownByPlayerId[playerId] = { ...breakdown, declineBuybacks: [...breakdown.declineBuybacks, { kind, cost }] }
  }

  let state = genesis

  for (const { action } of actionHistory) {
    if (action.type === 'RESOLVE_UNIT_ACTION') {
      const cardId = state.chosenCardIdByPlayerId[action.playerId]
      const card = cardId ? state.cards[cardId] : undefined
      if (card) {
        const actionsForKind = unitContent.actionsByKind[card.kind] ?? []
        let subState = state
        for (const assignment of action.unitActions) {
          const unitAction = actionsForKind.find((a) => a.id === assignment.actionId)
          if (!unitAction) continue
          const category = SPENDING_CATEGORY_BY_ACTION_TYPE[unitAction.effect.actionType]
          const targets = assignment.target ? { [assignment.unitId]: assignment.target } : {}
          const goldBefore = subState.players.find((p) => p.id === action.playerId)?.resources.gold ?? 0
          subState = applyUnitActionEffect(subState, action.playerId, card.kind, unitAction, targets, unitContent, [assignment.unitId])
          const goldAfter = subState.players.find((p) => p.id === action.playerId)?.resources.gold ?? 0

          const delta = goldAfter - goldBefore
          if (delta < 0 && category) addSpend(action.playerId, category, -delta)
        }
      }
    }

    if (action.type === 'PURCHASE_CARD') {
      const card = state.cards[action.cardId]
      if (card) {
        const achievementsClaimedSoFar = Object.keys(state.claimedByAchievementId).length
        const cost = calculatePurchaseCost(achievementsClaimedSoFar, achievementContent.purchaseCostTable)
        addDeclineBuyback(action.playerId, card.kind, cost)
      }
    }

    // trustedReplay: same convention as calculateGoldProducedByKind above.
    const result = applyAction(state, action, unitContent, achievementContent, boardGenerationContent, taleContent, true)
    if (!result.ok) break
    state = result.state
  }

  const goldPerVictoryPoint = achievementContent.goldPerVictoryPoint
  const toVP = (gold: number) => (goldPerVictoryPoint ? gold / goldPerVictoryPoint : 0)
  for (const [playerId, breakdown] of Object.entries(breakdownByPlayerId)) {
    breakdownByPlayerId[playerId] = {
      unitCreation: toVP(breakdown.unitCreation),
      transform: toVP(breakdown.transform),
      convert: toVP(breakdown.convert),
      tradeResource: toVP(breakdown.tradeResource),
      declineBuybacks: breakdown.declineBuybacks.map((purchase) => ({ kind: purchase.kind, cost: toVP(purchase.cost) })),
    }
  }

  return breakdownByPlayerId
}

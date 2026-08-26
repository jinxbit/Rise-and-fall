import type { LoggedAction } from './actions'
import { EMPTY_ACHIEVEMENT_CONTENT } from './achievementContent'
import type { AchievementContent } from './achievementContent'
import { applyAction } from './applyAction'
import { EMPTY_BOARD_GENERATION_CONTENT } from './boardGenerationContent'
import type { BoardGenerationContent } from './boardGenerationContent'
import { calculateTerrainControlVPByKind } from './scoring'
import { EMPTY_TALE_CONTENT } from './taleContent'
import type { TaleContent } from './taleContent'
import type { GameState } from './types'
import { applyUnitActionEffect } from './unitActions'
import { EMPTY_UNIT_CONTENT } from './unitContent'
import type { UnitContent } from './unitContent'
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

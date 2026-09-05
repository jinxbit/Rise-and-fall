import type { AchievementContent } from './achievementContent.ts'
import type { TaleContent } from './taleContent.ts'
import type { UnitAction, UnitContent } from './unitContent.ts'

/**
 * Merges a game's active Tale content on top of the base game's
 * UnitContent: appends each Tale's extra actions onto an existing kind's
 * action list, adds each Tale's brand-new companion unit kinds (their own
 * actions/movement/supply cap), applies movement overrides onto an
 * existing kind, and records which kinds are companions of which
 * card-kind (UnitContent.companionKindsByCardKind) — see
 * applyResolveUnitAction in ./applyAction.ts for how that drives which
 * units may act when a given card is played.
 *
 * A no-op (returns an equivalent UnitContent) when taleContent is
 * EMPTY_TALE_CONTENT — the caller only needs to build a non-empty
 * TaleContent (via content/tales.json + the active Tale ids for a given
 * game) when that game actually has Tales active; a game with none never
 * needs to call this at all, though it's harmless to always call it with
 * EMPTY_TALE_CONTENT for a uniform call site.
 */
/**
 * Which companion kinds count as their card kind for the purposes of
 * playing a card (UnitContent.companionKindsByCardKind) — e.g.
 * `{ city: ['capital'] }`, derived straight from taleContent.extraUnitKinds
 * so callers that only have TaleContent in scope (not a full merged
 * UnitContent) can still answer "does this companion count as kind X?"
 * without re-deriving the whole action-list merge below. Also used by
 * applyTaleModifiers itself — the base game never contributes any entries
 * of its own (see EMPTY_UNIT_CONTENT), so this is always the complete map.
 */
export function companionKindsByCardKind(taleContent: TaleContent): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [kind, extraUnit] of Object.entries(taleContent.extraUnitKinds)) {
    result[extraUnit.companionOfKind] = [...(result[extraUnit.companionOfKind] ?? []), kind]
  }
  return result
}

export function applyTaleModifiers(base: UnitContent, taleContent: TaleContent): UnitContent {
  const actionsByKind: Record<string, UnitAction[]> = { ...base.actionsByKind }
  const movementByKind = { ...base.movementByKind }
  const unitSupplyCaps = { ...base.unitSupplyCaps }
  const activationsPerTurnByKind = { ...base.activationsPerTurnByKind }
  const mergedCompanionKindsByCardKind = companionKindsByCardKind(taleContent)

  for (const [kind, extra] of Object.entries(taleContent.extraActionsByKind)) {
    actionsByKind[kind] = [...(actionsByKind[kind] ?? []), ...extra]
  }

  for (const [kind, extraUnit] of Object.entries(taleContent.extraUnitKinds)) {
    movementByKind[kind] = extraUnit.movement
    unitSupplyCaps[kind] = extraUnit.supplyCap
    if (extraUnit.activationsPerTurn !== undefined) activationsPerTurnByKind[kind] = extraUnit.activationsPerTurn
    // A companion that reuses its parent card's actions (The Capital Tale)
    // resolves its final action list AFTER every kind's own extraActionsByKind
    // additions above, so it picks up e.g. any Tale-added extra City action
    // too — see TaleExtraUnitContent.reusesCompanionActions's doc comment.
    if (!extraUnit.reusesCompanionActions) actionsByKind[kind] = extraUnit.actions
  }
  for (const [kind, extraUnit] of Object.entries(taleContent.extraUnitKinds)) {
    if (extraUnit.reusesCompanionActions) actionsByKind[kind] = actionsByKind[extraUnit.companionOfKind] ?? []
  }

  for (const [kind, override] of Object.entries(taleContent.movementOverridesByKind)) {
    movementByKind[kind] = { ...movementByKind[kind], ...override }
  }

  return {
    ...base,
    actionsByKind,
    movementByKind,
    unitSupplyCaps,
    companionKindsByCardKind: mergedCompanionKindsByCardKind,
    activationsPerTurnByKind,
  }
}

/**
 * Merges a game's active Tale-contributed real Trophies (TaleExtraAchievement,
 * see ./taleContent.ts's doc comment) on top of the base game's
 * AchievementContent — same "extend, don't special-case" idea as
 * applyTaleModifiers above, just for the achievement/Trophy/decline
 * pipeline instead of the unit-action one. A no-op when taleContent has no
 * extraAchievements (EMPTY_TALE_CONTENT or a game with no such Tale
 * active).
 */
export function applyTaleAchievementModifiers(base: AchievementContent, taleContent: TaleContent): AchievementContent {
  if (taleContent.extraAchievements.length === 0) return base

  const unitKindByAchievementId = { ...base.unitKindByAchievementId }
  const achievementVictoryPoints = { ...base.achievementVictoryPoints }
  for (const { id, unitKind, victoryPoints } of taleContent.extraAchievements) {
    unitKindByAchievementId[id] = unitKind
    achievementVictoryPoints[id] = victoryPoints
  }

  return { ...base, unitKindByAchievementId, achievementVictoryPoints }
}

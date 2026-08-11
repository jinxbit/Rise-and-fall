import type { TaleContent } from './taleContent'
import type { UnitAction, UnitContent } from './unitContent'

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
export function applyTaleModifiers(base: UnitContent, taleContent: TaleContent): UnitContent {
  const actionsByKind: Record<string, UnitAction[]> = { ...base.actionsByKind }
  const movementByKind = { ...base.movementByKind }
  const unitSupplyCaps = { ...base.unitSupplyCaps }
  const companionKindsByCardKind: Record<string, string[]> = {}
  for (const [cardKind, companions] of Object.entries(base.companionKindsByCardKind)) {
    companionKindsByCardKind[cardKind] = [...companions]
  }

  for (const [kind, extra] of Object.entries(taleContent.extraActionsByKind)) {
    actionsByKind[kind] = [...(actionsByKind[kind] ?? []), ...extra]
  }

  for (const [kind, extraUnit] of Object.entries(taleContent.extraUnitKinds)) {
    actionsByKind[kind] = extraUnit.actions
    movementByKind[kind] = extraUnit.movement
    unitSupplyCaps[kind] = extraUnit.supplyCap
    companionKindsByCardKind[extraUnit.companionOfKind] = [...(companionKindsByCardKind[extraUnit.companionOfKind] ?? []), kind]
  }

  for (const [kind, override] of Object.entries(taleContent.movementOverridesByKind)) {
    movementByKind[kind] = { ...movementByKind[kind], ...override }
  }

  return { ...base, actionsByKind, movementByKind, unitSupplyCaps, companionKindsByCardKind }
}

import type { UnitAction } from './unitContent'
import type { UnitMovement } from './types'

/**
 * A Tale-contributed "companion piece" unit kind — has no Civilization
 * card of its own, and activates whenever companionOfKind's card is
 * played (see UnitContent.companionKindsByCardKind and
 * applyResolveUnitAction in ./applyAction.ts).
 */
export interface TaleExtraUnitContent {
  movement: UnitMovement
  actions: UnitAction[]
  supplyCap: number
  companionOfKind: string
}

/**
 * Everything applyTaleModifiers (./tales.ts) needs to merge a game's
 * active Tales on top of the base game's UnitContent — resolved by the
 * caller from content/tales.json, filtered to only the Tales active for a
 * given game (the engine itself never imports JSON — same convention as
 * UnitContent/AchievementContent/BoardGenerationContent). Empty
 * (EMPTY_TALE_CONTENT) for a game with no Tales active, in which case
 * applyTaleModifiers is a no-op.
 */
export interface TaleContent {
  /** New companion unit kinds, keyed by kind id (e.g. 'port'). */
  extraUnitKinds: Record<string, TaleExtraUnitContent>
  /** Extra actions appended onto an EXISTING unit kind's action list, keyed by that kind's id. */
  extraActionsByKind: Record<string, UnitAction[]>
  /** Movement field overrides merged onto an EXISTING unit kind's base movement, keyed by that kind's id. */
  movementOverridesByKind: Record<string, Partial<UnitMovement>>
}

export const EMPTY_TALE_CONTENT: TaleContent = {
  extraUnitKinds: {},
  extraActionsByKind: {},
  movementOverridesByKind: {},
}

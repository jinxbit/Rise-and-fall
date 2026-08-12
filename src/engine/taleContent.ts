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
 * A Tale-contributed Fantastic Event (e.g. The Banks Tale's Economic
 * Collapse) — resolved by finishRound (./round.ts) whenever two or more
 * players must recycle their hand in the same round, in ascending
 * Tale-number order. Triggers when every non-eliminated player currently
 * controls at least one unit of requiredUnitKind, at which point every
 * unit of that kind is removed from the board and returned to its
 * owner's reserve (removed from GameState.units — same convention as any
 * other unit without a Civilization card of its own).
 */
export interface FantasticEvent {
  id: string
  name: string
  requiredUnitKind: string
}

/**
 * A Tale-contributed end-of-game VP bonus for whoever controls a unique
 * game piece — e.g. The Cathedral Tale: 15 VP to whoever controls the
 * Cathedral when the game ends. Unlike a real achievement
 * (content/achievements.json, claimed permanently the moment a player
 * qualifies), this is tracked dynamically from board state — control can
 * change hands, or the piece can be destroyed and rebuilt elsewhere —
 * there's no "Tale card" concept in this engine to model that physical
 * component with, so it's just "does a unit of `kind` exist, and who owns
 * it right now" (see calculateControllableStructureVP in
 * ./victoryPoints.ts). Displayed as its own "claimable" section in the
 * achievements panel (RoundView.tsx), separate from real achievements.
 */
export interface TaleControllableStructure {
  /** Unit kind id (e.g. 'cathedral') — whoever controls at least one unit of this kind at game end scores victoryPoints. */
  kind: string
  name: string
  victoryPoints: number
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
  /** Fantastic Events contributed by active Tales, already in ascending Tale-number order — see finishRound (./round.ts). */
  fantasticEvents: FantasticEvent[]
  /** End-of-game "control a unique piece" VP bonuses contributed by active Tales — see calculateControllableStructureVP (./victoryPoints.ts). */
  controllableStructures: TaleControllableStructure[]
}

export const EMPTY_TALE_CONTENT: TaleContent = {
  extraUnitKinds: {},
  extraActionsByKind: {},
  movementOverridesByKind: {},
  fantasticEvents: [],
  controllableStructures: [],
}

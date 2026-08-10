import type { Resources, UnitMovement } from './types'

/**
 * Mirrors content/units.json's action `effect` shapes, now that the rules
 * are concrete enough to type precisely (units.schema.json still keeps
 * `effect` loosely typed on purpose, since the engine doesn't import the
 * JSON — a caller resolves it into this shape and passes it to
 * applyAction's `unitContent` param, same pattern as createNewGame's
 * `resourceBank`/`unitLimits`).
 */

export interface ActionCost {
  gold?: number
  wood?: number
  stone?: number
}

export interface CreateEffect {
  actionType: 'create'
  /** Unit kind id to create — matches Unit.kind / a units.json id. */
  targetUnit: string
  targetHex: { location: 'adj' }
  cost: ActionCost
}

export interface TransformEffect {
  actionType: 'transform'
  targetUnit: string
  targetHex: { terrainType: string[]; location: 'self' | 'adj' }
  destroySelf: boolean
  cost: ActionCost
}

export interface ConvertEffect {
  actionType: 'convert'
  targetHex: { location: 'adj' }
  /**
   * 'enemy' steals an adjacent enemy unit outright, keeping its kind (e.g.
   * Temple's Convert Enemy Unit). 'own' instead targets one of the acting
   * player's own adjacent units — used for a City upgrading an adjacent
   * Nomad into a Merchant or Mountaineer (per ruling, the City doesn't
   * conjure the Merchant/Mountaineer from nothing; it converts an existing
   * Nomad into one) — paired with `requiredTargetKind`/`resultUnit` below.
   */
  targetOwner: 'enemy' | 'own'
  targetMobileOnly: boolean
  /** Restricts which kind may be targeted — required for a meaningful 'own' conversion (e.g. 'nomad'); unused for 'enemy'. */
  requiredTargetKind?: string
  /** If set, the target unit's kind changes to this (e.g. nomad -> merchant); otherwise only ownership changes, same as before this field existed (the 'enemy' case). */
  resultUnit?: string
  cost: ActionCost
}

export interface IncomeEffect {
  actionType: 'income'
  goldByTerrain?: Record<string, number>
  goldPerAdjacentOwnUnit?: number
  excludeUnitTypes?: string[]
  goldPerAdjacentUnit?: { own?: Record<string, number>; enemy?: Record<string, number> }
}

export interface ProduceEffect {
  actionType: 'produce'
  resourceByTerrain: Record<string, Partial<Record<keyof Resources, number>>>
}

/**
 * A real 1-way conversion (per ruling): each of Merchant's Buy/Sell
 * Wood/Stone actions is its own effect — `resource` and `mode` are fixed
 * per action (not a player choice at resolve time), so it applies
 * uniformly to every Merchant the player owns, same as any other
 * no-target action.
 */
export interface TradeResourceEffect {
  actionType: 'trade-resource'
  resource: 'wood' | 'stone'
  mode: 'buy' | 'sell'
  resourceAmount: number
  goldPerResource: number
}

export interface TradeEffect {
  actionType: 'trade'
  goldPerCity: number
}

/**
 * A normal action like any other, with no exceptions: each unit of the
 * activated kind moves to its own target hex (RESOLVE_UNIT_ACTION's
 * `targets`, same per-unit-target shape as create/transform/convert),
 * independently. See applyMove() in ./unitActions.ts and
 * legalMoveDestinations() in ./movement.ts.
 */
export interface MoveEffect {
  actionType: 'move'
}

export type UnitActionEffect =
  | CreateEffect
  | TransformEffect
  | ConvertEffect
  | IncomeEffect
  | ProduceEffect
  | TradeResourceEffect
  | TradeEffect
  | MoveEffect

export interface UnitAction {
  id: string
  name: string
  description: string
  effect: UnitActionEffect
}

/**
 * Everything applyAction needs to resolve a RESOLVE_UNIT_ACTION, resolved
 * by the caller from content/units.json, content/terrain.json, and
 * content/resources.json (the engine itself never imports JSON — see
 * UNIT_KINDS in ./cards.ts for the same convention).
 */
export interface UnitContent {
  /** content/units.json's actions[], keyed by unit kind id. */
  actionsByKind: Record<string, UnitAction[]>
  /** content/units.json's movement, keyed by unit kind id — used to stamp newly created/transformed units. */
  movementByKind: Record<string, UnitMovement>
  /** content/terrain.json's level, keyed by terrain id — used for cliff-edge checks on targeted actions. */
  terrainLevels: Record<string, number>
  /** content/resources.json's playerCap, keyed by resource id (null = uncapped, e.g. Gold). */
  resourceCaps: Partial<Record<keyof Resources, number | null>>
  /** content/units.json's supply.byPlayerCount, keyed by unit kind id — the hard cap "create" won't exceed. */
  unitSupplyCaps: Record<string, number>
}

export const EMPTY_UNIT_CONTENT: UnitContent = {
  actionsByKind: {},
  movementByKind: {},
  terrainLevels: {},
  resourceCaps: {},
  unitSupplyCaps: {},
}

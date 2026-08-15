import type { Resources, UnitMovement } from './types'

/**
 * Mirrors content/units.json's action `effect` shapes, now that the rules
 * are concrete enough to type precisely (units.schema.json still keeps
 * `effect` loosely typed on purpose, since the engine doesn't import the
 * JSON — a caller resolves it into this shape and passes it to
 * applyAction's `unitContent` param, same pattern as createNewGame's
 * `resourceBank`).
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
  /**
   * Optional extra condition, independent of targetHex: at least one hex
   * adjacent to the ACTING unit's own position must currently have one of
   * these terrain types (regardless of whether targetHex.location is
   * 'self' or 'adj' — for 'self' this is the only adjacency condition the
   * effect has at all, since targetHex itself only constrains the unit's
   * own hex). E.g. The Ports Tale's Ship-builds-Port: the Ship's own hex
   * is always water (trivially true, unchecked further), but the action
   * additionally requires the Ship be "adjacent to at least one Plains
   * space." Undefined (the default) means no such condition, matching
   * every transform action before this field existed.
   */
  requiredAdjacentTerrain?: string[]
  /**
   * Optional extra condition, independent of targetHex/requiredAdjacentTerrain:
   * at least one hex adjacent to the ACTING unit's own position must
   * currently hold a unit of this kind, owned by the acting player — e.g.
   * The Banks Tale's Construct a Bank requires the Nomad be "adjacent to
   * at least one allied City." Undefined (the default) means no such
   * condition.
   */
  requiredAdjacentOwnUnitKind?: string
  /**
   * Extra cost added on top of `cost`, scaled by how many units of
   * countKind currently exist anywhere on the board (any owner) — e.g.
   * The Banks Tale's Construct a Bank: 5 extra GP per Bank already in the
   * World, so the first Bank costs 5 GP, the second 10, the third 15, etc.
   * Undefined (the default) means no such scaling, matching every
   * transform action before this field existed. See
   * computeEffectiveTransformCost in ./unitActions.ts.
   */
  extraCostPerBoardUnitCount?: { countKind: string; costPerUnit: ActionCost }
  /**
   * Optional extra condition: the acting player must currently control at
   * least `atLeast` units of `kind` (anywhere on the board, including the
   * acting unit itself if `kind` matches its own) — e.g. The Cathedral
   * Tale's Construct the Cathedral requires "your 3 Temples present in the
   * World," checked against the acting Temple's own count. Undefined (the
   * default) means no such condition. See hasOwnKindCountAtLeast in
   * ./unitActions.ts.
   */
  requiredOwnKindCount?: { kind: string; atLeast: number }
  /**
   * Optional extra condition: no unit of `kind` may currently exist
   * anywhere on the board (any owner) — e.g. The Cathedral Tale's "there's
   * only one Cathedral in the game," which blocks Construct the Cathedral
   * once any player has built it, until it's ever removed from the board
   * again (per ruling, a destroyed Cathedral can be built again by anyone).
   * Undefined (the default) means no such condition. See
   * boardHasUnitOfKind in ./unitActions.ts.
   */
  forbiddenIfBoardHasKind?: string
  /**
   * Optional stacking exception for an 'adj'-location transform's target
   * hex: normally the hex must be completely empty, but if every current
   * occupant's kind is in this list (any owner), the hex still counts as
   * available — e.g. Ship's Transform to Merchant may target a Plains or
   * Forest hex that's empty OR occupied only by a City (allied or
   * opposing), per the Merchant stacking rule. Undefined (the default)
   * means the hex must be empty, matching every transform action before
   * this field existed. Mirrors UnitMovement.canEndMoveOnUnitTypes in
   * ./types.ts (see canLandOn in ./movement.ts) — same any-owner allow-list
   * idea, applied to transform instead of move.
   */
  allowedOccupantKinds?: string[]
  /**
   * Optional override of the cliff rule for this transform's 'adj'-location
   * target: when true, an elevation-diff>1 hexside (see crossesCliff in
   * ./unitActions.ts) no longer blocks the target hex. Undefined (the
   * default, false) preserves the usual absolute rule shared with
   * create/convert. E.g. Ship's Transform to Nomad/Merchant: the Ship
   * always sits on Water (level 0) and Forest is level 2 — an elevation
   * diff of 2 that would otherwise make an adjacent Forest hex permanently
   * unreachable by this action despite the card text listing Forest as
   * legal terrain.
   */
  ignoresCliff?: boolean
  /**
   * Optional replacement for the ordinary "only the acting unit is
   * consumed" rule: requires the acting unit's own hex to be one corner of
   * a 4-hex rhombus entirely occupied by the acting player's own units of
   * `kind` (the acting unit itself counts as one corner) — see
   * findAdjacentRhombusCluster in ./unitActions.ts for the exact geometry.
   * When satisfied, all 4 units are removed (not just the acting one,
   * regardless of `destroySelf`) and the new unit is placed on the acting
   * unit's own hex — so `targetHex` should be `{ location: 'self' }` for
   * an effect that sets this. E.g. The Capital Tale's Constructing the
   * Capital: "control 4 adjacent Cities."
   */
  requiredAdjacentRhombusOfKind?: string
}

/**
 * Creates a unit on the ACTING unit's own hex — for a companion piece
 * whose hex is already occupied by itself, so the normal create/transform
 * "target hex must be empty" rule can't apply (e.g. The Ports Tale: a
 * Port's Construct a Ship action places a Ship in the Port's own Sea
 * space). Unlike create/transform, legality is "no current occupant's
 * kind is in blockedByKinds" (the acting unit's own presence is always
 * ignored), not "hex must be empty" — see applySiteCreate in
 * ./unitActions.ts.
 */
export interface SiteCreateEffect {
  actionType: 'site-create'
  targetUnit: string
  /** Occupant kinds (any owner) on the acting unit's own hex that block this action — e.g. Port's Construct a Ship is blocked by an existing ['ship']. */
  blockedByKinds: string[]
  cost: ActionCost
}

/**
 * Gold per unit of a given kind located anywhere within the acting unit's
 * whole connected terrain region (same region concept as Ship's Trade
 * effect's computeTradeGold, but counting units IN the region rather than
 * Cities adjacent to it) — e.g. The Ports Tale's Trade with Ships and
 * Ports: 4 GP per Ship or Port anywhere in the Port's Sea region,
 * regardless of owner, including the acting Port itself.
 */
export interface RegionUnitCountIncomeEffect {
  actionType: 'region-unit-count-income'
  countKinds: string[]
  goldPerUnit: number
}

export interface ConvertEffect {
  actionType: 'convert'
  targetHex: { location: 'adj' }
  /**
   * Farthest hex-distance this may target — undefined (the default) means
   * adjacent only (distance 1), matching every convert action before this
   * field existed. E.g. The Cathedral Tale's Convert Enemy Unit reaches 2
   * spaces instead of Temple's usual 1. A cliff edge only ever blocks the
   * default adjacent case (see crossesCliff in ./unitActions.ts) — there's
   * no single hexside to check at longer range, so the cliff rule is
   * skipped entirely once this is set above 1.
   */
  maxDistance?: number
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
  /**
   * Per ruling, Temple's Convert Enemy Unit costs a different amount of
   * gold depending on the target's kind (e.g. cheaper for a Nomad, pricier
   * for a Ship) — keyed by unit kind id, checked/paid instead of `cost`
   * once the target is known. `cost` remains the fallback for a kind with
   * no entry here (and is what an 'own' conversion like City's still
   * uses, since only 'enemy' conversions vary by target today).
   */
  costByTargetKind?: Record<string, ActionCost>
  /**
   * Optional override of the cliff rule for this convert action's 'adj'
   * target (see crossesCliff in ./unitActions.ts): when true, an
   * elevation-diff>1 hexside no longer blocks the target hex. Undefined
   * (the default, false) preserves the usual absolute rule shared with
   * create/transform. Mirrors TransformEffect.ignoresCliff above. E.g.
   * Temple's Convert Enemy Unit: per ruling, a Temple converts a devoted
   * follower by faith rather than physical access, so it can convert an
   * adjacent enemy unit even across a cliff edge.
   */
  ignoresCliff?: boolean
}

export interface IncomeEffect {
  actionType: 'income'
  goldByTerrain?: Record<string, number>
  goldPerAdjacentOwnUnit?: number
  excludeUnitTypes?: string[]
  /**
   * Farthest hex-distance goldPerAdjacentOwnUnit counts over — undefined
   * (the default) means adjacent only (distance 1), matching every income
   * effect before this field existed. E.g. The Cathedral Tale's Generate
   * Income reaches 2 spaces instead of Temple's usual 1.
   */
  maxDistance?: number
  goldPerAdjacentUnit?: { own?: Record<string, number>; enemy?: Record<string, number> }
  /**
   * Gold scaled by the total number of units of countKind anywhere on the
   * board (any owner, including the acting player's own) — e.g. The Banks
   * Tale's Increase Taxes: rate(terrain) * (1 + total Banks in the World).
   * Only pays out if the acting player owns at least one unit of countKind
   * themselves (checked in computeIncomeGold, ./unitActions.ts) — a player
   * with no Bank of their own gains nothing, which folds into "action
   * unavailable" via wouldGainResource in actionTargeting.ts's
   * isActionAvailableForUnit. Undefined (the default) means no such
   * effect, matching every income effect before this field existed.
   */
  goldByTerrainScaledByBoardUnitCount?: { ratePerTerrain: Record<string, number>; countKind: string }
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
  | SiteCreateEffect
  | RegionUnitCountIncomeEffect

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
  /**
   * Tale "companion piece" unit kinds (no Civilization card of their own)
   * that activate alongside a different kind's card — keyed by the card's
   * kind, e.g. `{ ship: ['port'] }` for The Ports Tale. Populated by
   * applyTaleModifiers (./tales.ts) merging active Tale content on top of
   * the base game's units.json content; empty for a game with no Tales
   * active. See applyResolveUnitAction (./applyAction.ts) for how this
   * drives which units may act when a card is played, and
   * GameState.unitsCreatedThisTurn for the "can't activate the turn it's
   * built" rule every companion piece shares.
   */
  companionKindsByCardKind: Record<string, string[]>
  /**
   * How many separate actions a unit of this kind may resolve in the same
   * turn — keyed by kind id, missing entries default to 1 (every base-game
   * unit and most companions). Populated by applyTaleModifiers (./tales.ts)
   * from a Tale extra unit's `activationsPerTurn` — e.g. The Capital Tale:
   * `{ capital: 2 }`, since the Capital performs 2 actions from the City
   * card each time its owner plays it. See GameState.resolvedUnitIdsThisTurn
   * (./types.ts) and applyResolveUnitAction (./applyAction.ts), which count
   * a unit's occurrences there against this cap instead of a flat "already
   * acted" boolean.
   */
  activationsPerTurnByKind: Record<string, number>
}

export const EMPTY_UNIT_CONTENT: UnitContent = {
  actionsByKind: {},
  movementByKind: {},
  terrainLevels: {},
  resourceCaps: {},
  unitSupplyCaps: {},
  companionKindsByCardKind: {},
  activationsPerTurnByKind: {},
}

/**
 * Kogge game state and actions — see KOGGE_PLAN.md. Deliberately independent
 * of the Rise & Fall engine's types (`src/engine/types.ts`): the two games
 * share nothing but the app shell.
 */

export const GOOD_COLORS = ['grey', 'orange', 'purple', 'white'] as const
export type GoodColor = (typeof GOOD_COLORS)[number]
export type Goods = Record<GoodColor, number>

export const BONUS_TYPES = ['tripleTrade', 'extraMarker', 'freeSecondMove', 'secretPassage'] as const
export type BonusType = (typeof BONUS_TYPES)[number]

/** Route-marker values are 0..8; a marker count array is indexed by value. */
export const MARKER_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const
export type MarkerCounts = number[]

export interface RouteSlot {
  value: number
  faceUp: boolean
}

export interface KoggeCity {
  number: number
  color: GoodColor
  slots: [RouteSlot, RouteSlot]
  goods: Goods
  /** Player ids of the raid markers placed here (permanent). */
  raids: string[]
}

export interface KoggeHouse {
  ownerId: string
  city: number
  /** Goods waiting beside this house; they belong to the owner. */
  goods: Goods
}

export interface KoggePlayer {
  id: string
  name: string
  /** Seating index — "the player to your left" is seat + 1. */
  seat: number
  boatCity: number | null
  hand: MarkerCounts
  goods: Goods
  raidMarkersInHand: number
  secondRaidMarkerTaken: boolean
  bonuses: BonusType[]
}

export interface KoggeBid {
  playerId: string
  /** Empty = passed (no legal bid existed). */
  markers: number[]
}

export type KoggePhase = 'startPick' | 'auction' | 'guildmaster' | 'actions' | 'finished'

export type TurnActionKind = 'build' | 'guild' | 'buyLot' | 'tradeCity' | 'changeRoute' | 'raid'

export interface KoggeTurn {
  playerId: string
  /** Movement attempts so far this turn, including a lost free move. */
  movesMade: number
  moved: boolean
  movementClosed: boolean
  used: TurnActionKind[]
}

export type RaidPending =
  | { kind: 'split'; attackerId: string; defenderId: string }
  | { kind: 'choose'; attackerId: string; defenderId: string; groupA: Goods; groupB: Goods }
  | { kind: 'route'; attackerId: string; chooserId: string }

export interface KoggeSetup {
  players: { id: string; name: string }[]
  seed: number
}

export interface KoggeState {
  setup: KoggeSetup
  rng: number
  phase: KoggePhase
  round: number
  players: KoggePlayer[]
  /** Indexed by city number. */
  cities: KoggeCity[]
  /** City numbers in clockwise order. */
  ring: number[]
  houses: KoggeHouse[]
  reserve: MarkerCounts
  supply: Goods
  bonusSupply: Record<BonusType, number>
  guildmaster: { city: number; start: number; returns: number }
  finalRound: boolean
  turnOrder: string[]
  lots: number[][]
  startPicks: Record<string, number | null>
  bids: KoggeBid[]
  turn: KoggeTurn | null
  pending: RaidPending | null
  winnerIds: string[]
  endReason: 'development' | 'guildmaster' | null
  log: string[]
  actionHistory: KoggeAction[]
}

export type Payment = { kind: 'good'; color: GoodColor } | { kind: 'marker'; value: number }

export interface TradeBundle {
  goods: Goods
  markers: MarkerCounts
}

export type KoggeAction =
  | { type: 'PICK_START'; playerId: string; value: number }
  | { type: 'BID'; playerId: string; markers: number[] }
  | { type: 'MOVE_GUILDMASTER'; playerId: string; steps: 1 | 2 }
  | { type: 'MOVE'; playerId: string; route: 0 | 1 | 'guildmaster'; payments: Payment[] }
  | { type: 'BUILD_HOUSE'; playerId: string }
  | { type: 'GUILD_RAID_MARKER'; playerId: string; value: number }
  | { type: 'GUILD_BONUS'; playerId: string; color: GoodColor; bonus: BonusType }
  | { type: 'GUILD_BUY_MARKER'; playerId: string; value: number }
  | { type: 'GUILD_SELL_MARKER'; playerId: string; value: number }
  | { type: 'BUY_LOT'; playerId: string; lot: number; payment: GoodColor }
  | { type: 'TRADE_CITY'; playerId: string; give: GoodColor; take: GoodColor[] }
  | { type: 'CHANGE_ROUTE'; playerId: string; slot: 0 | 1; value: number }
  | { type: 'RAID'; playerId: string; mode: 'player'; targetId: string }
  | { type: 'RAID'; playerId: string; mode: 'city' }
  | { type: 'RAID_SPLIT'; playerId: string; groupA: Goods }
  | { type: 'RAID_TAKE'; playerId: string; group: 'A' | 'B' }
  | { type: 'RAID_ROUTE'; playerId: string; slot: 0 | 1 }
  | { type: 'TRADE_PLAYERS'; playerId: string; partnerId: string; give: TradeBundle; receive: TradeBundle }
  | { type: 'END_TURN'; playerId: string }

import type { BonusType, GoodColor, Goods } from './types'

/**
 * The fixed Kogge board layout and component counts — see KOGGE_PLAN.md
 * ("Components" and "Interpretations"). Colours follow the goods' rarity:
 * grey is the common colour for both goods and low-numbered markers.
 */
export const CITY_COLORS: readonly GoodColor[] = ['grey', 'grey', 'grey', 'orange', 'orange', 'purple', 'purple', 'white', 'white']

/** Clockwise ring order of city numbers. */
export const RING_ORDER: readonly number[] = [0, 5, 1, 7, 3, 8, 2, 6, 4]

/** Copies of each marker value in the reserve: 14 zeros down to 6 eights. */
export const RESERVE_COUNTS: readonly number[] = [14, 13, 12, 11, 10, 9, 8, 7, 6]

export const SUPPLY_COUNTS: Goods = { grey: 25, orange: 18, purple: 13, white: 10 }

export const BONUS_COUNT_PER_TYPE = 2

export const GOOD_VP: Goods = { grey: 1, orange: 3, purple: 5, white: 7 }
export const HOUSE_VP = 10
export const RAID_MARKER_VP = 10
export const BONUS_VP = 20

export const WINNING_DP = 5
export const LOT_COUNT = 4
export const LOT_SIZE = 2

export const BONUS_LABELS: Record<BonusType, string> = {
  tripleTrade: 'Triple trade',
  extraMarker: 'Extra marker',
  freeSecondMove: 'Free second move',
  secretPassage: 'Secret passage',
}

export const BONUS_DESCRIPTIONS: Record<BonusType, string> = {
  tripleTrade: 'City trades give you 3 goods for 1 instead of 2.',
  extraMarker: 'Draw a random route marker at the start of every round.',
  freeSecondMove: 'Your second move each turn is free.',
  secretPassage: 'Sail straight to the Guildmaster’s city for one extra payment.',
}

export function markerColor(value: number): GoodColor {
  return CITY_COLORS[value]
}

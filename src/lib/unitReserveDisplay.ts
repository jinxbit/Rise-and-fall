/**
 * How PlayersStrip's per-kind unit badge (RoundView.tsx) reports a player's
 * unit supply (issue #346) — a per-account preference, same shape as
 * unitColors.ts. 'remaining' (cap minus units currently on the board) is the
 * default, matching the game's original, non-configurable behaviour.
 */
export type UnitReserveDisplayMode = 'remaining' | 'placed' | 'both'

export const DEFAULT_UNIT_RESERVE_DISPLAY_MODE: UnitReserveDisplayMode = 'remaining'

const VALID_MODES: UnitReserveDisplayMode[] = ['remaining', 'placed', 'both']

/** A profile's raw stored value (any string, or unset) collapsed to a valid mode — unset/unrecognized falls back to the default, same null-collapsing pattern as resolveUnitPlateColors. */
export function resolveUnitReserveDisplayMode(value: string | null | undefined): UnitReserveDisplayMode {
  return VALID_MODES.includes(value as UnitReserveDisplayMode) ? (value as UnitReserveDisplayMode) : DEFAULT_UNIT_RESERVE_DISPLAY_MODE
}

/** The badge text for one unit kind's cap/on-board counts, per the resolved mode — 'both' reads as "placed/remaining" per issue #346. */
export function formatUnitReserveCount(mode: UnitReserveDisplayMode, onBoard: number, remaining: number): string {
  switch (mode) {
    case 'placed':
      return `${onBoard}`
    case 'both':
      return `${onBoard}/${remaining}`
    case 'remaining':
    default:
      return `${remaining}`
  }
}

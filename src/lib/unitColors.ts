/**
 * A unit marker's plate fill (see HexBoard.tsx's UnitMarker.cardState) for
 * each of the 3 card-zone states a player can customize from their profile
 * (issue #311 follow-up). Not every CardZone gets a customizable colour —
 * 'supply'/'decline' render with the fixed neutral plate regardless, same as
 * before this feature existed.
 */
export interface UnitPlateColors {
  hand: string
  selected: string
  discard: string
}

/**
 * Defaults per the issue #311 follow-up request: plain white for a card
 * sitting untouched in hand (so it reads as the "normal" state), light gold
 * for the card a player has chosen to play this round (the most visually
 * distinct state — it's the one about to resolve), and light grey for
 * discard — distinct from both the white hand plate and the off-white
 * neutral plate (UNIT_PLATE_COLOR in HexBoard.tsx) used for supply/decline.
 */
export const DEFAULT_UNIT_PLATE_COLORS: UnitPlateColors = {
  hand: '#ffffff',
  selected: '#fde68a',
  discard: '#e5e7eb',
}

/** A profile row's raw per-column overrides — each null/undefined means "use the default" (see DEFAULT_UNIT_PLATE_COLORS). */
export interface UnitPlateColorOverrides {
  hand: string | null
  selected: string | null
  discard: string | null
}

/** Merges a profile's saved overrides over the defaults — used both by the live board (useUnitPlateColors) and by UnitColorSettings to show the effective current value. */
export function resolveUnitPlateColors(overrides: Partial<UnitPlateColorOverrides> | null | undefined): UnitPlateColors {
  return {
    hand: overrides?.hand ?? DEFAULT_UNIT_PLATE_COLORS.hand,
    selected: overrides?.selected ?? DEFAULT_UNIT_PLATE_COLORS.selected,
    discard: overrides?.discard ?? DEFAULT_UNIT_PLATE_COLORS.discard,
  }
}

/** #rrggbb — matches what `<input type="color">` produces, and what the `profiles_unit_color_*_format` check constraints (0022_unit_plate_colors.sql) accept. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value)
}

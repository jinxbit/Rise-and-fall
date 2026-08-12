/**
 * One hand-drawn silhouette pictogram per unit kind, replacing the old
 * single/double-letter text label (see unitKindLabel.ts, now unused) —
 * design proposal reviewed and approved before wiring in here. Each icon
 * is a handful of basic shapes on a shared 24×24 grid so every glyph sits
 * at the same optical weight.
 *
 * Contrast is guaranteed structurally, not per-icon: HexBoard.tsx draws
 * every glyph in one fixed ink colour on a fixed light "plate" behind it
 * (not the player's colour — a marker filled with the owner's colour
 * couldn't guarantee the glyph read clearly against every one of the four
 * player colours, which is what prompted this). Ownership instead shows as
 * a small colour bar beneath the plate; the glyph is sized to spill past
 * that bar's edges on purpose.
 */

export type IconShape =
  | { kind: 'polygon'; points: string }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx?: number }
  | { kind: 'path'; d: string; fillRule?: 'evenodd' }
  | { kind: 'circle'; cx: number; cy: number; r: number }

export const UNIT_ICONS: Record<string, IconShape[]> = {
  // Battlement block — the only flat-topped, rectangular mass in the set.
  city: [{ kind: 'polygon', points: '5,19 5,9 8,9 8,11.5 10.5,11.5 10.5,9 13.5,9 13.5,11.5 16,11.5 16,9 19,9 19,19' }],
  // Pediment over fluted columns — straight, symmetric, architectural.
  temple: [
    { kind: 'polygon', points: '12,4 20,10 4,10' },
    { kind: 'rect', x: 4, y: 17.3, width: 16, height: 2.2 },
    { kind: 'rect', x: 6.3, y: 10, width: 1.5, height: 7.3 },
    { kind: 'rect', x: 11.25, y: 10, width: 1.5, height: 7.3 },
    { kind: 'rect', x: 16.2, y: 10, width: 1.5, height: 7.3 },
  ],
  // A donkey in side profile — body, neck, head, two long upright ears (the
  // feature that reads "donkey" rather than "horse"), two merged leg
  // blocks, a tail. Went through a tent, then a covered wagon, then a
  // wagon wheel before landing here — see git history on this file for why
  // each earlier attempt got replaced.
  nomad: [
    { kind: 'rect', x: 4, y: 11, width: 11, height: 5, rx: 2.4 },
    { kind: 'rect', x: 12.4, y: 6, width: 3, height: 6.2, rx: 1 },
    { kind: 'rect', x: 14.6, y: 4.4, width: 5, height: 3.8, rx: 1.6 },
    { kind: 'polygon', points: '14.9,5 13.6,0.8 15.7,4.3' },
    { kind: 'polygon', points: '16.9,4.6 17.5,0.5 18.6,4.2' },
    { kind: 'rect', x: 12, y: 15.6, width: 2.6, height: 6.2 },
    { kind: 'rect', x: 5.4, y: 15.6, width: 2.6, height: 6.2 },
    { kind: 'polygon', points: '4.5,11.5 2.3,14 4.3,16.5 5,15.5 4,14 4.8,12.5' },
  ],
  // A drawstring coin bag — the only rounded, organic silhouette.
  merchant: [
    { kind: 'path', d: 'M8.5,20 Q5,20 5,15.4 Q5,10.6 9,9.6 L15,9.6 Q19,10.6 19,15.4 Q19,20 15.5,20 Z' },
    { kind: 'rect', x: 10, y: 6.3, width: 4, height: 3.5, rx: 0.8 },
    { kind: 'circle', cx: 12, cy: 6, r: 1 },
  ],
  // Twin jagged peaks with a summit flag — zigzag reads instantly against every smooth shape.
  mountaineer: [
    { kind: 'polygon', points: '4,20 9,9 12,13 16,6 20,20' },
    { kind: 'rect', x: 15.65, y: 1.8, width: 0.7, height: 4.4 },
    { kind: 'polygon', points: '16,2 20.6,3.35 16,4.7' },
  ],
  // Hull curve with an off-centre sail — asymmetric, unlike Temple/Nomad's centred triangles.
  ship: [
    { kind: 'path', d: 'M4,17 Q12,22.5 20,17 Q12,19.1 4,17 Z' },
    { kind: 'rect', x: 11.6, y: 5, width: 0.9, height: 12 },
    { kind: 'polygon', points: '12.5,6 19,15 12.5,15' },
  ],
  // A lighthouse (The Ports Tale) — tapered tower with a banded waist,
  // lantern room, peaked roof, and light beams fanning out from the top so
  // it doesn't just read as a generic tower.
  port: [
    { kind: 'polygon', points: '7.5,20 16.5,20 14.3,7.5 9.7,7.5' },
    { kind: 'rect', x: 8.9, y: 13, width: 6.2, height: 1.8 },
    { kind: 'rect', x: 9.4, y: 3.8, width: 5.2, height: 3.7, rx: 0.4 },
    { kind: 'polygon', points: '8.7,3.8 15.3,3.8 12,0.8' },
    { kind: 'polygon', points: '9.4,5.2 3.5,3.2 9.4,6.6' },
    { kind: 'polygon', points: '14.6,5.2 20.5,3.2 14.6,6.6' },
  ],
  // A vault (The Banks Tale) — squared safe body, a dial face, a center
  // bolt, and a handle. Deliberately not more coins (Merchant already owns
  // that motif) — the dial/handle silhouette reads as "locked away" instead.
  bank: [
    { kind: 'rect', x: 4, y: 4, width: 16, height: 16, rx: 1.5 },
    { kind: 'circle', cx: 12, cy: 12, r: 4.2 },
    { kind: 'circle', cx: 12, cy: 12, r: 1.1 },
    { kind: 'rect', x: 11.3, y: 6.4, width: 1.4, height: 2.4 },
    { kind: 'rect', x: 16.3, y: 9.5, width: 2.4, height: 1.4 },
  ],
  // The Cathedral Tale — twin flanking spires plus a taller central spire
  // over the nave, with a doorway sliver. Reads as "grander than a Temple"
  // through sheer roofline height rather than reusing Temple's column
  // motif, since only one Cathedral ever exists at once.
  cathedral: [
    { kind: 'rect', x: 3.5, y: 11, width: 3.4, height: 9 },
    { kind: 'polygon', points: '3.5,11 5.2,5 6.9,11' },
    { kind: 'rect', x: 16.6, y: 11, width: 3.4, height: 9 },
    { kind: 'polygon', points: '16.6,11 18.3,5 20,11' },
    { kind: 'rect', x: 8.3, y: 13, width: 7.4, height: 7 },
    { kind: 'polygon', points: '8.3,13 12,7.5 15.7,13' },
    { kind: 'rect', x: 11.1, y: 16, width: 1.8, height: 4 },
  ],
}

/** City and Temple are immobile structures (never move once placed) — marked with a rectangle instead of the mobile units' circle. Port (The Ports Tale), Bank (The Banks Tale), and Cathedral (The Cathedral Tale) are likewise immobile once built. */
export const STATIC_UNIT_KINDS = new Set(['city', 'temple', 'port', 'bank', 'cathedral'])

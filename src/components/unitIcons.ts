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
  // A wagon wheel — rim, four spokes, hub. Reads as "on the move," unlike
  // the tent this replaced (a Nomad never sits still). A full covered-wagon
  // silhouette (canopy over two wheels) was tried first, but on the round
  // marker plate the dome-plus-two-wheels shape read as a face, not a
  // wagon; a wheel is radially symmetric, so it can't be misread that way,
  // and it's bolder at small sizes than a multi-part scene would be.
  nomad: [
    { kind: 'path', d: 'M3,12 A9,9 0 1,0 21,12 A9,9 0 1,0 3,12 Z M5.8,12 A6.2,6.2 0 1,0 18.2,12 A6.2,6.2 0 1,0 5.8,12 Z', fillRule: 'evenodd' },
    { kind: 'rect', x: 5.8, y: 11.2, width: 12.4, height: 1.6 },
    { kind: 'rect', x: 11.2, y: 5.8, width: 1.6, height: 12.4 },
    { kind: 'circle', cx: 12, cy: 12, r: 2.2 },
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
}

/** City and Temple are immobile structures (never move once placed) — marked with a rectangle instead of the mobile units' circle. */
export const STATIC_UNIT_KINDS = new Set(['city', 'temple'])

import type { Resources } from '../engine/types'
import type { IconShape } from './unitIcons'

/**
 * One hand-drawn pictogram per resource kind, same 24x24 grid / IconShape
 * vocabulary as unitIcons.ts's UNIT_ICONS — the iconography an action's
 * outcome preview is built from (see HexBoard.tsx's ActionMenuOption.outcome
 * and ResourceIcon.tsx), so a Ship's Trade reads as "+15 (gold coin)"
 * instead of a bare, unit-less number. Each is drawn to be told apart by
 * silhouette alone (round coins vs. flat stacked planks vs. jagged boulders)
 * since RESOURCE_COLOR_CLASS below is the only thing distinguishing them by
 * colour — the shape has to carry the read too.
 */
export const RESOURCE_ICONS: Record<keyof Resources, IconShape[]> = {
  // Three staggered coins — each one's curve bulges past the one behind it,
  // the same layered-silhouette trick unitIcons.ts's Bank/Temple already
  // use to read clearly from flat, single-colour fills alone.
  gold: [
    { kind: 'circle', cx: 9, cy: 15.5, r: 5.5 },
    { kind: 'circle', cx: 13.5, cy: 11.5, r: 5.5 },
    { kind: 'circle', cx: 16.5, cy: 7, r: 4.2 },
  ],
  // Three stacked planks, each a separate rounded bar with a gap to the next
  // — reads as a small lumber stack rather than one solid block (a single
  // log read as "a cut log", not "wood" the buildable resource).
  wood: [
    { kind: 'rect', x: 2, y: 3, width: 20, height: 4.4, rx: 1.4 },
    { kind: 'rect', x: 3, y: 9.8, width: 18, height: 4.4, rx: 1.4 },
    { kind: 'rect', x: 2.5, y: 16.6, width: 19, height: 4.4, rx: 1.4 },
  ],
  // Three jagged, irregular boulders piled like the gold coins above —
  // angular contours instead of round ones so the silhouette itself reads
  // as "rocks", not just "circles in another colour".
  stone: [
    { kind: 'polygon', points: '2,19 1,13 6,8 12,9 13,15 9,20' },
    { kind: 'polygon', points: '10,20 9,13 15,7 21,10 21,17 16,21' },
    { kind: 'polygon', points: '9,10 8,5 13,3 17,5 16,10 12,12' },
  ],
}

/**
 * Fixed per-resource text colour (Tailwind arbitrary-value classes), applied
 * to the icon + amount together wherever an outcome preview is shown — gold
 * is gold, wood is brown, stone is grey, always, regardless of whether the
 * amount is a gain or a cost or the option is disabled (see HexBoard.tsx's
 * ActionMenuOption.outcome rendering). Previously the colour followed the
 * amount's sign (green gain / red cost), which meant the same resource
 * jumped between colours depending on context — this fixes each resource to
 * one identifiable colour instead, with the +/- sign on the number itself
 * still carrying the gain-vs-cost read.
 */
export const RESOURCE_COLOR_CLASS: Record<keyof Resources, string> = {
  gold: 'text-[#d4af37]',
  wood: 'text-[#8b5a2b]',
  stone: 'text-[#9ca3af]',
}

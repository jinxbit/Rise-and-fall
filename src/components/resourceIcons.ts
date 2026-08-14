import type { Resources } from '../engine/types'
import type { IconShape } from './unitIcons'

/**
 * One hand-drawn pictogram per resource kind, same 24x24 grid / IconShape
 * vocabulary as unitIcons.ts's UNIT_ICONS — the iconography an action's
 * outcome preview is built from (see HexBoard.tsx's ActionMenuOption.outcome
 * and ResourceIcon.tsx), so a Ship's Trade reads as "+15 (gold coin)"
 * instead of a bare, unit-less number.
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
  // A cut log — a rounded trunk with a round end-grain cap bulging past its
  // edge, mirroring unitIcons.ts's Nomad ears sticking out past its head.
  wood: [
    { kind: 'rect', x: 4, y: 10, width: 15, height: 7, rx: 3 },
    { kind: 'circle', cx: 17.5, cy: 13.5, r: 5.2 },
  ],
  // A single jagged boulder — irregular and angular, contrasting with
  // gold's round coins and wood's smooth-edged log.
  stone: [{ kind: 'polygon', points: '4,17 3,11 8,6 14,4 20,8 21,15 16,20 9,20' }],
}

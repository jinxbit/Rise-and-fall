import type { IconShape } from './unitIcons'
import { UNIT_ICONS } from './unitIcons'

/**
 * Standalone, inline rendering of a unit kind's pictogram (see
 * unitIcons.ts) for HTML flow contexts — the player status and
 * achievements displays — as opposed to HexBoard's own UnitGlyph, which is
 * positioned by pixel coordinates inside the board's SVG canvas. Fills
 * with `currentColor` so it inherits whatever text color its container
 * sets, unlike the board's fixed-contrast glyph-on-plate treatment.
 */
export function UnitIcon({ kind, className, title }: { kind: string; className?: string; title?: string }) {
  const shapes = UNIT_ICONS[kind] ?? []
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {shapes.map((shape: IconShape, i) => {
        switch (shape.kind) {
          case 'polygon':
            return <polygon key={i} points={shape.points} fill="currentColor" />
          case 'rect':
            return <rect key={i} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} fill="currentColor" />
          case 'path':
            return <path key={i} d={shape.d} fillRule={shape.fillRule} fill="currentColor" />
          case 'circle':
            return <circle key={i} cx={shape.cx} cy={shape.cy} r={shape.r} fill="currentColor" />
        }
      })}
    </svg>
  )
}

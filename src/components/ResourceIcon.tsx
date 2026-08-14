import type { Resources } from '../engine/types'
import type { IconShape } from './unitIcons'
import { RESOURCE_ICONS } from './resourceIcons'

/**
 * Standalone, inline rendering of a resource kind's pictogram (see
 * resourceIcons.ts) for HTML flow contexts — mirrors UnitIcon.tsx exactly,
 * just for the 3 resource kinds instead of unit kinds. Fills with
 * `currentColor` so it inherits whatever text color its container sets.
 */
export function ResourceIcon({ resource, className, title }: { resource: keyof Resources; className?: string; title?: string }) {
  const shapes = RESOURCE_ICONS[resource]
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

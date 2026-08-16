import { listMapTemplates } from '../content/resolveContent'

/**
 * Whether to use a pre set map is a single toggle, not a multi-choice list —
 * "Build interactively" (mapTemplateId === null) is the default and no
 * longer shown as an option here. Only one template (content/mapTemplates.json's
 * "classic") exists today, so toggling this on selects that one; if more
 * templates are added this'll need to become a proper picker again.
 */
export function MapTemplateSelector(props: { value: string | null; onChange: (mapTemplateId: string | null) => void }) {
  const templates = listMapTemplates()
  const template = templates[0]
  if (!template) return null

  const active = props.value === template.id

  return (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-left transition-colors ${
        active ? 'border-indigo-500 bg-indigo-500/10' : 'border-neutral-700 hover:border-neutral-500'
      }`}
    >
      <input
        type="checkbox"
        checked={active}
        onChange={(e) => props.onChange(e.target.checked ? template.id : null)}
        className="mt-1 h-4 w-4 rounded border-neutral-700 bg-neutral-900"
      />
      <div>
        <div className="font-medium">Pre set map</div>
        <div className="text-sm text-neutral-400">{template.description}</div>
      </div>
    </label>
  )
}

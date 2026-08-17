import { listTales } from '../content/resolveContent'

const CATEGORY_LABEL: Record<string, string> = {
  creature: 'Creature',
  buildable: 'Buildable',
  specialArea: 'Special area',
}

/**
 * Multi-select toggle list for the Tales variant (src/content/tales.json) —
 * each Tale is independently on/off, unlike MapModeSelector's single-choice
 * map-mode radios. "Randomize" is a convenience shuffle (each Tale
 * independently included at 50/50), not the rulebook's "draw one per
 * player" — that count depends on how many players actually join, which
 * isn't known yet at game-creation time (see CreateGamePage.tsx), and doesn't
 * mean much anyway while the catalog only has one Tale implemented.
 * Host-picking specific Tales (checking/unchecking directly) is the
 * primary flow; Randomize is just a starting point to react to.
 */
export function TaleSelector(props: { value: string[]; onChange: (taleIds: string[]) => void }) {
  const tales = listTales()
  const selected = new Set(props.value)

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    props.onChange([...next])
  }

  function randomize() {
    props.onChange(tales.filter(() => Math.random() < 0.5).map((t) => t.id))
  }

  if (tales.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-neutral-500">{selected.size === 0 ? 'None selected — base game rules' : `${selected.size} active`}</span>
        <div className="flex gap-3 text-xs">
          <button type="button" onClick={randomize} className="text-indigo-400 hover:text-indigo-300">
            Randomize
          </button>
          {selected.size > 0 && (
            <button type="button" onClick={() => props.onChange([])} className="text-neutral-500 hover:text-neutral-300">
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {tales.map((tale) => (
          <label
            key={tale.id}
            className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-left transition-colors ${
              selected.has(tale.id) ? 'border-indigo-500 bg-indigo-500/10' : 'border-neutral-700 hover:border-neutral-500'
            }`}
          >
            <input
              type="checkbox"
              checked={selected.has(tale.id)}
              onChange={() => toggle(tale.id)}
              className="mt-1 h-4 w-4 rounded border-neutral-700 bg-neutral-900"
            />
            <div>
              <div className="font-medium">
                {tale.number}. {tale.name}{' '}
                <span className="text-xs font-normal text-neutral-500">{CATEGORY_LABEL[tale.category] ?? tale.category}</span>
              </div>
              <div className="text-sm text-neutral-400">{tale.description}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  )
}

import { listMapTemplates } from '../content/resolveContent'

const RANDOM_OPTION = {
  value: null as string | null,
  label: 'Build interactively',
  description: 'Players place tiles and starting units together, one at a time, before the game begins.',
}

export function MapTemplateSelector(props: { value: string | null; onChange: (mapTemplateId: string | null) => void }) {
  const options = [RANDOM_OPTION, ...listMapTemplates().map((t) => ({ value: t.id as string | null, label: t.name, description: t.description }))]

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((option) => (
        <button
          key={option.value ?? 'interactive'}
          type="button"
          onClick={() => props.onChange(option.value)}
          className={`rounded-md border p-3 text-left transition-colors ${
            props.value === option.value
              ? 'border-indigo-500 bg-indigo-500/10'
              : 'border-neutral-700 hover:border-neutral-500'
          }`}
        >
          <div className="font-medium">{option.label}</div>
          <div className="text-sm text-neutral-400">{option.description}</div>
        </button>
      ))}
    </div>
  )
}

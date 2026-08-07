import type { PlayMode } from '../engine/types'

const OPTIONS: { value: PlayMode; label: string; description: string }[] = [
  { value: 'live', label: 'Live', description: 'Everyone online at once, moves sync in real time.' },
  { value: 'async', label: 'Play by turn', description: 'No need to be online together — play whenever it\'s your turn.' },
  { value: 'hotseat', label: 'Hotseat', description: 'Everyone in one room, sharing a single device.' },
]

export function PlayModeSelector(props: { value: PlayMode; onChange: (mode: PlayMode) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
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

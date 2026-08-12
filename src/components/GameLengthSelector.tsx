import { listGameLengthBounds } from '../content/resolveContent'

/** Only the game-length choices worth surfacing at creation time — content/achievements.json's gameLength.min/max (1-6) technically allows the full range, but 1-3 achievements ends the game too fast to be a real option. */
const OFFERED_LENGTHS = [4, 5, 6]

export function GameLengthSelector(props: { value: number; onChange: (gameLength: number) => void }) {
  const { default: defaultLength } = listGameLengthBounds()

  return (
    <div className="grid grid-cols-3 gap-2">
      {OFFERED_LENGTHS.map((length) => (
        <button
          key={length}
          type="button"
          onClick={() => props.onChange(length)}
          className={`rounded-md border p-3 text-center transition-colors ${
            props.value === length ? 'border-indigo-500 bg-indigo-500/10' : 'border-neutral-700 hover:border-neutral-500'
          }`}
        >
          <div className="font-medium">{length} Achievements</div>
          {length === defaultLength && <div className="text-sm text-neutral-400">Default</div>}
        </button>
      ))}
    </div>
  )
}

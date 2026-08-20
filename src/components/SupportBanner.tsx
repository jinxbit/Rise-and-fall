/** Referral banner pointing players to the official game website, Steam page, and BoardGameGeek listing. */
export function SupportBanner() {
  return (
    <div className="rounded-md bg-neutral-900 px-4 py-2 text-center text-sm text-neutral-400">
      Like this game? Support the creators:{' '}
      <a
        href="https://riseandfall.online/"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-neutral-200"
      >
        Website
      </a>{' '}
      ·{' '}
      <a
        href="https://store.steampowered.com/app/2956790/Rise__Fall__Online_Digital_Edition/"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-neutral-200"
      >
        Steam
      </a>{' '}
      ·{' '}
      <a
        href="https://boardgamegeek.com/boardgame/275912/rise-and-fall"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-neutral-200"
      >
        BoardGameGeek
      </a>
    </div>
  )
}

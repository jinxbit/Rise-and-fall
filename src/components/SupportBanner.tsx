/** Referral banner pointing players to the official game website, Steam page, Discord, and BoardGameGeek listing. */
export function SupportBanner() {
  return (
    <div className="rounded-md border border-amber-700/50 bg-amber-950/20 px-4 py-3 text-center text-sm text-amber-400">
      <p>Like this game?</p>
      <p>
        Play the beautiful digital implementation!{' '}
        <a
          href="https://riseandfall.online/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-amber-200"
        >
          Website
        </a>
        ,{' '}
        <a
          href="https://store.steampowered.com/app/2956790/Rise__Fall__Online_Digital_Edition/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-amber-200"
        >
          Steam
        </a>
        ,{' '}
        <a
          href="https://discord.gg/x7znCBrm"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-amber-200"
        >
          Discord
        </a>
      </p>
      <p>
        Check out the board game:{' '}
        <a
          href="https://boardgamegeek.com/boardgame/275912/rise-and-fall"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-amber-200"
        >
          BoardGameGeek
        </a>
      </p>
    </div>
  )
}

/** Referral banner pointing players to the official game website, Steam page, and BoardGameGeek listing. */
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

/** Banner inviting players to this app's official Discord server to discuss the game and report bugs. */
export function DiscordCommunityBanner() {
  return (
    <div className="rounded-md border border-indigo-700/50 bg-indigo-950/20 px-4 py-3 text-center text-sm text-indigo-400">
      <p>This game is still in alpha.</p>
      <p>
        Join our official{' '}
        <a
          href="https://discord.gg/Y9zXjWw7X9"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-indigo-200"
        >
          Discord channel
        </a>{' '}
        to discuss the game and report bugs.
      </p>
    </div>
  )
}

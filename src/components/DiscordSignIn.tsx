import { signInWithDiscord } from '../lib/auth'

export function DiscordSignIn() {
  return (
    <button
      onClick={() => void signInWithDiscord()}
      className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500"
    >
      Sign in with Discord
    </button>
  )
}

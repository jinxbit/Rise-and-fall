import { signInWithDiscord } from '../lib/auth'

export function DiscordSignIn({ onError }: { onError?: (message: string) => void }) {
  async function handleClick() {
    try {
      await signInWithDiscord()
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Failed to sign in with Discord')
    }
  }

  return (
    <button
      onClick={() => void handleClick()}
      className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500"
    >
      Sign in with Discord
    </button>
  )
}

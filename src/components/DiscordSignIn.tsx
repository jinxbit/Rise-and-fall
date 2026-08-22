import { signInWithDiscord } from '../lib/auth'
import { toAppError, type AppError } from '../lib/errors'

export function DiscordSignIn({ onError }: { onError?: (error: AppError) => void }) {
  async function handleClick() {
    try {
      await signInWithDiscord()
    } catch (err) {
      onError?.(toAppError(err, 'Failed to sign in with Discord'))
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

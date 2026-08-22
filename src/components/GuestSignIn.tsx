import { signInAsGuest } from '../lib/auth'
import { toAppError, type AppError } from '../lib/errors'

/** Only render when VITE_ALLOW_GUEST_AUTH is set — see src/lib/auth.ts. */
export function GuestSignIn({ onError }: { onError?: (error: AppError) => void }) {
  async function handleClick() {
    try {
      await signInAsGuest()
    } catch (err) {
      onError?.(toAppError(err, 'Failed to sign in as guest'))
    }
  }

  return (
    <button
      onClick={() => void handleClick()}
      className="inline-flex items-center gap-2 rounded-md border border-neutral-700 px-4 py-2 font-medium text-neutral-300 hover:border-neutral-500 hover:text-white"
    >
      Continue as guest (testing)
    </button>
  )
}

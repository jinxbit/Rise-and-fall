import { signInWithGoogle } from '../lib/auth'
import { toAppError, type AppError } from '../lib/errors'

export function GoogleSignIn({ onError }: { onError?: (error: AppError) => void }) {
  async function handleClick() {
    try {
      await signInWithGoogle()
    } catch (err) {
      onError?.(toAppError(err, 'Failed to sign in with Google'))
    }
  }

  return (
    <button
      onClick={() => void handleClick()}
      className="inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-white px-4 py-2 font-medium text-neutral-900 hover:bg-neutral-100"
    >
      Sign in with Google
    </button>
  )
}

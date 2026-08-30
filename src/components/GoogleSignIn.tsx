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
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M23.52 12.273c0-.851-.076-1.67-.217-2.455H12v4.645h6.458c-.28 1.5-1.128 2.77-2.402 3.622v3.011h3.89c2.276-2.096 3.588-5.183 3.588-8.823Z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.956-1.075 7.942-2.905l-3.89-3.01c-1.078.723-2.458 1.15-4.052 1.15-3.118 0-5.758-2.104-6.702-4.933H1.28v3.104C3.256 21.31 7.31 24 12 24Z"
        />
        <path
          fill="#FBBC05"
          d="M5.298 14.302A7.2 7.2 0 0 1 4.909 12c0-.799.137-1.575.38-2.302V6.594H1.28A11.98 11.98 0 0 0 0 12c0 1.936.464 3.769 1.28 5.406l4.018-3.104Z"
        />
        <path
          fill="#EA4335"
          d="M12 4.773c1.762 0 3.344.606 4.588 1.795l3.44-3.44C17.951 1.19 15.235 0 12 0 7.31 0 3.256 2.69 1.28 6.594l4.018 3.104C6.242 6.87 8.882 4.773 12 4.773Z"
        />
      </svg>
      Sign in with Google
    </button>
  )
}

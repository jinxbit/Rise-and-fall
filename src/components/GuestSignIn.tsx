import { signInAsGuest } from '../lib/auth'

/** Only render when VITE_ALLOW_GUEST_AUTH is set — see src/lib/auth.ts. */
export function GuestSignIn() {
  return (
    <button
      onClick={() => void signInAsGuest()}
      className="inline-flex items-center gap-2 rounded-md border border-neutral-700 px-4 py-2 font-medium text-neutral-300 hover:border-neutral-500 hover:text-white"
    >
      Continue as guest (testing)
    </button>
  )
}

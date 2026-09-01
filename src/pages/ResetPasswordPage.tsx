import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorBanner } from '../components/ErrorBanner'
import { useAuth } from '../hooks/useAuth'
import { updatePassword } from '../lib/auth'
import { simpleError, toAppError, type AppError } from '../lib/errors'

/**
 * Landing page for the "forgot password" email link (issue #386). Supabase's
 * redirect carries a recovery token in the URL that the client picks up
 * automatically (`detectSessionInUrl`, on by default) and turns into a
 * short-lived session — `updatePassword` just needs *some* active session,
 * so this page doesn't need to see or parse the token itself.
 */
export function ResetPasswordPage() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError(simpleError('Passwords do not match.'))
      return
    }

    setBusy(true)
    try {
      await updatePassword(password)
      setDone(true)
    } catch (err) {
      setError(toAppError(err, 'Failed to update password'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-3xl font-semibold">Reset your password</h1>

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : !session ? (
        <p className="max-w-sm text-neutral-400">
          This reset link is invalid or has expired. Request a new one from the sign-in page.
        </p>
      ) : done ? (
        <>
          <p className="max-w-sm text-neutral-400">Your password has been updated.</p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-md border border-neutral-700 px-4 py-2 font-medium hover:border-neutral-500"
          >
            Continue
          </button>
        </>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} className="flex w-full max-w-xs flex-col gap-2">
          {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="New password"
            minLength={6}
            disabled={busy}
            required
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 disabled:opacity-50"
          />
          <input
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            type="password"
            placeholder="Confirm new password"
            minLength={6}
            disabled={busy}
            required
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md border border-neutral-700 px-4 py-2 font-medium hover:border-neutral-500 disabled:opacity-50"
          >
            Set new password
          </button>
        </form>
      )}
    </div>
  )
}

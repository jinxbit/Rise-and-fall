import { useState } from 'react'
import { requestPasswordReset, signInWithEmail, signUpWithEmail } from '../lib/auth'
import { simpleError, toAppError, type AppError } from '../lib/errors'

type Mode = 'signIn' | 'signUp' | 'forgotPassword'

/**
 * Email/password sign-in and registration (issue #384), plus "forgot
 * password" (issue #386) — an alternative to Discord/Google OAuth for
 * players who'd rather not link a third-party account. Toggles between
 * modes in place; sign-up additionally collects a username, which becomes
 * the account's display name (see signUpWithEmail). Forgot-password only
 * needs the email field and hands off to ResetPasswordPage via the emailed
 * link (see requestPasswordReset).
 */
export function EmailPasswordAuth({ onError }: { onError?: (error: AppError | null) => void }) {
  const [mode, setMode] = useState<Mode>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  function switchMode(next: Mode) {
    setMode(next)
    setNotice(null)
    onError?.(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setNotice(null)
    onError?.(null)

    if (mode === 'signUp' && username.trim().length === 0) {
      onError?.(simpleError('Enter a username.'))
      return
    }

    setBusy(true)
    try {
      if (mode === 'signUp') {
        const { needsEmailConfirmation } = await signUpWithEmail(email.trim(), password, username.trim())
        if (needsEmailConfirmation) {
          setNotice('Check your email to confirm your account before signing in.')
        }
      } else if (mode === 'forgotPassword') {
        await requestPasswordReset(email.trim())
        setNotice('Check your email for a password reset link.')
      } else {
        await signInWithEmail(email.trim(), password)
      }
    } catch (err) {
      onError?.(
        toAppError(
          err,
          mode === 'signUp' ? 'Failed to register' : mode === 'forgotPassword' ? 'Failed to send reset email' : 'Failed to sign in',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex w-full max-w-xs flex-col gap-2">
      {mode === 'signUp' && (
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          maxLength={40}
          disabled={busy}
          required
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 disabled:opacity-50"
        />
      )}
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        placeholder="Email"
        disabled={busy}
        required
        className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 disabled:opacity-50"
      />
      {mode !== 'forgotPassword' && (
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="Password"
          minLength={6}
          disabled={busy}
          required
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 disabled:opacity-50"
        />
      )}
      {notice && <p className="text-sm text-neutral-400">{notice}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md border border-neutral-700 px-4 py-2 font-medium hover:border-neutral-500 disabled:opacity-50"
      >
        {mode === 'signUp' ? 'Create account' : mode === 'forgotPassword' ? 'Send reset link' : 'Sign in'}
      </button>
      {mode === 'signIn' && (
        <button
          type="button"
          onClick={() => switchMode('forgotPassword')}
          disabled={busy}
          className="text-sm text-neutral-400 underline hover:text-neutral-200 disabled:opacity-50"
        >
          Forgot password?
        </button>
      )}
      <button
        type="button"
        onClick={() => switchMode(mode === 'signUp' ? 'signIn' : mode === 'forgotPassword' ? 'signIn' : 'signUp')}
        disabled={busy}
        className="text-sm text-neutral-400 underline hover:text-neutral-200 disabled:opacity-50"
      >
        {mode === 'signUp' ? 'Already have an account? Sign in' : mode === 'forgotPassword' ? 'Back to sign in' : "Don't have an account? Register"}
      </button>
    </form>
  )
}

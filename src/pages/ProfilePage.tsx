import { Link } from 'react-router-dom'
import { DiscordWebhookSettings } from '../components/DiscordWebhookSettings'
import { DisplayNameSettings } from '../components/DisplayNameSettings'
import { PushNotificationSettings } from '../components/PushNotificationSettings'
import { useAuth } from '../hooks/useAuth'
import { useDisplayName } from '../hooks/useDisplayName'
import { signOut } from '../lib/auth'
import { resolveDisplayName } from '../lib/displayName'

export function ProfilePage() {
  const { session, loading } = useAuth()
  const {
    profileDisplayName,
    loading: displayNameLoading,
    setProfileDisplayName,
  } = useDisplayName(session?.user ?? null)

  if (loading) return <div className="p-8 text-neutral-400">Loading…</div>

  if (!session) {
    return (
      <div className="p-8 text-neutral-400">
        <Link to="/" className="underline hover:text-neutral-200">
          Sign in
        </Link>{' '}
        to edit your profile.
      </div>
    )
  }

  const user = session.user
  const discordName = resolveDisplayName(user, null)

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Profile</h1>
        <div className="flex items-center gap-3 text-sm text-neutral-400">
          <Link to="/" className="underline hover:text-neutral-200">
            Home
          </Link>
          <Link to="/games" className="underline hover:text-neutral-200">
            My games
          </Link>
          <button onClick={() => void signOut()} className="underline hover:text-neutral-200">
            Sign out
          </button>
        </div>
      </header>

      <DisplayNameSettings
        userId={user.id}
        value={profileDisplayName}
        fallback={discordName}
        loading={displayNameLoading}
        onSaved={setProfileDisplayName}
      />

      <DiscordWebhookSettings user={user} />

      <PushNotificationSettings user={user} />
    </div>
  )
}

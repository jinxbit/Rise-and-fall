// Chat, phase 2 (issue #564, CHAT_PLAN.md §6) and phase 3 (issue #565, §6/§11.3).
// One shared component for both surfaces: site-wide (`gameId: null`, wired
// into HomePage.tsx) and in-game (a real `gameId`, wired into GamePage.tsx,
// `compact` + `canPost`).

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useDisplayName } from '../hooks/useDisplayName'
import { getChatDisplayNames, isChatEnabled, listChatMessages, postChatMessage, subscribeToChatMessages } from '../lib/chatApi'
import type { ChatMessageRow } from '../lib/dbTypes'
import { toAppError, type AppError } from '../lib/errors'
import { ErrorBanner } from './ErrorBanner'

interface ChatPanelProps {
  /** null = site-wide chat; a game id = that game's chat (CHAT_PLAN.md §3). */
  gameId: string | null
  /**
   * Starts collapsed (list + composer hidden behind a Show/Hide toggle) and
   * shows that toggle at all — issue #565: a chat panel pinned above the
   * board would otherwise push the board below the fold on a phone, the same
   * problem the mobile pass already solved for GamePage's history bar
   * (`isReviewingHistory`/`reviewIndex`, `todo.md` #69) by keeping it as
   * ordinary page-local state rather than inventing persistence — this
   * follows the same approach: `collapsed` lives only in this component's
   * state for as long as it's mounted, reset on remount like every other
   * page-local UI toggle in this codebase. Site-wide chat (HomePage.tsx)
   * omits this prop and is never collapsible. The Realtime subscription and
   * message list stay live while collapsed; only the JSX is hidden.
   */
  compact?: boolean
  /**
   * Whether the signed-in viewer may post here at all — false for a
   * signed-in non-seated visitor to a `visibility: 'public'` game
   * (CHAT_PLAN.md §10.1, enforced server-side by the "post chat" RLS
   * policy). The composer is replaced with an explanation instead of being
   * left to fail on submit with a raw RLS error. Always true for site-wide
   * chat, where posting only ever requires a session.
   */
  canPost?: boolean
}

/**
 * Renders nothing at all when the kill switch is off or there is no session
 * (CHAT_PLAN.md §4/§6) — a normal user must see no trace of the feature.
 * Append-only: no edit, delete, reactions, typing indicators, or attachments
 * (§2, "out of scope"). Manages its own auth/kill-switch state internally so
 * a caller only ever has to pass `gameId`.
 */
export function ChatPanel({ gameId, compact = false, canPost = true }: ChatPanelProps) {
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const { displayName: ownDisplayName } = useDisplayName(session?.user ?? null)

  const [enabled, setEnabled] = useState(false)
  const [messages, setMessages] = useState<ChatMessageRow[] | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [collapsed, setCollapsed] = useState(compact)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    isChatEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value)
      })
      .catch(() => {
        if (!cancelled) setEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!enabled || !userId) return
    let cancelled = false
    async function load() {
      try {
        const rows = await listChatMessages(gameId)
        if (cancelled) return
        setMessages(rows)
        const fetchedNames = await getChatDisplayNames(rows.map((row) => row.sender_id))
        if (!cancelled) setNames((prev) => ({ ...prev, ...fetchedNames }))
      } catch (err) {
        if (!cancelled) setError(toAppError(err, 'Failed to load chat'))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [enabled, userId, gameId])

  useEffect(() => {
    if (!enabled || !userId) return
    return subscribeToChatMessages(gameId, (message) => {
      setMessages((prev) => [...(prev ?? []), message])
      void getChatDisplayNames([message.sender_id])
        .then((fetched) => setNames((prev) => ({ ...prev, ...fetched })))
        .catch(() => {})
    })
  }, [enabled, userId, gameId])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages])

  if (!enabled || !session || !userId) return null
  const uid = userId

  function nameFor(senderId: string): string {
    if (senderId === uid) return ownDisplayName || 'Player'
    return names[senderId] ?? 'Player'
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const body = draft.trim()
    if (!body) return
    setSending(true)
    setError(null)
    try {
      await postChatMessage(gameId, uid, body)
      setDraft('')
    } catch (err) {
      setError(toAppError(err, 'Failed to send message'))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-300">Chat</h2>
        {compact && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            className="text-xs font-medium text-neutral-400 hover:text-neutral-200"
          >
            {collapsed ? 'Show chat' : 'Hide chat'}
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          {error && <ErrorBanner message={error.message} details={error.details} onDismiss={() => setError(null)} />}
          <div ref={listRef} className="flex max-h-48 flex-col gap-1 overflow-y-auto text-sm">
            {messages === null && <p className="text-neutral-500">Loading chat…</p>}
            {messages !== null && messages.length === 0 && <p className="text-neutral-500">No messages yet.</p>}
            {messages?.map((message) => (
              <p key={message.id}>
                <span className="font-medium text-neutral-300">{nameFor(message.sender_id)}:</span>{' '}
                <span className="text-neutral-200">{message.body}</span>
              </p>
            ))}
          </div>
          {canPost ? (
            <form onSubmit={(e) => void handleSubmit(e)} className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Message"
                maxLength={2000}
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm"
              />
              <button
                type="submit"
                disabled={sending || draft.trim().length === 0}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm font-medium hover:border-neutral-500 disabled:opacity-50"
              >
                Send
              </button>
            </form>
          ) : (
            <p className="text-xs text-neutral-500">Only seated players can post in this game's chat.</p>
          )}
        </>
      )}
    </section>
  )
}

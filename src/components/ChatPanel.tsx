// Chat, phase 2 (issue #564, CHAT_PLAN.md §6). One shared component for both
// surfaces: site-wide (`gameId: null`, wired into HomePage.tsx here) and
// in-game (a real `gameId`, phase 3 — issue #565 — reuses this unchanged).

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
}

/**
 * Renders nothing at all when the kill switch is off or there is no session
 * (CHAT_PLAN.md §4/§6) — a normal user must see no trace of the feature.
 * Append-only: no edit, delete, reactions, typing indicators, or attachments
 * (§2, "out of scope"). Manages its own auth/kill-switch state internally so
 * a caller only ever has to pass `gameId`.
 */
export function ChatPanel({ gameId }: ChatPanelProps) {
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const { displayName: ownDisplayName } = useDisplayName(session?.user ?? null)

  const [enabled, setEnabled] = useState(false)
  const [messages, setMessages] = useState<ChatMessageRow[] | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
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
      <h2 className="text-sm font-medium text-neutral-300">Chat</h2>
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
    </section>
  )
}

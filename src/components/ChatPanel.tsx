// Chat, phase 2 (issue #564, CHAT_PLAN.md §6), phase 3 (issue #565,
// §6/§11.3) and the unread indicator (issue #579, CHAT_PLAN.md §13, in-game
// chat only). One shared component for both surfaces: site-wide
// (`gameId: null`, wired into HomePage.tsx) and in-game (a real `gameId`,
// wired into GamePage.tsx, `compact` + `canPost`).

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useDisplayName } from '../hooks/useDisplayName'
import { getChatDisplayNames, getChatReadStatus, isChatEnabled, listChatMessages, markChatRead, postChatMessage, subscribeToChatMessages } from '../lib/chatApi'
import type { ChatMessageRow } from '../lib/dbTypes'
import { toAppError, type AppError } from '../lib/errors'
import { ErrorBanner } from './ErrorBanner'

/** How long a locally-advanced read cursor waits before it's written to `chat_read_status`, absent an earlier flush (collapse, tab hidden/blurred, unmount) — CHAT_PLAN.md §13's "debounce writes ... every few seconds while open, not on every message." */
const MARK_READ_DEBOUNCE_MS = 3000

function formatUnreadBadge(count: number): string {
  return count > 9 ? '9+' : String(count)
}

/** Page Visibility API + focus check (CHAT_PLAN.md §13) — "open and visible" gates whether newly-seen messages advance the read cursor at all. */
function isPageVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
}

interface ChatPanelProps {
  /**
   * null = site-wide chat; a game id = that game's chat (CHAT_PLAN.md §3).
   * Unread tracking (§13) only applies when this is a game id — site-wide
   * chat never gets a badge or divider.
   */
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

  // Unread tracking (CHAT_PLAN.md §13) — in-game chat only (`gameId` set).
  // The site-wide channel (`gameId: null`) never fetches or writes a read
  // cursor and never shows a badge or divider; every effect below is a
  // no-op for it. `lastReadId` is the live cursor — it only ever advances
  // while the panel is open and the tab is visible, and drives the unread
  // badge. `readBoundaryId` freezes at whatever `lastReadId` was when this
  // component mounted, and only that frozen value positions the "new
  // messages" divider — it deliberately doesn't move as the user reads
  // further within the same mount, the same "resets only on remount, not
  // on every toggle" posture `collapsed` itself already documents above.
  const [lastReadId, setLastReadId] = useState<number | null>(null)
  const [readBoundaryId, setReadBoundaryId] = useState<number | null>(null)
  const [readStatusLoaded, setReadStatusLoaded] = useState(false)
  const [pageVisible, setPageVisible] = useState(isPageVisible)
  const flushTimerRef = useRef<number | undefined>(undefined)
  const pendingReadRef = useRef<{ gameId: string; userId: string; lastReadId: number } | null>(null)

  function flushRead() {
    if (flushTimerRef.current !== undefined) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = undefined
    }
    const pending = pendingReadRef.current
    pendingReadRef.current = null
    if (!pending) return
    void markChatRead(pending.gameId, pending.userId, pending.lastReadId).catch(() => {})
  }

  function scheduleRead(pendingGameId: string, pendingUserId: string, pendingLastReadId: number) {
    pendingReadRef.current = { gameId: pendingGameId, userId: pendingUserId, lastReadId: pendingLastReadId }
    if (flushTimerRef.current !== undefined) return
    flushTimerRef.current = window.setTimeout(flushRead, MARK_READ_DEBOUNCE_MS)
  }

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
    const uid = userId
    let cancelled = false
    async function load() {
      try {
        const [rows, readStatus] = await Promise.all([listChatMessages(gameId), gameId === null ? Promise.resolve(null) : getChatReadStatus(gameId, uid)])
        if (cancelled) return
        setMessages(rows)
        const fetchedNames = await getChatDisplayNames(rows.map((row) => row.sender_id))
        if (!cancelled) setNames((prev) => ({ ...prev, ...fetchedNames }))

        if (gameId === null) {
          // Site-wide chat tracks no read cursor at all (CHAT_PLAN.md §13) —
          // lastReadId/readBoundaryId stay null forever, which keeps the
          // badge and divider off further down.
          if (!cancelled) setReadStatusLoaded(true)
          return
        }

        if (readStatus) {
          setLastReadId(readStatus.last_read_id)
          setReadBoundaryId(readStatus.last_read_id)
        } else {
          // First time this user has ever opened this game's chat —
          // CHAT_PLAN.md §13's "new player joins mid-game" edge case: treat
          // everything that already existed as read rather than dumping the
          // whole channel history into the unread badge.
          const latestId = rows.length > 0 ? rows[rows.length - 1].id : 0
          setLastReadId(latestId)
          setReadBoundaryId(latestId)
          void markChatRead(gameId, uid, latestId).catch(() => {})
        }
        if (!cancelled) setReadStatusLoaded(true)
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
    function update() {
      setPageVisible(isPageVisible())
    }
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  // Advances the read cursor while the panel is open and the tab is
  // visible/focused — CHAT_PLAN.md §13: "mark read when the chat panel is
  // both open and the tab is visible." A closed or backgrounded panel still
  // receives new messages via the Realtime subscription below (so the
  // unread badge keeps counting up), it just doesn't advance or persist the
  // cursor until it's actually looked at.
  useEffect(() => {
    if (!enabled || !userId || gameId === null || collapsed || !pageVisible || !readStatusLoaded) return
    if (!messages || messages.length === 0) return
    const latestId = messages[messages.length - 1].id
    setLastReadId((prev) => {
      if (prev !== null && latestId <= prev) return prev
      scheduleRead(gameId, userId, latestId)
      return latestId
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId, collapsed, pageVisible, messages, gameId, readStatusLoaded])

  useEffect(() => {
    if (collapsed || !pageVisible) flushRead()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, pageVisible])

  useEffect(() => {
    return () => flushRead()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Unread badge (numeric, capped at "9+" per CHAT_PLAN.md §13) — how many
  // loaded messages are newer than the live read cursor. Messages beyond
  // CHAT_PAGE_SIZE aren't loaded at all (chatApi.ts's listChatMessages has
  // no older-history paging yet), but that only matters once the true count
  // already exceeds the "9+" cap, so it never under-displays. `lastReadId`
  // stays null forever for site-wide chat (gameId === null, see the load
  // effect above), so this is always 0 there and the badge never renders.
  const unreadCount = messages === null || lastReadId === null ? 0 : messages.filter((message) => message.id > lastReadId).length
  // "New messages" divider position — the first loaded message newer than
  // the cursor as it stood when this component mounted (readBoundaryId),
  // not the live one, so the divider stays put while the user reads rather
  // than chasing the cursor up the list.
  const dividerIndex = messages !== null && readBoundaryId !== null ? messages.findIndex((message) => message.id > readBoundaryId) : -1

  return (
    <section className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium text-neutral-300">
          Chat
          {unreadCount > 0 && (
            <span className="rounded-full bg-sky-600 px-1.5 py-0.5 text-xs font-semibold leading-none text-white" aria-label={`${unreadCount} unread message${unreadCount === 1 ? '' : 's'}`}>
              {formatUnreadBadge(unreadCount)}
            </span>
          )}
        </h2>
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
            {messages?.map((message, index) => (
              <div key={message.id}>
                {index === dividerIndex && (
                  <div className="my-1 flex items-center gap-2 text-xs text-sky-500" role="separator">
                    <span className="h-px flex-1 bg-sky-800" />
                    New messages
                    <span className="h-px flex-1 bg-sky-800" />
                  </div>
                )}
                <p>
                  <span className="font-medium text-neutral-300">{nameFor(message.sender_id)}:</span>{' '}
                  <span className="text-neutral-200">{message.body}</span>
                </p>
              </div>
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

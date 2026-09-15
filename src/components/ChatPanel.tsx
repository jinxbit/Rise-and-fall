// Chat, phase 2 (issue #564, CHAT_PLAN.md §6), phase 3 (issue #565,
// §6/§11.3), the unread indicator (issue #579, CHAT_PLAN.md §13, in-game
// chat only), its position/size (issue #580, §14), name coloring (issue
// #581, §15), its typewriter look + older-history paging (issue #587,
// §16) and the content text size increase (issue #593, §17). One shared
// component for both surfaces: site-wide (`gameId: null`, wired into
// HomePage.tsx, permanently expanded via the `compact`/`open` defaults)
// and in-game (a real `gameId`, wired into GamePage.tsx, `canPost` plus a
// controlled `open` + `onUnreadCountChange` so GamePage's own header
// button drives visibility).

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type UIEvent } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useDisplayName } from '../hooks/useDisplayName'
import { hashDisplayNameToColor } from '../lib/chatColors'
import {
  CHAT_PAGE_SIZE,
  formatUnreadBadge,
  getChatDisplayNames,
  getChatReadStatus,
  isChatEnabled,
  listChatMessages,
  listOlderChatMessages,
  markChatRead,
  postChatMessage,
  subscribeToChatMessages,
} from '../lib/chatApi'
import type { ChatMessageRow, PlayerRow } from '../lib/dbTypes'
import { toAppError, type AppError } from '../lib/errors'
import { ErrorBanner } from './ErrorBanner'

/** Scrolled within this many pixels of the top triggers an older-history fetch; of the bottom counts as "still following the conversation" for the auto-scroll-to-bottom below (issue #587, CHAT_PLAN.md §16). */
const SCROLL_EDGE_THRESHOLD_PX = 40

/** How long a locally-advanced read cursor waits before it's written to `chat_read_status`, absent an earlier flush (collapse, tab hidden/blurred, unmount) — CHAT_PLAN.md §13's "debounce writes ... every few seconds while open, not on every message." */
const MARK_READ_DEBOUNCE_MS = 3000

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
   * This game's seated players (issue #581, CHAT_PLAN.md §15) — used only to
   * color a sender's name with their seat's `PlayerRow.color`, the same
   * lookup RoundView.tsx's PlayerColorName/LogPlayerName already use.
   * Omitted for site-wide chat (`gameId: null`), which has no seats and
   * colors names by a hash of the display name instead (chatColors.ts).
   */
  players?: PlayerRow[]
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
  /**
   * Externally-controlled visibility (issue #580) — when passed, this
   * replaces `compact`'s own internal collapsed state entirely: the panel
   * hides its own heading/badge/Show-Hide toggle and instead renders nothing
   * at all while `open` is false, on the assumption the caller renders its
   * own toggle button (with its own badge, fed by `onUnreadCountChange`)
   * somewhere else in the page. The component stays mounted regardless, so
   * its Realtime subscription and unread-cursor tracking keep running while
   * hidden — same "collapsed but still live" behavior `compact` already had,
   * just with the chrome moved out. Undefined (the default) keeps the
   * original self-contained `compact` toggle for the site-wide caller that
   * doesn't pass it.
   */
  open?: boolean
  /**
   * Fires whenever the unread count changes (issue #580) — lets a caller
   * that supplies `open` show a matching badge on its own external toggle
   * button. Never called for site-wide chat, which never has an unread
   * count (§13).
   */
  onUnreadCountChange?: (count: number) => void
}

/**
 * Renders nothing at all when the kill switch is off or there is no session
 * (CHAT_PLAN.md §4/§6) — a normal user must see no trace of the feature.
 * Append-only: no edit, delete, reactions, typing indicators, or attachments
 * (§2, "out of scope"). Manages its own auth/kill-switch state internally so
 * a caller only ever has to pass `gameId`.
 */
export function ChatPanel({ gameId, players, compact = false, canPost = true, open, onUnreadCountChange }: ChatPanelProps) {
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const { displayName: ownDisplayName } = useDisplayName(session?.user ?? null)

  const [enabled, setEnabled] = useState(false)
  const [messages, setMessages] = useState<ChatMessageRow[] | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [internalCollapsed, setInternalCollapsed] = useState(compact)
  const controlled = open !== undefined
  const collapsed = controlled ? !open : internalCollapsed
  const listRef = useRef<HTMLDivElement>(null)

  // Older-history paging (issue #587, CHAT_PLAN.md §16) — `listChatMessages`
  // only ever loads the most recent CHAT_PAGE_SIZE rows; scrolling to the top
  // of the list fetches the page before whatever's currently oldest.
  // `hasOlder` starts optimistic (true) and flips false as soon as a page —
  // the initial one or an older one — comes back shorter than a full page,
  // meaning there's nothing left before it.
  const [hasOlder, setHasOlder] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Guards against a burst of scroll events firing `loadOlderMessages`
  // several times before the `loadingOlder` state update from the first call
  // has committed — a plain state read in the handler would still see `false`
  // for all of them.
  const loadingOlderRef = useRef(false)
  // Set just before an older page is spliced into `messages`, to the list's
  // scrollHeight at that moment; the layout effect below reads it to hold the
  // viewport steady on the same messages instead of snapping to the bottom.
  const prevScrollHeightRef = useRef<number | null>(null)
  // Whether the viewer was already within SCROLL_EDGE_THRESHOLD_PX of the
  // bottom before this render's messages changed — only then does a newly
  // arrived message auto-scroll the view, the same "don't yank someone back
  // down while they're reading history" rule most chat UIs use. Starts true
  // so the very first load lands scrolled to the newest message.
  const nearBottomRef = useRef(true)

  // Unread tracking (CHAT_PLAN.md §13) — in-game chat only (`gameId` set).
  // The site-wide channel (`gameId: null`) never fetches or writes a read
  // cursor and never shows a badge or divider; every effect below is a
  // no-op for it. `lastReadId` is the live cursor — it only ever advances
  // while the panel is open and the tab is visible, and drives the unread
  // badge. `readBoundaryId`/`readBoundaryTopId` bracket the "new messages"
  // divider: they snapshot whatever `lastReadId` and the latest loaded
  // message id were at the moment the panel most recently transitioned
  // from closed/hidden to open+visible (see the boundary-snapshot effect
  // below), not just once at mount — `GamePage` keeps this component
  // mounted across many open/close cycles (issue #580), so a one-time
  // snapshot would go stale after the first cycle. Capping at
  // `readBoundaryTopId` (issue #586) is what keeps a message that arrives
  // *after* that transition — while the panel is still open and being
  // watched live — from also being flagged new.
  const [lastReadId, setLastReadId] = useState<number | null>(null)
  const [readBoundaryId, setReadBoundaryId] = useState<number | null>(null)
  const [readBoundaryTopId, setReadBoundaryTopId] = useState<number | null>(null)
  const [readStatusLoaded, setReadStatusLoaded] = useState(false)
  const [pageVisible, setPageVisible] = useState(isPageVisible)
  const flushTimerRef = useRef<number | undefined>(undefined)
  const pendingReadRef = useRef<{ gameId: string; userId: string; lastReadId: number } | null>(null)
  // Edge-detects the closed/hidden → open+visible transition the boundary
  // snapshot below fires on, and forces a re-snapshot on a game switch
  // (this component isn't remounted when `gameId` changes either).
  const activeRef = useRef<{ gameId: string | null; active: boolean }>({ gameId: null, active: false })

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
    setHasOlder(true)
    nearBottomRef.current = true
    async function load() {
      try {
        const [rows, readStatus] = await Promise.all([listChatMessages(gameId), gameId === null ? Promise.resolve(null) : getChatReadStatus(gameId, uid)])
        if (cancelled) return
        setMessages(rows)
        setHasOlder(rows.length >= CHAT_PAGE_SIZE)
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
        } else {
          // First time this user has ever opened this game's chat —
          // CHAT_PLAN.md §13's "new player joins mid-game" edge case: treat
          // everything that already existed as read rather than dumping the
          // whole channel history into the unread badge.
          const latestId = rows.length > 0 ? rows[rows.length - 1].id : 0
          setLastReadId(latestId)
          void markChatRead(gameId, uid, latestId).catch(() => {})
        }
        // Force the boundary-snapshot effect below to re-fire for this game
        // even if the panel was already open+visible for a *previous* game
        // (this component isn't remounted on a game switch).
        activeRef.current = { gameId, active: false }
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

  // Snapshots the "new messages" divider's bounds on the closed/hidden →
  // open+visible edge (issue #586) — `readBoundaryId` (the pre-existing read
  // cursor) and `readBoundaryTopId` (the newest message id already loaded)
  // together bracket exactly the backlog that was unread *before* this
  // viewing started. Declared ahead of the read-cursor-advance effect below
  // so it reads `lastReadId`'s pre-advance value in the same commit. Once
  // `activeRef` records the transition, further renders while the panel
  // stays open (messages/lastReadId still changing) don't re-snapshot, so a
  // message that arrives afterward — from anyone, including a reply the
  // viewer sends themselves — falls above `readBoundaryTopId` and is never
  // flagged new; see `dividerIndex` below.
  useEffect(() => {
    if (gameId === null || !readStatusLoaded) return
    const isActive = !collapsed && pageVisible
    const prior = activeRef.current
    if (isActive && (prior.gameId !== gameId || !prior.active)) {
      setReadBoundaryId(lastReadId)
      setReadBoundaryTopId(messages && messages.length > 0 ? messages[messages.length - 1].id : lastReadId)
    }
    activeRef.current = { gameId, active: isActive }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, readStatusLoaded, collapsed, pageVisible, lastReadId, messages])

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

  // Keeps the message list usable while scrolled up reading history (issue
  // #587): an older page spliced onto the front holds the viewport on the
  // same messages (restored from the pre-splice scrollHeight recorded by
  // `loadOlderMessages` below) instead of jumping; anything else — the
  // initial load, a new message arriving — only snaps to the bottom if the
  // viewer was already there, so it never yanks someone back down mid-scroll.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (prevScrollHeightRef.current !== null) {
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current
      prevScrollHeightRef.current = null
      return
    }
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  function handleListScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_EDGE_THRESHOLD_PX
    if (el.scrollTop < SCROLL_EDGE_THRESHOLD_PX) void loadOlderMessages()
  }

  async function loadOlderMessages() {
    if (!messages || messages.length === 0 || loadingOlderRef.current || !hasOlder) return
    const oldestId = messages[0].id
    loadingOlderRef.current = true
    setLoadingOlder(true)
    prevScrollHeightRef.current = listRef.current ? listRef.current.scrollHeight : null
    try {
      const older = await listOlderChatMessages(gameId, oldestId)
      if (older.length < CHAT_PAGE_SIZE) setHasOlder(false)
      if (older.length > 0) {
        setMessages((prev) => [...older, ...(prev ?? [])])
        const fetchedNames = await getChatDisplayNames(older.map((row) => row.sender_id))
        setNames((prev) => ({ ...prev, ...fetchedNames }))
      } else {
        prevScrollHeightRef.current = null
      }
    } catch (err) {
      prevScrollHeightRef.current = null
      setError(toAppError(err, 'Failed to load older messages'))
    } finally {
      loadingOlderRef.current = false
      setLoadingOlder(false)
    }
  }

  // Unread badge (numeric, capped at "9+" per CHAT_PLAN.md §13) — how many
  // loaded messages, excluding the viewer's own (issue #586: a message you
  // wrote yourself is never "new" to you), are newer than the live read
  // cursor. Unread messages are always among the most recent ones, which the
  // initial `listChatMessages` load already covers regardless of whether
  // older history has since been paged in (issue #587, CHAT_PLAN.md §16) —
  // paging only ever prepends messages older than anything already loaded, so
  // it can't add to this count. `lastReadId` stays null forever for
  // site-wide chat (gameId === null, see the load effect above), so this is
  // always 0 there and the badge never renders.
  const unreadCount = messages === null || lastReadId === null ? 0 : messages.filter((message) => message.sender_id !== userId && message.id > lastReadId).length

  // Bubbles the count to a caller controlling `open` externally (issue #580)
  // so it can badge its own toggle button — computed above, not gated behind
  // the `enabled`/`session` early return below, so hooks stay unconditional.
  const onUnreadCountChangeRef = useRef(onUnreadCountChange)
  onUnreadCountChangeRef.current = onUnreadCountChange
  useEffect(() => {
    onUnreadCountChangeRef.current?.(unreadCount)
  }, [unreadCount])

  if (!enabled || !session || !userId) return null
  // Externally-controlled and told to hide (issue #580) — stay mounted (the
  // effects above keep tracking messages/unread state) but render nothing;
  // the caller's own toggle button is the only visible chat affordance.
  if (controlled && !open) return null
  const uid = userId

  function nameFor(senderId: string): string {
    if (senderId === uid) return ownDisplayName || 'Player'
    return names[senderId] ?? 'Player'
  }

  /**
   * In-game: the sender's own seat color (`chat_messages.sender_id` is
   * `auth.uid()`, matched against `PlayerRow.user_id`, not `PlayerRow.id` —
   * see CHAT_PLAN.md §15). Site-wide: a deterministic hash of their display
   * name (chatColors.ts) since there's no seat/color to look up there.
   */
  function colorFor(senderId: string): string | undefined {
    if (gameId !== null) return players?.find((p) => p.user_id === senderId)?.color
    return hashDisplayNameToColor(nameFor(senderId))
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

  // "New messages" divider position — the first loaded message, not sent by
  // the viewer (issue #586), whose id falls in `(readBoundaryId,
  // readBoundaryTopId]`: newer than the cursor as it stood before this
  // viewing session started, but no newer than what was already loaded when
  // it started. The upper bound is what keeps the divider from chasing a
  // message that arrives — from anyone — while the panel is still open and
  // being watched live (issue #586); the lower bound is what keeps it from
  // chasing the cursor as the viewer reads further within the same session.
  const dividerIndex =
    messages !== null && readBoundaryId !== null && readBoundaryTopId !== null
      ? messages.findIndex((message) => message.sender_id !== uid && message.id > readBoundaryId && message.id <= readBoundaryTopId)
      : -1

  return (
    <section className="font-typewriter flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium text-neutral-300">
          Chat
          {unreadCount > 0 && (
            <span className="rounded-full bg-sky-600 px-1.5 py-0.5 text-xs font-semibold leading-none text-white" aria-label={`${unreadCount} unread message${unreadCount === 1 ? '' : 's'}`}>
              {formatUnreadBadge(unreadCount)}
            </span>
          )}
        </h2>
        {!controlled && compact && (
          <button
            type="button"
            onClick={() => setInternalCollapsed((c) => !c)}
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
          <div ref={listRef} onScroll={handleListScroll} className="flex max-h-48 flex-col gap-1 overflow-y-auto text-sm">
            {loadingOlder && <p className="text-center text-neutral-500">Loading older messages…</p>}
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
                  <span className="font-medium text-neutral-300" style={{ color: colorFor(message.sender_id) }}>
                    {nameFor(message.sender_id)}:
                  </span>{' '}
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

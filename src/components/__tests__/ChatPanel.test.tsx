// Component-level coverage for ChatPanel (issue #564, CHAT_PLAN.md §12):
// renders nothing with the kill switch off, renders nothing with no
// session, renders the list when both hold, submits a message, and appends
// a Realtime INSERT. No engine tests — by design (CHAT_PLAN.md §1) there is
// nothing in src/engine/ for this feature to touch.

import type { Session } from '@supabase/supabase-js'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashDisplayNameToColor } from '../../lib/chatColors'
import type { ChatMessageRow, PlayerRow } from '../../lib/dbTypes'
import { ChatPanel } from '../ChatPanel'

const mockAuth = vi.hoisted(() => ({ session: null as Session | null }))
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ session: mockAuth.session, loading: false }),
}))

vi.mock('../../hooks/useDisplayName', () => ({
  useDisplayName: () => ({ displayName: 'Alice', profileDisplayName: null, loading: false, setProfileDisplayName: vi.fn() }),
}))

const chatApi = vi.hoisted(() => ({
  isChatEnabled: vi.fn(),
  listChatMessages: vi.fn(),
  postChatMessage: vi.fn(),
  subscribeToChatMessages: vi.fn(),
  getChatDisplayNames: vi.fn(),
  getChatReadStatus: vi.fn(),
  markChatRead: vi.fn(),
  formatUnreadBadge: (count: number) => (count > 9 ? '9+' : String(count)),
}))
vi.mock('../../lib/chatApi', () => chatApi)

function makeSession(userId: string): Session {
  return { user: { id: userId } } as Session
}

function makeMessage(id: number, senderId: string, body: string): ChatMessageRow {
  return { id, game_id: null, sender_id: senderId, body, created_at: new Date(id).toISOString() }
}

function makePlayer(userId: string, color: string): PlayerRow {
  return {
    id: `player-${userId}`,
    game_id: 'game-1',
    user_id: userId,
    display_name: userId,
    avatar_url: null,
    seat_index: 0,
    color,
    is_active: true,
    joined_at: new Date(0).toISOString(),
    ready_for_version: 0,
  }
}

describe('ChatPanel', () => {
  beforeEach(() => {
    mockAuth.session = null
    chatApi.isChatEnabled.mockReset().mockResolvedValue(true)
    chatApi.listChatMessages.mockReset().mockResolvedValue([])
    chatApi.postChatMessage.mockReset().mockResolvedValue(undefined)
    chatApi.getChatDisplayNames.mockReset().mockResolvedValue({})
    chatApi.subscribeToChatMessages.mockReset().mockReturnValue(() => {})
    chatApi.getChatReadStatus.mockReset().mockResolvedValue(null)
    chatApi.markChatRead.mockReset().mockResolvedValue(undefined)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders nothing when the kill switch is off', async () => {
    chatApi.isChatEnabled.mockResolvedValue(false)
    mockAuth.session = makeSession('alice')
    const { container } = render(<ChatPanel gameId={null} />)
    await waitFor(() => expect(chatApi.isChatEnabled).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when there is no session', async () => {
    chatApi.isChatEnabled.mockResolvedValue(true)
    mockAuth.session = null
    const { container } = render(<ChatPanel gameId={null} />)
    await waitFor(() => expect(chatApi.isChatEnabled).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the message list once enabled and signed in', async () => {
    mockAuth.session = makeSession('alice')
    chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'hello there')])
    chatApi.getChatDisplayNames.mockResolvedValue({ bob: 'Bob' })

    render(<ChatPanel gameId={null} />)

    expect(await screen.findByText('hello there')).toBeInTheDocument()
    expect(screen.getByText('Bob:')).toBeInTheDocument()
  })

  it('submits a message', async () => {
    mockAuth.session = makeSession('alice')

    render(<ChatPanel gameId={null} />)

    const input = await screen.findByPlaceholderText('Message')
    fireEvent.change(input, { target: { value: 'gg' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(chatApi.postChatMessage).toHaveBeenCalledWith(null, 'alice', 'gg'))
    expect(input).toHaveValue('')
  })

  it('appends a Realtime INSERT', async () => {
    mockAuth.session = makeSession('alice')
    let onInsert: ((message: ChatMessageRow) => void) | undefined
    chatApi.subscribeToChatMessages.mockImplementation((_gameId: string | null, cb: (message: ChatMessageRow) => void) => {
      onInsert = cb
      return () => {}
    })

    render(<ChatPanel gameId={null} />)
    await waitFor(() => expect(chatApi.subscribeToChatMessages).toHaveBeenCalled())

    chatApi.getChatDisplayNames.mockResolvedValue({ carol: 'Carol' })
    onInsert?.(makeMessage(2, 'carol', 'incoming'))

    expect(await screen.findByText('incoming')).toBeInTheDocument()
  })

  it('starts collapsed in compact mode and expands on toggle', async () => {
    mockAuth.session = makeSession('alice')
    chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'hello there')])
    chatApi.getChatDisplayNames.mockResolvedValue({ bob: 'Bob' })

    render(<ChatPanel gameId="game-1" compact />)

    await waitFor(() => expect(chatApi.isChatEnabled).toHaveBeenCalled())
    expect(screen.queryByPlaceholderText('Message')).not.toBeInTheDocument()
    expect(screen.queryByText('hello there')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show chat' }))

    expect(await screen.findByText('hello there')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Message')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Hide chat' }))
    expect(screen.queryByPlaceholderText('Message')).not.toBeInTheDocument()
  })

  it('is expanded by default (no compact prop) and has no toggle', async () => {
    mockAuth.session = makeSession('alice')

    render(<ChatPanel gameId={null} />)

    expect(await screen.findByPlaceholderText('Message')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show chat|hide chat/i })).not.toBeInTheDocument()
  })

  it('shows a read-only explanation instead of the composer when canPost is false', async () => {
    mockAuth.session = makeSession('alice')

    render(<ChatPanel gameId="game-1" canPost={false} />)

    expect(await screen.findByText("Only seated players can post in this game's chat.")).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Message')).not.toBeInTheDocument()
    expect(chatApi.postChatMessage).not.toHaveBeenCalled()
  })

  describe('externally-controlled visibility (issue #580, CHAT_PLAN.md §14)', () => {
    it('renders nothing while open=false, with no internal toggle button', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'hello there')])

      const { container } = render(<ChatPanel gameId="game-1" open={false} />)

      await waitFor(() => expect(chatApi.isChatEnabled).toHaveBeenCalled())
      expect(container).toBeEmptyDOMElement()
      expect(screen.queryByRole('button', { name: /show chat|hide chat/i })).not.toBeInTheDocument()
    })

    it('renders the panel while open=true, with no internal toggle button', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'hello there')])
      chatApi.getChatDisplayNames.mockResolvedValue({ bob: 'Bob' })

      render(<ChatPanel gameId="game-1" open={true} />)

      expect(await screen.findByText('hello there')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Message')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /show chat|hide chat/i })).not.toBeInTheDocument()
    })

    it('reports the unread count to onUnreadCountChange while closed', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'first'), makeMessage(2, 'bob', 'second')])
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: 'game-1', last_read_id: 0, updated_at: new Date(0).toISOString() })
      const onUnreadCountChange = vi.fn()

      render(<ChatPanel gameId="game-1" open={false} onUnreadCountChange={onUnreadCountChange} />)

      await waitFor(() => expect(onUnreadCountChange).toHaveBeenCalledWith(2))
    })
  })

  describe('unread indicator (issue #579, CHAT_PLAN.md §13) — in-game chat only', () => {
    it('shows an unread badge for messages newer than the persisted read cursor', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'first'), makeMessage(2, 'bob', 'second'), makeMessage(3, 'bob', 'third')])
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: 'game-1', last_read_id: 1, updated_at: new Date(0).toISOString() })

      render(<ChatPanel gameId="game-1" />)

      expect(await screen.findByLabelText('2 unread messages')).toHaveTextContent('2')
    })

    it('caps the badge at "9+"', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue(Array.from({ length: 12 }, (_, i) => makeMessage(i + 1, 'bob', `msg ${i + 1}`)))
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: 'game-1', last_read_id: 0, updated_at: new Date(0).toISOString() })

      render(<ChatPanel gameId="game-1" />)

      expect(await screen.findByLabelText('12 unread messages')).toHaveTextContent('9+')
    })

    it('seeds the read cursor at the latest existing message on first-ever open, instead of marking the whole history unread', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'old'), makeMessage(2, 'bob', 'older still')])
      chatApi.getChatReadStatus.mockResolvedValue(null)

      render(<ChatPanel gameId="game-1" />)

      await waitFor(() => expect(chatApi.markChatRead).toHaveBeenCalledWith('game-1', 'alice', 2))
      expect(screen.queryByLabelText(/unread message/)).not.toBeInTheDocument()
    })

    it('advances and debounces a write of the read cursor while open and visible', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'hi')])
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: 'game-1', last_read_id: 0, updated_at: new Date(0).toISOString() })

      render(<ChatPanel gameId="game-1" />)
      await waitFor(() => expect(screen.getByLabelText('1 unread message')).toBeInTheDocument())

      expect(chatApi.markChatRead).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(3000)
      expect(chatApi.markChatRead).toHaveBeenCalledWith('game-1', 'alice', 1)
    })

    it('does not advance the read cursor while collapsed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'hi')])
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: 'game-1', last_read_id: 0, updated_at: new Date(0).toISOString() })

      render(<ChatPanel gameId="game-1" compact />)
      await waitFor(() => expect(chatApi.getChatReadStatus).toHaveBeenCalled())

      await vi.advanceTimersByTimeAsync(5000)
      expect(chatApi.markChatRead).not.toHaveBeenCalled()
    })

    it('shows a "new messages" divider at the position of the old read cursor', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'seen already'), makeMessage(2, 'bob', 'brand new')])
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: 'game-1', last_read_id: 1, updated_at: new Date(0).toISOString() })

      const { container } = render(<ChatPanel gameId="game-1" />)
      await screen.findByText('brand new')

      expect(screen.getByRole('separator')).toBeInTheDocument()
      // The divider sits between the already-read message and the unread one.
      const text = container.textContent ?? ''
      expect(text.indexOf('seen already')).toBeLessThan(text.indexOf('New messages'))
      expect(text.indexOf('New messages')).toBeLessThan(text.indexOf('brand new'))
    })

    it('never tracks or shows unread state for site-wide chat', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'first'), makeMessage(2, 'bob', 'second')])

      render(<ChatPanel gameId={null} />)
      await screen.findByText('second')

      await vi.advanceTimersByTimeAsync(5000)
      expect(chatApi.getChatReadStatus).not.toHaveBeenCalled()
      expect(chatApi.markChatRead).not.toHaveBeenCalled()
      expect(screen.queryByLabelText(/unread message/)).not.toBeInTheDocument()
      expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    })
  })

  describe('sender name colors (issue #581, CHAT_PLAN.md §15)', () => {
    it('colors an in-game sender name with their PlayerRow.color, matched on user_id', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'hello there')])
      chatApi.getChatDisplayNames.mockResolvedValue({ bob: 'Bob' })
      const players = [makePlayer('alice', '#111111'), makePlayer('bob', '#3b82f6')]

      render(<ChatPanel gameId="game-1" players={players} open={true} />)

      const name = await screen.findByText('Bob:')
      expect(name).toHaveStyle({ color: 'rgb(59, 130, 246)' })
    })

    it('falls back to the default text color for an in-game sender missing from players', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'hello there')])
      chatApi.getChatDisplayNames.mockResolvedValue({ bob: 'Bob' })

      render(<ChatPanel gameId="game-1" players={[makePlayer('alice', '#111111')]} open={true} />)

      const name = await screen.findByText('Bob:')
      expect(name.style.color).toBe('')
    })

    it('colors a site-wide sender name by a deterministic hash of their display name', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'hello there')])
      chatApi.getChatDisplayNames.mockResolvedValue({ bob: 'Bob' })

      render(<ChatPanel gameId={null} />)

      const name = await screen.findByText('Bob:')
      // jsdom normalizes an inline `hsl()` style to `rgb()` on read, so compare
      // against another element assigned the same hsl() string rather than the
      // raw hsl() text.
      const probe = document.createElement('span')
      probe.style.color = hashDisplayNameToColor('Bob')
      expect(name.style.color).toBe(probe.style.color)
    })
  })
})

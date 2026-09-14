// Component-level coverage for ChatPanel (issue #564, CHAT_PLAN.md §12):
// renders nothing with the kill switch off, renders nothing with no
// session, renders the list when both hold, submits a message, and appends
// a Realtime INSERT. No engine tests — by design (CHAT_PLAN.md §1) there is
// nothing in src/engine/ for this feature to touch.

import type { Session } from '@supabase/supabase-js'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessageRow } from '../../lib/dbTypes'
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
}))
vi.mock('../../lib/chatApi', () => chatApi)

function makeSession(userId: string): Session {
  return { user: { id: userId } } as Session
}

function makeMessage(id: number, senderId: string, body: string): ChatMessageRow {
  return { id, game_id: null, sender_id: senderId, body, created_at: new Date(id).toISOString() }
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

  describe('unread indicator (issue #579, CHAT_PLAN.md §13)', () => {
    it('shows an unread badge for messages newer than the persisted read cursor', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue([makeMessage(1, 'bob', 'first'), makeMessage(2, 'bob', 'second'), makeMessage(3, 'bob', 'third')])
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: null, last_read_id: 1, updated_at: new Date(0).toISOString() })

      render(<ChatPanel gameId={null} />)

      expect(await screen.findByLabelText('2 unread messages')).toHaveTextContent('2')
    })

    it('caps the badge at "9+"', async () => {
      mockAuth.session = makeSession('alice')
      chatApi.listChatMessages.mockResolvedValue(Array.from({ length: 12 }, (_, i) => makeMessage(i + 1, 'bob', `msg ${i + 1}`)))
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: null, last_read_id: 0, updated_at: new Date(0).toISOString() })

      render(<ChatPanel gameId={null} />)

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
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: null, last_read_id: 0, updated_at: new Date(0).toISOString() })

      render(<ChatPanel gameId={null} />)
      await waitFor(() => expect(screen.getByLabelText('1 unread message')).toBeInTheDocument())

      expect(chatApi.markChatRead).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(3000)
      expect(chatApi.markChatRead).toHaveBeenCalledWith(null, 'alice', 1)
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
      chatApi.getChatReadStatus.mockResolvedValue({ id: 'r1', user_id: 'alice', game_id: null, last_read_id: 1, updated_at: new Date(0).toISOString() })

      const { container } = render(<ChatPanel gameId={null} />)
      await screen.findByText('brand new')

      expect(screen.getByRole('separator')).toBeInTheDocument()
      // The divider sits between the already-read message and the unread one.
      const text = container.textContent ?? ''
      expect(text.indexOf('seen already')).toBeLessThan(text.indexOf('New messages'))
      expect(text.indexOf('New messages')).toBeLessThan(text.indexOf('brand new'))
    })
  })
})

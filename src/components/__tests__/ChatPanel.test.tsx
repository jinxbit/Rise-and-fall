// Component-level coverage for ChatPanel (issue #564, CHAT_PLAN.md §12):
// renders nothing with the kill switch off, renders nothing with no
// session, renders the list when both hold, submits a message, and appends
// a Realtime INSERT. No engine tests — by design (CHAT_PLAN.md §1) there is
// nothing in src/engine/ for this feature to touch.

import type { Session } from '@supabase/supabase-js'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
})

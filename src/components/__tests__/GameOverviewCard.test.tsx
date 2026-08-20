import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GameOverviewCard } from '../GameOverviewCard'
import type { PlayerRow } from '../../lib/dbTypes'

function makePlayer(id: string, displayName: string): PlayerRow {
  return {
    id,
    game_id: 'g1',
    user_id: id,
    display_name: displayName,
    avatar_url: null,
    seat_index: 0,
    color: '#ef4444',
    is_active: true,
    joined_at: '',
    ready_for_version: 0,
  }
}

describe('GameOverviewCard', () => {
  it('renders the name, description, and updated time, and calls onOpen when clicked', () => {
    const onOpen = vi.fn()
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          description="In progress"
          players={[makePlayer('p1', 'Alice')]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          updatedAt="Updated 5m ago"
          onOpen={onOpen}
        />
      </ul>,
    )

    expect(screen.getByText('Test room')).toBeInTheDocument()
    expect(screen.getByText('Updated 5m ago')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('shows the room code when given', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          roomCode="ABCDE"
          description="Joinable"
          players={[]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          updatedAt="Updated just now"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByRole('button').textContent).toContain('Room ABCDE')
  })

  it('falls back to "no players yet" when the room is empty', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          description="Joinable"
          players={[]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          updatedAt="Updated just now"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByText(/no players yet/)).toBeInTheDocument()
  })

  it('bolds the pending player(s) among the player list', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          description="In progress"
          players={[makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob')]}
          pendingPlayerIds={['p2']}
          isMyTurn={false}
          isFinished={false}
          updatedAt="Updated just now"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByText('Alice')).not.toHaveClass('font-semibold')
    expect(screen.getByText((_, el) => el?.textContent === ', Bob')).toHaveClass('font-semibold')
  })

  it('highlights the whole card when it is the viewer\'s turn', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          description="In progress"
          players={[makePlayer('p1', 'Alice')]}
          pendingPlayerIds={['p1']}
          isMyTurn
          isFinished={false}
          updatedAt="Updated just now"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByRole('button')).toHaveClass('border-indigo-500')
  })

  it('greys out a finished game', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          description="Finished"
          players={[makePlayer('p1', 'Alice')]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished
          updatedAt="Updated 2d ago"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByRole('button')).toHaveClass('text-neutral-500')
  })

  it('renders an action badge when given', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          description="Joinable"
          players={[]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          updatedAt="Updated just now"
          action="Join"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByText('Join')).toBeInTheDocument()
  })
})

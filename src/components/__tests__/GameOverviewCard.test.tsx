import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GameOverviewCard } from '../GameOverviewCard'
import type { PlayerRow } from '../../lib/dbTypes'
import type { GameCardSummary } from '../../lib/gameCardView'

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
  it('renders the name, phase, and updated time, and calls onOpen when clicked', () => {
    const onOpen = vi.fn()
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="In progress"
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
    expect(screen.getByText('In progress')).toBeInTheDocument()
    expect(screen.getByText('Updated 5m ago')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('does not render a room code', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="Not started"
          players={[]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          updatedAt="Updated just now"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.queryByText(/Room /)).not.toBeInTheDocument()
  })

  it('falls back to "no players yet" when the room is empty', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="Not started"
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
          phase="In progress"
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
          phase="In progress"
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

  it('colors a finished game yellow', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="Finished"
          players={[makePlayer('p1', 'Alice')]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished
          updatedAt="Updated 2d ago"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByRole('button')).toHaveClass('border-yellow-800/60')
  })

  it('colors a joinable game green', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="Not started"
          players={[]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          isJoinable
          updatedAt="Updated just now"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByRole('button')).toHaveClass('border-green-800/60')
  })

  it('renders an action badge when given', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="Not started"
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

  function emptySummary(): GameCardSummary {
    return { playerRange: null, mapBuildStyle: null, moduleNames: [], roundNumber: null, scores: null }
  }

  it('shows the player range and map build style on a joinable card', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="Not started"
          players={[]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          isJoinable
          updatedAt="Updated just now"
          summary={{ ...emptySummary(), playerRange: '2–4 players', mapBuildStyle: 'Interactive (built together)' }}
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByText('2–4 players · Interactive (built together)')).toBeInTheDocument()
  })

  it('shows the modules (active Tales) whenever any are set', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="In progress"
          players={[]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          updatedAt="Updated just now"
          summary={{ ...emptySummary(), moduleNames: ['The Capital', 'The Ports'] }}
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByText('Modules: The Capital, The Ports')).toBeInTheDocument()
  })

  it('combines the player list with their scores instead of listing names twice', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="In progress"
          players={[makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob')]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          updatedAt="Updated just now"
          summary={{
            ...emptySummary(),
            roundNumber: 3,
            scores: [
              { playerId: 'p1', name: 'Alice', color: '#ef4444', score: 12, isWinner: false },
              { playerId: 'p2', name: 'Bob', color: '#3b82f6', score: 7, isWinner: false },
            ],
          }}
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByText('Round 3')).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.textContent === 'Alice: 12, Bob: 7')).toBeInTheDocument()
  })

  it('marks the winner with a crown on the score row and combines the player list with final scores, but no round number', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="Finished"
          players={[makePlayer('p1', 'Alice'), makePlayer('p2', 'Bob')]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished
          updatedAt="Updated 2d ago"
          summary={{
            ...emptySummary(),
            roundNumber: 8,
            scores: [
              { playerId: 'p1', name: 'Alice', color: '#ef4444', score: 20, isWinner: true },
              { playerId: 'p2', name: 'Bob', color: '#3b82f6', score: 12, isWinner: false },
            ],
          }}
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.getByText((_, el) => el?.textContent === '👑 Alice: 20')).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.textContent === ', Bob: 12')).toBeInTheDocument()
    expect(screen.queryByText('Round 8')).not.toBeInTheDocument()
  })

  it('renders no summary section when omitted', () => {
    render(
      <ul>
        <GameOverviewCard
          name="Test room"
          phase="Not started"
          players={[]}
          pendingPlayerIds={[]}
          isMyTurn={false}
          isFinished={false}
          updatedAt="Updated just now"
          onOpen={() => {}}
        />
      </ul>,
    )

    expect(screen.queryByText(/Modules:/)).not.toBeInTheDocument()
  })
})

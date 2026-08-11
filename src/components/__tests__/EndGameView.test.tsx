import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EndGameView } from '../EndGameView'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../../engine/achievementContent'
import type { AchievementContent } from '../../engine/achievementContent'
import { createEmptyBoard } from '../../engine/board'
import { createPlayerCards } from '../../engine/cards'
import type { GameState, Player, Unit } from '../../engine/types'
import type { PlayerRow } from '../../lib/dbTypes'

function makePlayerRow(id: string, displayName: string, color: string): PlayerRow {
  return { id, game_id: 'g1', user_id: id, display_name: displayName, avatar_url: null, seat_index: 0, color, is_active: true, joined_at: '' }
}

function makeEnginePlayer(id: string, gold: number): Player {
  return {
    id,
    authUserId: null,
    displayName: id,
    color: 'red',
    handCardIds: [],
    currentlyPlayedCardId: null,
    discardCardIds: [],
    supplyCardIds: createPlayerCards(id).map((c) => c.id),
    declineCardIds: [],
    eliminated: false,
    resources: { gold, wood: 0, stone: 0 },
  }
}

function unitAt(ownerId: string, kind: string): Unit {
  return { id: `${ownerId}-${kind}`, ownerId, kind, coord: { q: 0, r: 0 }, movement: { isMobile: false, terrains: [], canCrossCliffs: false }, traits: [] }
}

function makeState(): GameState {
  const p1 = makeEnginePlayer('p1', 4)
  const p2 = makeEnginePlayer('p2', 0)
  const cards = Object.fromEntries([...createPlayerCards('p1'), ...createPlayerCards('p2')].map((c) => [c.id, c]))

  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'completed',
    turn: 5,
    activePlayerId: null,
    roundPhase: 'selectCards',
    chosenCardIdByPlayerId: { p1: null, p2: null },
    pendingPlayerIds: [],
    resolvedUnitIdsThisTurn: [],
    unitsCreatedThisTurn: [],
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [p1, p2],
    units: [unitAt('p1', 'city')],
    cards,
    resourceBank: { gold: 100, wood: 100, stone: 100 },
    winnerPlayerIds: ['p1'],
    claimedByAchievementId: { 'city-mastery': 'p1' },
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
  }
}

const content: AchievementContent = {
  ...EMPTY_ACHIEVEMENT_CONTENT,
  achievementVictoryPoints: { 'city-mastery': 3 },
  unitBoardCountVP: { city: [1] },
  goldPerVictoryPoint: 2,
}

describe('EndGameView', () => {
  it('shows every player, ranked by total VP descending, with their per-source breakdown', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(<EndGameView state={state} players={players} achievementContent={content} />)

    // p1: 3 (achievements) + 1 (boardCount) + 0 (terrain) + 2 (gold) = 6; p2: 0.
    const rows = screen.getAllByRole('row').slice(1) // skip header row
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Alice')
    expect(rows[0]).toHaveTextContent('6')
    expect(rows[1]).toHaveTextContent('Bob')

    expect(screen.getByText('Winner:', { exact: false })).toBeInTheDocument()
  })

  it("highlights the winner(s) with a trophy, even ranked below someone eliminated", () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(<EndGameView state={state} players={players} achievementContent={content} />)

    const winnerRow = screen.getByText('Alice').closest('tr')
    expect(winnerRow).toHaveTextContent('🏆')

    const loserRow = screen.getByText('Bob').closest('tr')
    expect(loserRow).not.toHaveTextContent('🏆')
  })

  it('lists every player tied for the win when winnerPlayerIds has more than one id', () => {
    const state = { ...makeState(), winnerPlayerIds: ['p1', 'p2'] }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(<EndGameView state={state} players={players} achievementContent={content} />)

    expect(screen.getByText('Winners:', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/Alice, Bob/)).toBeInTheDocument()
  })
})

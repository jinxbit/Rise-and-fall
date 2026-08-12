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
    activeTaleIds: [],
    gameLength: Infinity,
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
  it('shows every player, ranked by total VP descending, with an itemized breakdown of what each score is made of', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    const { container } = render(<EndGameView state={state} players={players} achievementContent={content} />)

    // p1 (Alice): City (3) + 1 City board-count (1) + 4 Gold (2) = 6.
    // Real content/achievements.json's display name for 'city-mastery' is
    // "City" — EndGameView resolves the id to a name via the real
    // listAchievements(), independent of the test's own achievementContent.
    // Anchored to the start so it doesn't also match the "1 City:" board-count line below it.
    expect(screen.getByText(/^City:/)).toBeInTheDocument()
    expect(screen.getByText('1 City:', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('4 Gold:', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('6 points')).toBeInTheDocument()

    // p2 (Bob): nothing claimed, no units, no gold — scored nothing at all.
    expect(screen.getByText('No points scored')).toBeInTheDocument()

    // Ranked highest total first: Alice's card comes before Bob's.
    const cards = [...container.querySelectorAll('.rounded-md.border.p-3')]
    const aliceIndex = cards.findIndex((c) => c.textContent?.includes('Alice'))
    const bobIndex = cards.findIndex((c) => c.textContent?.includes('Bob'))
    expect(aliceIndex).toBeGreaterThanOrEqual(0)
    expect(aliceIndex).toBeLessThan(bobIndex)

    expect(screen.getByText('Winner:', { exact: false })).toBeInTheDocument()
  })

  it("highlights the winner(s) with a trophy, even ranked below someone eliminated", () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(<EndGameView state={state} players={players} achievementContent={content} />)

    const winnerHeader = screen.getByText('Alice').closest('div')
    expect(winnerHeader).toHaveTextContent('🏆')

    const loserHeader = screen.getByText('Bob').closest('div')
    expect(loserHeader).not.toHaveTextContent('🏆')
  })

  it('lists every player tied for the win when winnerPlayerIds has more than one id', () => {
    const state = { ...makeState(), winnerPlayerIds: ['p1', 'p2'] }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(<EndGameView state={state} players={players} achievementContent={content} />)

    expect(screen.getByText('Winners:', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/Alice, Bob/)).toBeInTheDocument()
  })
})

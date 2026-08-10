import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RoundView } from '../RoundView'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../../engine/achievementContent'
import { createEmptyBoard } from '../../engine/board'
import { cardIdFor, createPlayerCards } from '../../engine/cards'
import type { GameState, Player } from '../../engine/types'
import { EMPTY_UNIT_CONTENT } from '../../engine/unitContent'
import type { PlayerRow } from '../../lib/dbTypes'

function makePlayerRow(id: string, displayName: string, color: string): PlayerRow {
  return { id, game_id: 'g1', user_id: id, display_name: displayName, avatar_url: null, seat_index: 0, color, is_active: true, joined_at: '' }
}

function makeEnginePlayer(id: string, handKinds: string[]): Player {
  const cards = createPlayerCards(id)
  const handCardIds = handKinds.map((kind) => cardIdFor(id, kind))
  return {
    id,
    authUserId: null,
    displayName: id,
    color: 'red',
    handCardIds,
    currentlyPlayedCardId: null,
    discardCardIds: [],
    supplyCardIds: cards.map((c) => c.id).filter((id) => !handCardIds.includes(id)),
    declineCardIds: [],
    eliminated: false,
    resources: { gold: 3, wood: 1, stone: 0 },
  }
}

function makeState(): GameState {
  const p1 = makeEnginePlayer('p1', ['nomad', 'ship'])
  const p2 = makeEnginePlayer('p2', ['city'])
  const cards = Object.fromEntries([...createPlayerCards('p1'), ...createPlayerCards('p2')].map((c) => [c.id, c]))

  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'active',
    turn: 1,
    activePlayerId: null,
    roundPhase: 'selectCards',
    chosenCardIdByPlayerId: { p1: null, p2: null },
    pendingPlayerIds: ['p1', 'p2'],
    resolvedUnitIdsThisTurn: [],
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [p1, p2],
    units: [],
    cards,
    resourceBank: { gold: 100, wood: 100, stone: 100 },
    unitLimits: {},
    log: [],
    winnerPlayerIds: [],
    claimedByAchievementId: { 'city-mastery': 'p2' },
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
  }
}

describe('RoundView — player status summary and achievements panel', () => {
  it("shows each player's hand as unit kinds, not just a count", () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={EMPTY_ACHIEVEMENT_CONTENT}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    expect(screen.getByText('Hand: Nomad, Ship')).toBeInTheDocument()
    expect(screen.getByText('Hand: City')).toBeInTheDocument()
  })

  it('shows every achievement (claimed and unclaimed) and the current decline buyback price', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(
      <RoundView
        state={state}
        players={players}
        myPlayerId="p1"
        unitContent={EMPTY_UNIT_CONTENT}
        achievementContent={{ ...EMPTY_ACHIEVEMENT_CONTENT, purchaseCostTable: [5, 10, 20] }}
        onChooseCard={() => {}}
        onResolveUnit={() => {}}
        onPassActions={() => {}}
        onMoveToDecline={() => {}}
        onPurchaseCard={() => {}}
        onPassPurchase={() => {}}
      />,
    )

    // A claimed achievement shows who claimed it...
    expect(screen.getByText(/City Mastery.*Bob/)).toBeInTheDocument()
    // ...an unclaimed one says so...
    expect(screen.getByText(/Ship Mastery.*unclaimed/)).toBeInTheDocument()
    // ...and the buyback price reflects the one achievement claimed so far (index 0 of the table).
    expect(screen.getByText('5 gold')).toBeInTheDocument()
  })
})

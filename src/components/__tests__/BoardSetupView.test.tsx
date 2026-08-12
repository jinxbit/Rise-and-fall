import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BoardSetupView } from '../BoardSetupView'
import { createEmptyBoard, setTile } from '../../engine/board'
import type { BoardGenerationContent } from '../../engine/boardGenerationContent'
import type { GameState, Player } from '../../engine/types'
import type { PlayerRow } from '../../lib/dbTypes'

function makePlayerRow(id: string, displayName: string): PlayerRow {
  return { id, game_id: 'g1', user_id: id, display_name: displayName, avatar_url: null, seat_index: 0, color: '#ff0000', is_active: true, joined_at: '' }
}

function makeEnginePlayer(id: string): Player {
  return {
    id,
    authUserId: null,
    displayName: id,
    color: 'red',
    handCardIds: [],
    currentlyPlayedCardId: null,
    discardCardIds: [],
    supplyCardIds: [],
    declineCardIds: [],
    eliminated: false,
    resources: { gold: 0, wood: 0, stone: 0 },
  }
}

const domino = [{ q: 0, r: 0 }, { q: 1, r: 0 }]

function makeWaterPlacementState(board: GameState['board']): GameState {
  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'boardSetup',
    turn: 0,
    activePlayerId: null,
    roundPhase: 'selectCards',
    chosenCardIdByPlayerId: {},
    pendingPlayerIds: [],
    resolvedUnitIdsThisTurn: [],
    unitsCreatedThisTurn: [],
    turnOrder: ['p1', 'p2'],
    board,
    players: [makeEnginePlayer('p1'), makeEnginePlayer('p2')],
    units: [],
    cards: {},
    resourceBank: { gold: 0, wood: 0, stone: 0 },
    activeTaleIds: [],
    gameLength: Infinity,
    winnerPlayerIds: [],
    claimedByAchievementId: {},
    achievementsClaimedThisRound: 0,
    boardSetup: { tileTierQueue: ['water'], tilesRemainingInTier: 5, tilePlacerIndex: 0, unitsRemainingByPlayerId: {}, unitPlacerIndex: 0 },
    idSequence: 0,
    actionHistory: [],
  }
}

const boardGenerationContent: BoardGenerationContent = {
  startingWaterShapeCells: domino,
  tiers: [{ terrain: 'water', shapeCells: domino, placesOn: null, poolSize: 5 }],
}

describe('BoardSetupView — tile placement ghost legality', () => {
  it('shows the ghost as illegal (red) and disables Confirm when the placement fails an extra rule (touching < 2 Sea tiles) — regression for the reported "shows green when it cannot be placed" bug', () => {
    const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'water')
    const state = makeWaterPlacementState(board)

    const { container } = render(
      <BoardSetupView
        state={state}
        players={[makePlayerRow('p1', 'Alice'), makePlayerRow('p2', 'Bob')]}
        myPlayerId="p1"
        boardGenerationContent={boardGenerationContent}
        onPlaceTile={vi.fn()}
        onPlaceUnit={vi.fn()}
      />,
    )

    // (1,0)-(2,0): only (1,0) touches the lone existing Sea tile at (0,0) —
    // one short of the required 2, so this placement is illegal even
    // though isLegalTilePlacement's basic covering check alone would pass.
    const hex = container.querySelector('polygon[data-coord="1,0"]')
    expect(hex).not.toBeNull()
    fireEvent.click(hex!)

    const ghostCovered = container.querySelector('polygon[data-ghost-coord="1,0"]')
    const ghostExtra = container.querySelector('polygon[data-ghost-coord="2,0"]')
    expect(ghostCovered).not.toBeNull()
    expect(ghostExtra).not.toBeNull()
    expect(ghostCovered?.getAttribute('stroke')).toBe('#ef4444')
    expect(ghostExtra?.getAttribute('stroke')).toBe('#ef4444')

    expect(screen.getByText(/at least 2 Sea tiles/)).toBeInTheDocument()
    expect(screen.getByText('Confirm placement')).toBeDisabled()
  })

  it('shows the ghost as legal (green) and enables Confirm once the placement satisfies every rule', () => {
    let board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'water')
    board = setTile(board, { q: 1, r: -1 }, 'water')
    const state = makeWaterPlacementState(board)

    const { container } = render(
      <BoardSetupView
        state={state}
        players={[makePlayerRow('p1', 'Alice'), makePlayerRow('p2', 'Bob')]}
        myPlayerId="p1"
        boardGenerationContent={boardGenerationContent}
        onPlaceTile={vi.fn()}
        onPlaceUnit={vi.fn()}
      />,
    )

    // (1,0)-(2,0): both (0,0) and (1,-1) touch (1,0) — 2 distinct Sea tiles.
    const hex = container.querySelector('polygon[data-coord="1,0"]')
    fireEvent.click(hex!)

    const ghostCovered = container.querySelector('polygon[data-ghost-coord="1,0"]')
    expect(ghostCovered?.getAttribute('stroke')).toBe('#22c55e')
    expect(screen.getByText('Confirm placement')).toBeEnabled()
  })
})

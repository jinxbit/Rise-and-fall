import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import type { Coordinate, GameState, Player, Unit } from '../types'

function makePlayer(id: string, overrides: Partial<Player> = {}): Player {
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
    ...overrides,
  }
}

function makeUnit(id: string, ownerId: string, kind: string, coord: Coordinate): Unit {
  return {
    id,
    ownerId,
    kind,
    coord,
    movement: { isMobile: true, terrains: ['plain'], canCrossCliffs: false, moveDistance: 1, blockedByUnits: 'all' },
    traits: [],
  }
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  let board = createEmptyBoard('hex')
  board = setTile(board, { q: 0, r: 0 }, 'plain')
  board = setTile(board, { q: 1, r: 0 }, 'plain')
  board = setTile(board, { q: 2, r: 0 }, 'plain')

  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'active',
    turn: 1,
    activePlayerId: 'p1',
    roundPhase: 'actions',
    chosenCardIdByPlayerId: {},
    pendingPlayerIds: ['p1', 'p2'],
    turnOrder: ['p1', 'p2'],
    board,
    players: [makePlayer('p1'), makePlayer('p2')],
    units: [makeUnit('unit_1', 'p1', 'nomad', { q: 0, r: 0 })],
    cards: {},
    resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
    unitLimits: {},
    log: [],
    winnerPlayerIds: [],
    ...overrides,
  }
}

describe('applyAction — MOVE_UNIT', () => {
  it('rejects moving outside the actions phase', () => {
    const state = makeState({ roundPhase: 'selectCards' })
    const result = applyAction(state, { type: 'MOVE_UNIT', playerId: 'p1', unitId: 'unit_1', to: { q: 1, r: 0 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('actions phase')
  })

  it("rejects moving when it isn't this player's turn", () => {
    const state = makeState({ activePlayerId: 'p2' })
    const result = applyAction(state, { type: 'MOVE_UNIT', playerId: 'p1', unitId: 'unit_1', to: { q: 1, r: 0 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("not this player's turn")
  })

  it('rejects an unknown unit id', () => {
    const state = makeState()
    const result = applyAction(state, { type: 'MOVE_UNIT', playerId: 'p1', unitId: 'nope', to: { q: 1, r: 0 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Unknown unit')
  })

  it('rejects moving a unit owned by another player', () => {
    const state = makeState({ units: [makeUnit('unit_1', 'p2', 'nomad', { q: 0, r: 0 })] })
    const result = applyAction(state, { type: 'MOVE_UNIT', playerId: 'p1', unitId: 'unit_1', to: { q: 1, r: 0 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('do not own')
  })

  it('rejects an illegal destination', () => {
    const state = makeState()
    const result = applyAction(state, { type: 'MOVE_UNIT', playerId: 'p1', unitId: 'unit_1', to: { q: 2, r: 0 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Illegal move destination')
  })

  it('moves the unit to a legal destination and logs it', () => {
    const state = makeState()
    const result = applyAction(state, { type: 'MOVE_UNIT', playerId: 'p1', unitId: 'unit_1', to: { q: 1, r: 0 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const moved = result.state.units.find((u) => u.id === 'unit_1')
    expect(moved?.coord).toEqual({ q: 1, r: 0 })
    expect(result.state.log.at(-1)?.message).toContain('moved a nomad')
  })

  it('does not mutate the input state', () => {
    const state = makeState()
    const snapshot = JSON.stringify(state)
    applyAction(state, { type: 'MOVE_UNIT', playerId: 'p1', unitId: 'unit_1', to: { q: 1, r: 0 } })
    expect(JSON.stringify(state)).toBe(snapshot)
  })
})

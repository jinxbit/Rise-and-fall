import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { syncCardZonesWithBoard } from '../cards'
import { createNewGame } from '../createGame'
import { buildGameLog } from '../gameLog'
import { beginSelectCardsPhase } from '../round'
import type { Coordinate, GameState, Unit } from '../types'

function makeLobbyGame(): GameState {
  return createNewGame({
    gameId: 'admin_mode_game',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
    ],
  })
}

/**
 * A minimal active, mid-select-cards game — mirrors concede.test.ts's
 * makeThreePlayerActiveGame, trimmed to two players. Each player gets TWO
 * unit kinds (so a two-card hand): a single-card hand would fold a
 * still-pending player's own pick into whatever leaves them the only one
 * forced (RULE_ENFORCEMENT_PLAN.md §4.2/§4.3), pre-empting this file's own
 * explicit CHOOSE_CARD submissions below.
 */
function makeActiveGame(): GameState {
  const lobby = makeLobbyGame()
  const startingPositions: Record<string, Coordinate> = { p1: { q: 0, r: 0 }, p2: { q: 5, r: 0 } }
  let board = lobby.board
  const units: Unit[] = []
  for (const player of lobby.players) {
    const coord = startingPositions[player.id]
    board = setTile(board, coord, 'plain')
    units.push(
      {
        id: `${player.id}_ship`,
        ownerId: player.id,
        kind: 'ship',
        coord,
        movement: { isMobile: true, terrains: ['water'], canCrossCliffs: false, moveDistance: 1 },
        traits: ['ship'],
      },
      {
        id: `${player.id}_nomad`,
        ownerId: player.id,
        kind: 'nomad',
        coord,
        movement: { isMobile: true, terrains: ['plain'], canCrossCliffs: false, moveDistance: 1 },
        traits: ['mobile'],
      },
    )
  }
  const active: GameState = { ...lobby, board, units, status: 'active' }
  return beginSelectCardsPhase(syncCardZonesWithBoard(active))
}

describe('SET_ADMIN_MODE', () => {
  it('is off by default', () => {
    expect(makeLobbyGame().adminModeActive).toBeFalsy()
  })

  it('turns admin mode on', () => {
    const result = applyAction(makeLobbyGame(), { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.adminModeActive).toBe(true)
  })

  it('turns admin mode back off', () => {
    const on = applyAction(makeLobbyGame(), { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: true })
    if (!on.ok) throw new Error('setup failed')
    const off = applyAction(on.state, { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: false })
    expect(off.ok).toBe(true)
    if (!off.ok) return
    expect(off.state.adminModeActive).toBe(false)
  })

  it('rejects a redundant toggle to the state it is already in', () => {
    const alreadyOff = applyAction(makeLobbyGame(), { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: false })
    expect(alreadyOff.ok).toBe(false)

    const on = applyAction(makeLobbyGame(), { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: true })
    if (!on.ok) throw new Error('setup failed')
    const alreadyOn = applyAction(on.state, { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: true })
    expect(alreadyOn.ok).toBe(false)
  })

  it('is legal even outside an active game (e.g. still in the lobby)', () => {
    const state = makeLobbyGame()
    expect(state.status).toBe('lobby')
    const result = applyAction(state, { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: true })
    expect(result.ok).toBe(true)
  })

  it('never marks its own actionHistory entry as viaAdminMode, turning on or off', () => {
    const on = applyAction(makeLobbyGame(), { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: true })
    if (!on.ok) throw new Error('setup failed')
    expect(on.state.actionHistory.at(-1)?.viaAdminMode).toBeUndefined()

    const off = applyAction(on.state, { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: false })
    if (!off.ok) throw new Error('setup failed')
    expect(off.state.actionHistory.at(-1)?.viaAdminMode).toBeUndefined()
  })

  it('marks every other action taken while admin mode is on, and stops once turned back off', () => {
    const on = applyAction(makeActiveGame(), { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: true })
    if (!on.ok) throw new Error('setup failed')

    const cardId = on.state.players.find((p) => p.id === 'p2')?.handCardIds[0]
    if (!cardId) throw new Error('setup failed: p2 has no hand card')
    const choice = applyAction(on.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId })
    expect(choice.ok).toBe(true)
    if (!choice.ok) return
    expect(choice.state.actionHistory.at(-1)?.viaAdminMode).toBe(true)

    const off = applyAction(choice.state, { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: false })
    if (!off.ok) throw new Error('setup failed')
    const p1CardId = off.state.players.find((p) => p.id === 'p1')?.handCardIds[0]
    if (!p1CardId) throw new Error('setup failed: p1 has no hand card')
    const afterOff = applyAction(off.state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: p1CardId })
    expect(afterOff.ok).toBe(true)
    if (!afterOff.ok) return
    expect(afterOff.state.actionHistory.at(-1)?.viaAdminMode).toBeUndefined()
  })

  it('is narrated in the game log, and tags events logged while it was on', () => {
    const genesis = makeActiveGame()
    const on = applyAction(genesis, { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: true })
    if (!on.ok) throw new Error('setup failed')
    const cardId = on.state.players.find((p) => p.id === 'p2')?.handCardIds[0]
    if (!cardId) throw new Error('setup failed: p2 has no hand card')
    const choice = applyAction(on.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId })
    if (!choice.ok) throw new Error('setup failed')

    const log = buildGameLog(genesis, choice.state.actionHistory)
    const toggleEvent = log.find((e) => e.message.includes('admin mode on'))
    expect(toggleEvent).toBeDefined()
    expect(toggleEvent?.adminMode).toBeUndefined()

    const choiceEvent = log.find((e) => e.playerId === 'p2')
    expect(choiceEvent?.adminMode).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { buildGenesisState } from '../gameGenesis'
import { groupMyGames, isFinished, isMyTurn, myGameStatus, type MyGameEntry } from '../myGamesView'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes'
import type { GameState as EngineGameState } from '../../engine/types'

function makeGame(overrides: Partial<GameRow> = {}, settingsOverrides: Partial<GameSettings> = {}): GameRow {
  return {
    id: 'game_1',
    room_code: 'ABCDE',
    play_mode: 'live',
    status: 'active',
    min_players: 2,
    max_players: 4,
    created_by: 'auth_1',
    created_at: '',
    updated_at: '2026-01-01T00:00:00Z',
    settings: { mapTemplateId: 'classic', skipHotseatPassGate: false, activeTaleIds: [], gameLength: 4, ...settingsOverrides },
    ...overrides,
  }
}

function makePlayers(gameId: string): PlayerRow[] {
  return [
    { id: 'p1', game_id: gameId, user_id: 'auth_1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '' },
    { id: 'p2', game_id: gameId, user_id: 'auth_2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '' },
  ]
}

/** A genesis state (from the real builder, so pendingActorIds() has everything it needs) forced past board setup into the plain `active` round loop. */
function makeActiveState(overrides: Partial<EngineGameState> = {}): EngineGameState {
  const genesis = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers('game_1'))
  return { ...genesis, status: 'active', pendingPlayerIds: [], activePlayerId: 'p1', ...overrides }
}

function makeEntry(overrides: Partial<MyGameEntry> = {}): MyGameEntry {
  const game = makeGame()
  const players = makePlayers(game.id)
  return {
    game,
    players,
    gameState: makeActiveState(),
    myPlayerIds: ['p1'],
    ...overrides,
  }
}

describe('myGameStatus', () => {
  it('reports lobby for a game with no state yet', () => {
    expect(myGameStatus(makeEntry({ gameState: null }))).toBe('lobby')
  })

  it('reads the status off gameState, not games.status (which never records boardSetup/completed)', () => {
    expect(myGameStatus(makeEntry({ gameState: makeActiveState({ status: 'completed' }) }))).toBe('completed')
  })
})

describe('isFinished', () => {
  it('is false for an in-progress game', () => {
    expect(isFinished(makeEntry())).toBe(false)
  })

  it('is true once gameState.status is completed', () => {
    expect(isFinished(makeEntry({ gameState: makeActiveState({ status: 'completed' }) }))).toBe(true)
  })
})

describe('isMyTurn', () => {
  it('is false with no game_state row yet (lobby)', () => {
    expect(isMyTurn(makeEntry({ gameState: null, myPlayerIds: ['p1'] }))).toBe(false)
  })

  it('is true when one of my seats is the active player', () => {
    expect(isMyTurn(makeEntry({ myPlayerIds: ['p1'], gameState: makeActiveState({ activePlayerId: 'p1' }) }))).toBe(true)
  })

  it('is false when a different seat is active', () => {
    expect(isMyTurn(makeEntry({ myPlayerIds: ['p1'], gameState: makeActiveState({ activePlayerId: 'p2' }) }))).toBe(false)
  })

  it('checks every seat I hold, e.g. a hotseat host with several local players', () => {
    expect(
      isMyTurn(makeEntry({ myPlayerIds: ['p1', 'p2'], gameState: makeActiveState({ activePlayerId: 'p2' }) })),
    ).toBe(true)
  })

  it('is true for a simultaneous phase when I am one of the pending players', () => {
    expect(
      isMyTurn(
        makeEntry({
          myPlayerIds: ['p2'],
          gameState: makeActiveState({ activePlayerId: null, pendingPlayerIds: ['p1', 'p2'] }),
        }),
      ),
    ).toBe(true)
  })
})

describe('groupMyGames', () => {
  it('splits active and finished games', () => {
    const activeEntry = makeEntry({ game: makeGame({ id: 'g1', room_code: 'AAAAA' }), gameState: makeActiveState() })
    const finishedEntry = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB' }),
      gameState: makeActiveState({ status: 'completed' }),
    })

    const { active, finished } = groupMyGames([activeEntry, finishedEntry])

    expect(active.map((e) => e.game.id)).toEqual(['g1'])
    expect(finished.map((e) => e.game.id)).toEqual(['g2'])
  })

  it('sorts active games with "your turn" first, ties broken by most-recently-updated', () => {
    const notMyTurn = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', updated_at: '2026-01-03T00:00:00Z' }),
      myPlayerIds: ['p1'],
      gameState: makeActiveState({ activePlayerId: 'p2' }),
    })
    const myTurnOlder = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', updated_at: '2026-01-01T00:00:00Z' }),
      myPlayerIds: ['p1'],
      gameState: makeActiveState({ activePlayerId: 'p1' }),
    })
    const myTurnNewer = makeEntry({
      game: makeGame({ id: 'g3', room_code: 'CCCCC', updated_at: '2026-01-02T00:00:00Z' }),
      myPlayerIds: ['p1'],
      gameState: makeActiveState({ activePlayerId: 'p1' }),
    })

    const { active } = groupMyGames([notMyTurn, myTurnOlder, myTurnNewer])

    expect(active.map((e) => e.game.id)).toEqual(['g3', 'g2', 'g1'])
  })

  it('sorts finished games most-recently-updated first', () => {
    const older = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', updated_at: '2026-01-01T00:00:00Z' }),
      gameState: makeActiveState({ status: 'completed' }),
    })
    const newer = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', updated_at: '2026-01-05T00:00:00Z' }),
      gameState: makeActiveState({ status: 'completed' }),
    })

    const { finished } = groupMyGames([older, newer])

    expect(finished.map((e) => e.game.id)).toEqual(['g2', 'g1'])
  })
})

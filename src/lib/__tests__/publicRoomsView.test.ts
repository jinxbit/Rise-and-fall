import { describe, expect, it } from 'vitest'
import { buildGenesisState } from '../gameGenesis'
import {
  groupPublicRooms,
  isJoinable,
  isMyTurn,
  isObservable,
  pendingActorIds,
  publicRoomBucket,
  type PublicRoomEntry,
} from '../publicRoomsView'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes'
import type { GameState as EngineGameState } from '../../engine/types'

function makeGame(overrides: Partial<GameRow> = {}, settingsOverrides: Partial<GameSettings> = {}): GameRow {
  return {
    id: 'game_1',
    room_code: 'ABCDE',
    name: 'Test room',
    play_mode: 'live',
    status: 'lobby',
    min_players: 2,
    max_players: 4,
    created_by: 'auth_1',
    created_at: '',
    updated_at: '2026-01-01T00:00:00Z',
    settings: { mapTemplateId: 'classic', mapPoolBoard: null, mapPoolMapId: null, mapPoolRandomAtStart: false, soloBuildMap: false, skipHotseatPassGate: false, activeTaleIds: [], gameLength: 4, ...settingsOverrides },
    config_version: 0,
    visibility: 'public',
    ...overrides,
  }
}

function makePlayers(gameId: string, count = 2): PlayerRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`,
    game_id: gameId,
    user_id: `auth_${i + 1}`,
    display_name: `Player ${i + 1}`,
    avatar_url: null,
    seat_index: i,
    color: '#ef4444',
    is_active: true,
    joined_at: '',
    ready_for_version: 0,
  }))
}

/** A genesis state (from the real builder) forced past board setup into the plain `active` round loop — same approach as myGamesView.test.ts. */
function makeActiveState(overrides: Partial<EngineGameState> = {}): EngineGameState {
  const genesis = buildGenesisState(makeGame({ status: 'active' }, { mapTemplateId: 'classic' }), makePlayers('game_1'))
  return { ...genesis, status: 'active', pendingPlayerIds: [], activePlayerId: 'p1', ...overrides }
}

function makeEntry(overrides: Partial<PublicRoomEntry> = {}): PublicRoomEntry {
  const game = makeGame({ status: 'active' })
  return {
    game,
    players: makePlayers(game.id),
    gameState: makeActiveState(),
    ...overrides,
  }
}

describe('publicRoomBucket', () => {
  it('is notStarted for a lobby room with no state yet', () => {
    expect(publicRoomBucket(makeEntry({ game: makeGame({ status: 'lobby' }), gameState: null }))).toBe('notStarted')
  })

  it('is inProgress for an active room whose gameState is not completed', () => {
    expect(publicRoomBucket(makeEntry())).toBe('inProgress')
  })

  it('is finished once gameState.status is completed (games.status is still active)', () => {
    expect(publicRoomBucket(makeEntry({ gameState: makeActiveState({ status: 'completed' }) }))).toBe('finished')
  })
})

describe('isJoinable', () => {
  it('is true for a notStarted room with a free seat', () => {
    const game = makeGame({ status: 'lobby', max_players: 4 })
    expect(isJoinable(makeEntry({ game, gameState: null, players: makePlayers(game.id, 2) }))).toBe(true)
  })

  it('is false for a notStarted room already at max players', () => {
    const game = makeGame({ status: 'lobby', max_players: 2 })
    expect(isJoinable(makeEntry({ game, gameState: null, players: makePlayers(game.id, 2) }))).toBe(false)
  })

  it('is false once the room is in progress', () => {
    expect(isJoinable(makeEntry())).toBe(false)
  })
})

describe('isObservable', () => {
  it('is true for an in-progress room', () => {
    expect(isObservable(makeEntry())).toBe(true)
  })

  it('is false for a notStarted room', () => {
    expect(isObservable(makeEntry({ game: makeGame({ status: 'lobby' }), gameState: null }))).toBe(false)
  })

  it('is false for a finished room', () => {
    expect(isObservable(makeEntry({ gameState: makeActiveState({ status: 'completed' }) }))).toBe(false)
  })
})

describe('pendingActorIds', () => {
  it('is empty with no game_state row yet (lobby)', () => {
    expect(pendingActorIds(makeEntry({ gameState: null }))).toEqual([])
  })

  it('returns the active player when one player is up', () => {
    expect(pendingActorIds(makeEntry({ gameState: makeActiveState({ activePlayerId: 'p2' }) }))).toEqual(['p2'])
  })

  it('is empty once the room is finished', () => {
    expect(pendingActorIds(makeEntry({ gameState: makeActiveState({ status: 'completed' }) }))).toEqual([])
  })
})

describe('isMyTurn', () => {
  it('is true when the given user seats the active player', () => {
    expect(isMyTurn(makeEntry({ gameState: makeActiveState({ activePlayerId: 'p1' }) }), 'auth_1')).toBe(true)
  })

  it('is false when the given user is not seated in this room', () => {
    expect(isMyTurn(makeEntry({ gameState: makeActiveState({ activePlayerId: 'p1' }) }), 'auth_9')).toBe(false)
  })

  it('is false when the given user is seated but a different player is active', () => {
    expect(isMyTurn(makeEntry({ gameState: makeActiveState({ activePlayerId: 'p2' }) }), 'auth_1')).toBe(false)
  })

  it('is false with no game_state row yet (lobby)', () => {
    expect(isMyTurn(makeEntry({ gameState: null }), 'auth_1')).toBe(false)
  })
})

describe('groupPublicRooms', () => {
  it('splits notStarted, inProgress, and finished rooms', () => {
    const notStarted = makeEntry({ game: makeGame({ id: 'g1', room_code: 'AAAAA', status: 'lobby' }), gameState: null })
    const inProgress = makeEntry({ game: makeGame({ id: 'g2', room_code: 'BBBBB', status: 'active' }) })
    const finished = makeEntry({
      game: makeGame({ id: 'g3', room_code: 'CCCCC', status: 'active' }),
      gameState: makeActiveState({ status: 'completed' }),
    })

    const grouped = groupPublicRooms([notStarted, inProgress, finished])
    expect(grouped.notStarted.map((e) => e.game.id)).toEqual(['g1'])
    expect(grouped.inProgress.map((e) => e.game.id)).toEqual(['g2'])
    expect(grouped.finished.map((e) => e.game.id)).toEqual(['g3'])
  })

  it('sorts each bucket most-recently-updated first', () => {
    const older = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', status: 'lobby', updated_at: '2026-01-01T00:00:00Z' }),
      gameState: null,
    })
    const newer = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', status: 'lobby', updated_at: '2026-01-05T00:00:00Z' }),
      gameState: null,
    })

    const grouped = groupPublicRooms([older, newer])
    expect(grouped.notStarted.map((e) => e.game.id)).toEqual(['g2', 'g1'])
  })
})

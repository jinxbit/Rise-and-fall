import { describe, expect, it } from 'vitest'
import { buildGenesisState } from '../gameGenesis'
import {
  groupPublicRooms,
  isJoinable,
  isMine,
  isMyTurn,
  isObservable,
  orderInProgressForUser,
  orderNotStartedForUser,
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
    settings: {
      mapTemplateId: 'classic',
      mapPoolBoard: null,
      mapPoolMapId: null,
      mapPoolRandomAtStart: false,
      soloBuildMap: false,
      soloBuilderSelection: 'owner',
      soloBuilderId: null,
      soloBuilderUnitOrder: 'last',
      soloBuilderTurnOrder: null,
      skipHotseatPassGate: false,
      ruleEnforcementEnabled: false,
      activeTaleIds: [],
      gameLength: 4,
      ...settingsOverrides,
    },
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
    gameStateUpdatedAt: null,
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
    expect(
      pendingActorIds(makeEntry({ gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p2' }) })),
    ).toEqual(['p2'])
  })

  it('returns only the active player in a turn-order phase, even with others still queued', () => {
    expect(
      pendingActorIds(
        makeEntry({ gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p2', pendingPlayerIds: ['p2', 'p1'] }) }),
      ),
    ).toEqual(['p2'])
  })

  it('is empty once the room is finished', () => {
    expect(pendingActorIds(makeEntry({ gameState: makeActiveState({ status: 'completed' }) }))).toEqual([])
  })
})

describe('isMyTurn', () => {
  it('is true when the given user seats the active player', () => {
    expect(
      isMyTurn(makeEntry({ gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p1' }) }), 'auth_1'),
    ).toBe(true)
  })

  it('is false when the given user is not seated in this room', () => {
    expect(
      isMyTurn(makeEntry({ gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p1' }) }), 'auth_9'),
    ).toBe(false)
  })

  it('is false when the given user is seated but a different player is active', () => {
    expect(
      isMyTurn(makeEntry({ gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p2' }) }), 'auth_1'),
    ).toBe(false)
  })

  it('is false with no game_state row yet (lobby)', () => {
    expect(isMyTurn(makeEntry({ gameState: null }), 'auth_1')).toBe(false)
  })

  // Regression for issue #301: it's turn order (not simultaneous), so a
  // player still waiting further down pendingPlayerIds must NOT show as
  // "my turn" just because they're in the queue.
  it('is false for a user seated in a queued (not yet active) seat in a turn-order phase', () => {
    expect(
      isMyTurn(
        makeEntry({
          gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p2', pendingPlayerIds: ['p2', 'p1'] }),
        }),
        'auth_1',
      ),
    ).toBe(false)
  })
})

describe('isMine', () => {
  it('is true when userId is seated in the room', () => {
    expect(isMine(makeEntry(), 'auth_1')).toBe(true)
  })

  it('is false when userId is not seated in the room', () => {
    expect(isMine(makeEntry(), 'auth_9')).toBe(false)
  })
})

describe('orderInProgressForUser', () => {
  it("puts rooms where it's the user's turn first, oldest-updated first", () => {
    const myTurnNewer = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', updated_at: '2026-01-02T00:00:00Z' }),
      gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p1' }),
    })
    const myTurnOlder = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', updated_at: '2026-01-01T00:00:00Z' }),
      gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p1' }),
    })
    const notMyTurn = makeEntry({
      game: makeGame({ id: 'g3', room_code: 'CCCCC', updated_at: '2026-01-03T00:00:00Z' }),
      gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p2' }),
    })

    const ordered = orderInProgressForUser([myTurnNewer, notMyTurn, myTurnOlder], 'auth_1')
    expect(ordered.map((e) => e.game.id)).toEqual(['g2', 'g1', 'g3'])
  })

  it('sorts the rest most-recently-updated first', () => {
    const older = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', updated_at: '2026-01-01T00:00:00Z' }),
      gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p2' }),
    })
    const newer = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', updated_at: '2026-01-05T00:00:00Z' }),
      gameState: makeActiveState({ roundPhase: 'actions', activePlayerId: 'p2' }),
    })

    const ordered = orderInProgressForUser([older, newer], 'auth_1')
    expect(ordered.map((e) => e.game.id)).toEqual(['g2', 'g1'])
  })
})

describe('orderNotStartedForUser', () => {
  it("puts the user's own rooms first, each group most-recently-updated first", () => {
    const mineOlder = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', status: 'lobby', updated_at: '2026-01-01T00:00:00Z' }),
      gameState: null,
    })
    const othersNewer = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', status: 'lobby', updated_at: '2026-01-05T00:00:00Z' }),
      gameState: null,
      players: makePlayers('g2', 2).map((p) => ({ ...p, user_id: `other_${p.user_id}` })),
    })
    const mineNewer = makeEntry({
      game: makeGame({ id: 'g3', room_code: 'CCCCC', status: 'lobby', updated_at: '2026-01-03T00:00:00Z' }),
      gameState: null,
    })

    const ordered = orderNotStartedForUser([mineOlder, othersNewer, mineNewer], 'auth_1')
    expect(ordered.map((e) => e.game.id)).toEqual(['g3', 'g1', 'g2'])
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

  it('sorts finished rooms by completion time (gameStateUpdatedAt), not the lobby-era game.updated_at', () => {
    // g1 started (left the lobby) before g2 but ran longer, so it actually finished after g2.
    const startedEarlyFinishedLate = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', status: 'active', updated_at: '2026-01-01T00:00:00Z' }),
      gameState: makeActiveState({ status: 'completed' }),
      gameStateUpdatedAt: '2026-01-10T00:00:00Z',
    })
    const startedLateFinishedEarly = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', status: 'active', updated_at: '2026-01-05T00:00:00Z' }),
      gameState: makeActiveState({ status: 'completed' }),
      gameStateUpdatedAt: '2026-01-06T00:00:00Z',
    })

    const grouped = groupPublicRooms([startedEarlyFinishedLate, startedLateFinishedEarly])
    expect(grouped.finished.map((e) => e.game.id)).toEqual(['g1', 'g2'])
  })
})

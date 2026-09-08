import { describe, expect, it } from 'vitest'
import {
  formatUpdatedAt,
  groupMyGames,
  isCanceled,
  isFinished,
  isMyTurn,
  myGameStatus,
  pendingActorIds,
  type MyGameEntry,
} from '../myGamesView'
import type { GameStateSummary } from '../gameCardView'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes'

function makeGame(overrides: Partial<GameRow> = {}, settingsOverrides: Partial<GameSettings> = {}): GameRow {
  return {
    id: 'game_1',
    room_code: 'ABCDE',
    name: 'Test room',
    play_mode: 'live',
    status: 'active',
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
      hiddenInformationEnabled: false,
      activeTaleIds: [],
      gameLength: 4,
      ...settingsOverrides,
    },
    config_version: 0,
    visibility: 'private',
    ...overrides,
  }
}

function makePlayers(gameId: string): PlayerRow[] {
  return [
    { id: 'p1', game_id: gameId, user_id: 'auth_1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '', ready_for_version: 0 },
    { id: 'p2', game_id: gameId, user_id: 'auth_2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '', ready_for_version: 0 },
  ]
}

function makeSummary(overrides: Partial<GameStateSummary> = {}): GameStateSummary {
  return { status: 'active', roundPhase: 'actions', turn: 1, activePlayerId: 'p1', pendingPlayerIds: [], ...overrides }
}

function makeEntry(overrides: Partial<MyGameEntry> = {}): MyGameEntry {
  const game = makeGame()
  const players = makePlayers(game.id)
  return {
    game,
    players,
    stateSummary: makeSummary(),
    gameStateUpdatedAt: null,
    myPlayerIds: ['p1'],
    ...overrides,
  }
}

describe('myGameStatus', () => {
  it('reports lobby for a game with no state yet', () => {
    expect(myGameStatus(makeEntry({ stateSummary: null }))).toBe('lobby')
  })

  it('reads the status off stateSummary, not games.status (which never records boardSetup/completed)', () => {
    expect(myGameStatus(makeEntry({ stateSummary: makeSummary({ status: 'completed', roundPhase: null }) }))).toBe('completed')
  })

  it('reports canceled off games.status even with a live (pre-cancel) stateSummary', () => {
    expect(myGameStatus(makeEntry({ game: makeGame({ status: 'canceled' }) }))).toBe('canceled')
  })

  it('reports canceled for a room canceled before it ever started (no stateSummary row yet)', () => {
    expect(myGameStatus(makeEntry({ game: makeGame({ status: 'canceled' }), stateSummary: null }))).toBe('canceled')
  })
})

describe('isFinished', () => {
  it('is false for an in-progress game', () => {
    expect(isFinished(makeEntry())).toBe(false)
  })

  it('is true once stateSummary.status is completed', () => {
    expect(isFinished(makeEntry({ stateSummary: makeSummary({ status: 'completed', roundPhase: null }) }))).toBe(true)
  })

  it('is false for a canceled game', () => {
    expect(isFinished(makeEntry({ game: makeGame({ status: 'canceled' }) }))).toBe(false)
  })
})

describe('isCanceled', () => {
  it('is false for an in-progress game', () => {
    expect(isCanceled(makeEntry())).toBe(false)
  })

  it('is true once games.status is canceled', () => {
    expect(isCanceled(makeEntry({ game: makeGame({ status: 'canceled' }) }))).toBe(true)
  })
})

describe('isMyTurn', () => {
  it('is false with no game_state row yet (lobby)', () => {
    expect(isMyTurn(makeEntry({ stateSummary: null, myPlayerIds: ['p1'] }))).toBe(false)
  })

  it('is true when one of my seats is the active player', () => {
    expect(isMyTurn(makeEntry({ myPlayerIds: ['p1'], stateSummary: makeSummary({ activePlayerId: 'p1' }) }))).toBe(true)
  })

  it('is false when a different seat is active', () => {
    expect(isMyTurn(makeEntry({ myPlayerIds: ['p1'], stateSummary: makeSummary({ activePlayerId: 'p2' }) }))).toBe(false)
  })

  it('checks every seat I hold, e.g. a hotseat host with several local players', () => {
    expect(isMyTurn(makeEntry({ myPlayerIds: ['p1', 'p2'], stateSummary: makeSummary({ activePlayerId: 'p2' }) }))).toBe(true)
  })

  // game_state_meta.pending_player_ids (issue #441 follow-up) mirrors
  // state.pendingPlayerIds during a simultaneous phase, so this can tell
  // when one of my seats is one of the players still pending.
  it('is true during a simultaneous phase when one of my seats is really pending', () => {
    expect(
      isMyTurn(
        makeEntry({
          myPlayerIds: ['p1'],
          stateSummary: makeSummary({ roundPhase: 'selectCards', activePlayerId: null, pendingPlayerIds: ['p1', 'p2'] }),
        }),
      ),
    ).toBe(true)
  })

  it('is false during a simultaneous phase when none of my seats is pending', () => {
    expect(
      isMyTurn(
        makeEntry({
          myPlayerIds: ['p1'],
          stateSummary: makeSummary({ roundPhase: 'selectCards', activePlayerId: null, pendingPlayerIds: ['p2'] }),
        }),
      ),
    ).toBe(false)
  })
})

describe('pendingActorIds', () => {
  it('is empty with no game_state row yet (lobby)', () => {
    expect(pendingActorIds(makeEntry({ stateSummary: null }))).toEqual([])
  })

  it('returns the active player when one player is up', () => {
    expect(pendingActorIds(makeEntry({ stateSummary: makeSummary({ activePlayerId: 'p2' }) }))).toEqual(['p2'])
  })

  it('is empty once the game is completed', () => {
    expect(pendingActorIds(makeEntry({ stateSummary: makeSummary({ status: 'completed', roundPhase: null }) }))).toEqual([])
  })
})

describe('formatUpdatedAt', () => {
  const now = new Date('2026-01-02T12:00:00Z')

  it('reports "just now" for sub-minute updates', () => {
    expect(formatUpdatedAt('2026-01-02T11:59:45Z', now)).toBe('Updated just now')
  })

  it('reports minutes ago within the last hour', () => {
    expect(formatUpdatedAt('2026-01-02T11:45:00Z', now)).toBe('Updated 15m ago')
  })

  it('reports hours ago within the last day', () => {
    expect(formatUpdatedAt('2026-01-02T09:00:00Z', now)).toBe('Updated 3h ago')
  })

  it('reports days ago within the last week', () => {
    expect(formatUpdatedAt('2025-12-31T12:00:00Z', now)).toBe('Updated 2d ago')
  })

  it('falls back to a date for updates a week or older', () => {
    expect(formatUpdatedAt('2025-12-20T12:00:00Z', now)).toBe(`Updated ${new Date('2025-12-20T12:00:00Z').toLocaleDateString()}`)
  })
})

describe('groupMyGames', () => {
  it('splits active, finished, and canceled games', () => {
    const activeEntry = makeEntry({ game: makeGame({ id: 'g1', room_code: 'AAAAA' }) })
    const finishedEntry = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB' }),
      stateSummary: makeSummary({ status: 'completed', roundPhase: null }),
    })
    const canceledEntry = makeEntry({
      game: makeGame({ id: 'g3', room_code: 'CCCCC', status: 'canceled' }),
    })

    const { active, finished, canceled } = groupMyGames([activeEntry, finishedEntry, canceledEntry])

    expect(active.map((e) => e.game.id)).toEqual(['g1'])
    expect(finished.map((e) => e.game.id)).toEqual(['g2'])
    expect(canceled.map((e) => e.game.id)).toEqual(['g3'])
  })

  it('sorts active games with "your turn" first, ties broken by most-recently-updated', () => {
    const notMyTurn = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', updated_at: '2026-01-03T00:00:00Z' }),
      myPlayerIds: ['p1'],
      stateSummary: makeSummary({ activePlayerId: 'p2' }),
    })
    const myTurnOlder = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', updated_at: '2026-01-01T00:00:00Z' }),
      myPlayerIds: ['p1'],
      stateSummary: makeSummary({ activePlayerId: 'p1' }),
    })
    const myTurnNewer = makeEntry({
      game: makeGame({ id: 'g3', room_code: 'CCCCC', updated_at: '2026-01-02T00:00:00Z' }),
      myPlayerIds: ['p1'],
      stateSummary: makeSummary({ activePlayerId: 'p1' }),
    })

    const { active } = groupMyGames([notMyTurn, myTurnOlder, myTurnNewer])

    expect(active.map((e) => e.game.id)).toEqual(['g3', 'g2', 'g1'])
  })

  it('sorts finished games most-recently-updated first', () => {
    const older = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', updated_at: '2026-01-01T00:00:00Z' }),
      stateSummary: makeSummary({ status: 'completed', roundPhase: null }),
    })
    const newer = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', updated_at: '2026-01-05T00:00:00Z' }),
      stateSummary: makeSummary({ status: 'completed', roundPhase: null }),
    })

    const { finished } = groupMyGames([older, newer])

    expect(finished.map((e) => e.game.id)).toEqual(['g2', 'g1'])
  })

  it('sorts finished games by completion time (gameStateUpdatedAt), not the lobby-era game.updated_at', () => {
    // g1 started (left the lobby) before g2 but ran longer, so it actually finished after g2.
    const startedEarlyFinishedLate = makeEntry({
      game: makeGame({ id: 'g1', room_code: 'AAAAA', updated_at: '2026-01-01T00:00:00Z' }),
      stateSummary: makeSummary({ status: 'completed', roundPhase: null }),
      gameStateUpdatedAt: '2026-01-10T00:00:00Z',
    })
    const startedLateFinishedEarly = makeEntry({
      game: makeGame({ id: 'g2', room_code: 'BBBBB', updated_at: '2026-01-05T00:00:00Z' }),
      stateSummary: makeSummary({ status: 'completed', roundPhase: null }),
      gameStateUpdatedAt: '2026-01-06T00:00:00Z',
    })

    const { finished } = groupMyGames([startedEarlyFinishedLate, startedLateFinishedEarly])

    expect(finished.map((e) => e.game.id)).toEqual(['g1', 'g2'])
  })
})

import { describe, expect, it } from 'vitest'
import { allPlayersReady, canStartGame, isPlayerReady } from '../roomReadiness'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes'

function makeGame(overrides: Partial<GameRow> = {}, settingsOverrides: Partial<GameSettings> = {}): GameRow {
  return {
    id: 'game_1',
    room_code: 'ABCDE',
    name: 'Test room',
    play_mode: 'live',
    status: 'lobby',
    min_players: 2,
    max_players: 4,
    created_by: 'auth_owner',
    created_at: '',
    updated_at: '',
    settings: { mapTemplateId: null, mapPoolBoard: null, mapPoolMapId: null, mapPoolRandomAtStart: false, skipHotseatPassGate: false, activeTaleIds: [], gameLength: 4, ...settingsOverrides },
    config_version: 0,
    visibility: 'private',
    ...overrides,
  }
}

function makePlayer(overrides: Partial<PlayerRow> = {}): PlayerRow {
  return {
    id: 'p1',
    game_id: 'game_1',
    user_id: 'auth_2',
    display_name: 'Bob',
    avatar_url: null,
    seat_index: 1,
    color: '#3b82f6',
    is_active: true,
    joined_at: '',
    ready_for_version: 0,
    ...overrides,
  }
}

describe('isPlayerReady', () => {
  it('is always true for the Owner, regardless of ready_for_version', () => {
    const game = makeGame({ config_version: 3 })
    const owner = makePlayer({ user_id: game.created_by, ready_for_version: 0 })
    expect(isPlayerReady(game, owner)).toBe(true)
  })

  it('is true for a non-Owner whose ready_for_version matches the current config_version', () => {
    const game = makeGame({ config_version: 2 })
    expect(isPlayerReady(game, makePlayer({ ready_for_version: 2 }))).toBe(true)
  })

  it('is false for a non-Owner left behind by a config change', () => {
    const game = makeGame({ config_version: 2 })
    expect(isPlayerReady(game, makePlayer({ ready_for_version: 1 }))).toBe(false)
  })
})

describe('allPlayersReady', () => {
  it('is true when every non-Owner player is ready', () => {
    const game = makeGame({ config_version: 1 })
    const players = [
      makePlayer({ id: 'p1', user_id: game.created_by, ready_for_version: 0 }),
      makePlayer({ id: 'p2', user_id: 'auth_2', ready_for_version: 1 }),
    ]
    expect(allPlayersReady(game, players)).toBe(true)
  })

  it('is false when at least one non-Owner player is stale', () => {
    const game = makeGame({ config_version: 1 })
    const players = [
      makePlayer({ id: 'p1', user_id: game.created_by, ready_for_version: 0 }),
      makePlayer({ id: 'p2', user_id: 'auth_2', ready_for_version: 1 }),
      makePlayer({ id: 'p3', user_id: 'auth_3', ready_for_version: 0 }),
    ]
    expect(allPlayersReady(game, players)).toBe(false)
  })

  it('is vacuously true with no players seated yet', () => {
    expect(allPlayersReady(makeGame({ config_version: 5 }), [])).toBe(true)
  })
})

describe('canStartGame', () => {
  it('requires lobby status', () => {
    const game = makeGame({ status: 'active' })
    const players = [makePlayer({ id: 'p1', user_id: game.created_by }), makePlayer({ id: 'p2' })]
    expect(canStartGame(game, players)).toBe(false)
  })

  it('requires at least min_players', () => {
    const game = makeGame({ min_players: 2 })
    const players = [makePlayer({ id: 'p1', user_id: game.created_by })]
    expect(canStartGame(game, players)).toBe(false)
  })

  it('rejects more than max_players', () => {
    const game = makeGame({ min_players: 2, max_players: 2 })
    const players = [
      makePlayer({ id: 'p1', user_id: game.created_by }),
      makePlayer({ id: 'p2' }),
      makePlayer({ id: 'p3' }),
    ]
    expect(canStartGame(game, players)).toBe(false)
  })

  it('blocks on an unready player even with enough players', () => {
    const game = makeGame({ min_players: 2, config_version: 1 })
    const players = [
      makePlayer({ id: 'p1', user_id: game.created_by }),
      makePlayer({ id: 'p2', ready_for_version: 0 }),
    ]
    expect(canStartGame(game, players)).toBe(false)
  })

  it('is true once player count is in range and everyone is ready', () => {
    const game = makeGame({ min_players: 2, config_version: 1 })
    const players = [
      makePlayer({ id: 'p1', user_id: game.created_by }),
      makePlayer({ id: 'p2', ready_for_version: 1 }),
    ]
    expect(canStartGame(game, players)).toBe(true)
  })
})

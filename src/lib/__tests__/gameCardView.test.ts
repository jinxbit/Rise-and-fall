import { describe, expect, it } from 'vitest'
import { resolveAchievementContent, resolveTaleContent } from '../../content/resolveContent'
import { createEmptyBoard } from '../../engine/board'
import { createNewGame } from '../../engine/createGame'
import { calculateVPBreakdown } from '../../engine/victoryPoints'
import type { GameState as EngineGameState } from '../../engine/types'
import { buildGameCardSummary, describeGamePhase, formatFinishedAt, latestUpdatedAt } from '../gameCardView'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes'

function makeSettings(overrides: Partial<GameSettings> = {}): GameSettings {
  return {
    mapTemplateId: null,
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
    ...overrides,
  }
}

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
    settings: makeSettings(settingsOverrides),
    config_version: 0,
    visibility: 'private',
    ...overrides,
  }
}

function makePlayerRow(id: string, displayName: string, color = '#ef4444'): PlayerRow {
  return {
    id,
    game_id: 'game_1',
    user_id: id,
    display_name: displayName,
    avatar_url: null,
    seat_index: 0,
    color,
    is_active: true,
    joined_at: '',
    ready_for_version: 0,
  }
}

function makeGameState(overrides: Partial<EngineGameState> = {}): EngineGameState {
  const state = createNewGame({
    gameId: 'game_1',
    playMode: 'live',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: 'p1', displayName: 'Alice', color: '#ef4444' },
      { id: 'p2', authUserId: 'p2', displayName: 'Bob', color: '#3b82f6' },
    ],
  })
  return { ...state, status: 'active', ...overrides }
}

describe('buildGameCardSummary', () => {
  it('shows pregame info (player range, map build style) and no scores/round while the game has not started', () => {
    const game = makeGame({ min_players: 2, max_players: 4 })
    const summary = buildGameCardSummary(game, null, [])

    expect(summary.playerRange).toBe('2–4 players')
    expect(summary.mapBuildStyle).toBe('Interactive (built together)')
    expect(summary.roundNumber).toBeNull()
    expect(summary.scores).toBeNull()
  })

  it('clears pregame info once a GameState exists, and reports the round number instead', () => {
    const game = makeGame()
    const state = makeGameState({ turn: 3 })
    const summary = buildGameCardSummary(game, state, [])

    expect(summary.playerRange).toBeNull()
    expect(summary.mapBuildStyle).toBeNull()
    expect(summary.roundNumber).toBe(3)
  })

  it('does not crash and reports no scores when a persisted GameState is missing its players array (issue #389)', () => {
    const game = makeGame()
    const state = makeGameState()
    const malformedState = { ...state, players: undefined } as unknown as EngineGameState
    const summary = buildGameCardSummary(game, malformedState, [])

    expect(summary.scores).toBeNull()
  })

  it('resolves active Tale ids to their names, falling back to the id for an unknown one', () => {
    const game = makeGame({}, { activeTaleIds: ['the-capital', 'not-a-real-tale'] })
    const summary = buildGameCardSummary(game, null, [])

    expect(summary.moduleNames).toEqual(['The Capital', 'not-a-real-tale'])
  })

  describe('mapBuildStyle', () => {
    it('names a map template when one is chosen', () => {
      const game = makeGame({}, { mapTemplateId: 'classic' })
      expect(buildGameCardSummary(game, null, []).mapBuildStyle).not.toBe('Interactive (built together)')
    })

    it('labels a saved-pool board as a random saved map', () => {
      const game = makeGame({}, { mapPoolBoard: createEmptyBoard('hex') })
      expect(buildGameCardSummary(game, null, []).mapBuildStyle).toBe('Random saved map')
    })

    it('labels random-at-start mode', () => {
      const game = makeGame({}, { mapPoolRandomAtStart: true })
      expect(buildGameCardSummary(game, null, []).mapBuildStyle).toBe('Random saved map (picked at start)')
    })

    it('labels solo-build mode by the owner', () => {
      const game = makeGame({}, { soloBuildMap: true, soloBuilderSelection: 'owner' })
      expect(buildGameCardSummary(game, null, []).mapBuildStyle).toBe('Interactive (built alone by the host)')
    })

    it('labels solo-build mode by a random player', () => {
      const game = makeGame({}, { soloBuildMap: true, soloBuilderSelection: 'random' })
      expect(buildGameCardSummary(game, null, []).mapBuildStyle).toBe('Interactive (built alone by a random player)')
    })
  })

  it('computes each seated player\'s current total VP once a GameState exists, joined with their PlayerRow name/color', () => {
    const game = makeGame()
    const base = makeGameState()
    const state = { ...base, players: [{ ...base.players[0], resources: { gold: 5, wood: 0, stone: 0 } }, base.players[1]] }
    const players = [makePlayerRow('p1', 'Alice Row', '#ef4444'), makePlayerRow('p2', 'Bob Row', '#3b82f6')]
    const summary = buildGameCardSummary(game, state, players)

    const achievementContent = resolveAchievementContent(state.gameLength)
    const taleContent = resolveTaleContent(state.activeTaleIds, state.players.length)
    const expectedBreakdown = calculateVPBreakdown(state, achievementContent, taleContent)

    expect(summary.scores).toEqual([
      { playerId: 'p1', name: 'Alice Row', color: '#ef4444', score: expectedBreakdown.p1.total, isWinner: false },
      { playerId: 'p2', name: 'Bob Row', color: '#3b82f6', score: expectedBreakdown.p2.total, isWinner: false },
    ])
  })

  it('falls back to the engine player\'s own displayName/color when no matching PlayerRow is given', () => {
    const game = makeGame()
    const state = makeGameState()
    const summary = buildGameCardSummary(game, state, [])

    expect(summary.scores?.map((s) => s.name)).toEqual(['Alice', 'Bob'])
  })

  it('marks the winning score(s) once the game has finished, and marks none otherwise', () => {
    const game = makeGame()
    const players = [makePlayerRow('p1', 'Alice Row'), makePlayerRow('p2', 'Bob Row')]

    const inProgress = makeGameState({ winnerPlayerIds: [] })
    expect(buildGameCardSummary(game, inProgress, players).scores?.map((s) => s.isWinner)).toEqual([false, false])

    const finished = makeGameState({ status: 'completed', winnerPlayerIds: ['p2'] })
    expect(buildGameCardSummary(game, finished, players).scores?.map((s) => s.isWinner)).toEqual([false, true])
  })
})

describe('latestUpdatedAt', () => {
  it("falls back to games.updated_at when there's no game_state row yet (lobby)", () => {
    const game = makeGame({ updated_at: '2026-01-01T00:00:00Z' })
    expect(latestUpdatedAt(game, null)).toBe('2026-01-01T00:00:00Z')
  })

  it('prefers game_state.updated_at once it is more recent — gameplay actions only touch that row, not games.updated_at', () => {
    const game = makeGame({ updated_at: '2026-01-01T00:00:00Z' })
    expect(latestUpdatedAt(game, '2026-01-02T00:00:00Z')).toBe('2026-01-02T00:00:00Z')
  })

  it('falls back to games.updated_at when it is the more recent of the two (e.g. a settings edit right after insertGameState)', () => {
    const game = makeGame({ updated_at: '2026-01-05T00:00:00Z' })
    expect(latestUpdatedAt(game, '2026-01-02T00:00:00Z')).toBe('2026-01-05T00:00:00Z')
  })
})

describe('formatFinishedAt', () => {
  it('renders an absolute local date/time prefixed with "Finished at", without seconds', () => {
    const isoTimestamp = '2026-01-02T09:00:00Z'
    const expected = new Date(isoTimestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    expect(formatFinishedAt(isoTimestamp)).toBe(`Finished at ${expected}`)
    expect(formatFinishedAt(isoTimestamp)).not.toMatch(/:\d{2}:\d{2}\s/)
  })
})

describe('describeGamePhase', () => {
  it('reports the lobby before a game_state row exists', () => {
    expect(describeGamePhase(makeGame({ status: 'lobby' }), null)).toBe('Waiting in lobby')
  })

  it('reports canceled off games.status even with a live (pre-cancel) gameState', () => {
    expect(describeGamePhase(makeGame({ status: 'canceled' }), makeGameState())).toBe('Canceled')
  })

  it('reports board setup', () => {
    expect(describeGamePhase(makeGame(), makeGameState({ status: 'boardSetup' }))).toBe('Setting up board')
  })

  it('reports finished once gameState.status is completed', () => {
    expect(describeGamePhase(makeGame(), makeGameState({ status: 'completed' }))).toBe('Finished')
  })

  it.each([
    ['selectCards', 'Choosing cards'],
    ['actions', 'Resolving actions'],
    ['decline', 'Declining cards'],
    ['purchase', 'Purchasing'],
  ] as const)('reports the round phase %s as %s while active', (roundPhase, label) => {
    expect(describeGamePhase(makeGame(), makeGameState({ roundPhase }))).toBe(label)
  })
})

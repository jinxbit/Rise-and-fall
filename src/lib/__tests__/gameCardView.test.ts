import { describe, expect, it } from 'vitest'
import { createEmptyBoard } from '../../engine/board'
import type { RoundPhase } from '../../engine/types'
import { buildGameCardSummary, describeGamePhase, formatFinishedAt, isMyTurnFor, latestUpdatedAt, pendingActorIdsFor, type GameStateSummary } from '../gameCardView'
import type { GameRow, GameSettings } from '../dbTypes'

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
    hiddenInformationEnabled: false,
    lockRevealedInformationEnabled: false,
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

function makeSummary(overrides: Partial<GameStateSummary> = {}): GameStateSummary {
  return { status: 'active', roundPhase: 'actions', turn: 1, activePlayerId: 'p1', pendingPlayerIds: [], ...overrides }
}

describe('buildGameCardSummary', () => {
  it('shows pregame info (player range, map build style) and no round number while the game has not started', () => {
    const game = makeGame({ min_players: 2, max_players: 4 })
    const summary = buildGameCardSummary(game, null)

    expect(summary.playerRange).toBe('2–4 players')
    expect(summary.mapBuildStyle).toBe('Interactive (built together)')
    expect(summary.roundNumber).toBeNull()
  })

  it('clears pregame info once a GameStateSummary exists, and reports the round number instead', () => {
    const game = makeGame()
    const summary = buildGameCardSummary(game, makeSummary({ turn: 3 }))

    expect(summary.playerRange).toBeNull()
    expect(summary.mapBuildStyle).toBeNull()
    expect(summary.roundNumber).toBe(3)
  })

  it('resolves active Tale ids to their names, falling back to the id for an unknown one', () => {
    const game = makeGame({}, { activeTaleIds: ['the-capital', 'not-a-real-tale'] })
    const summary = buildGameCardSummary(game, null)

    expect(summary.moduleNames).toEqual(['The Capital', 'not-a-real-tale'])
  })

  describe('mapBuildStyle', () => {
    it('names a map template when one is chosen', () => {
      const game = makeGame({}, { mapTemplateId: 'classic' })
      expect(buildGameCardSummary(game, null).mapBuildStyle).not.toBe('Interactive (built together)')
    })

    it('labels a saved-pool board as a random saved map', () => {
      const game = makeGame({}, { mapPoolBoard: createEmptyBoard('hex') })
      expect(buildGameCardSummary(game, null).mapBuildStyle).toBe('Random saved map')
    })

    it('labels random-at-start mode', () => {
      const game = makeGame({}, { mapPoolRandomAtStart: true })
      expect(buildGameCardSummary(game, null).mapBuildStyle).toBe('Random saved map (picked at start)')
    })

    it('labels solo-build mode by the owner', () => {
      const game = makeGame({}, { soloBuildMap: true, soloBuilderSelection: 'owner' })
      expect(buildGameCardSummary(game, null).mapBuildStyle).toBe('Interactive (built alone by the host)')
    })

    it('labels solo-build mode by a random player', () => {
      const game = makeGame({}, { soloBuildMap: true, soloBuilderSelection: 'random' })
      expect(buildGameCardSummary(game, null).mapBuildStyle).toBe('Interactive (built alone by a random player)')
    })
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

  it('reports canceled off games.status even with a live (pre-cancel) summary', () => {
    expect(describeGamePhase(makeGame({ status: 'canceled' }), makeSummary())).toBe('Canceled')
  })

  it('reports board setup', () => {
    expect(describeGamePhase(makeGame(), makeSummary({ status: 'boardSetup', roundPhase: null }))).toBe('Setting up board')
  })

  it('reports finished once the summary status is completed', () => {
    expect(describeGamePhase(makeGame(), makeSummary({ status: 'completed', roundPhase: null }))).toBe('Finished')
  })

  it.each([
    ['selectCards', 'Choosing cards'],
    ['actions', 'Resolving actions'],
    ['decline', 'Declining cards'],
    ['purchase', 'Purchasing'],
  ] as const)('reports the round phase %s as %s while active', (roundPhase: RoundPhase, label: string) => {
    expect(describeGamePhase(makeGame(), makeSummary({ roundPhase }))).toBe(label)
  })
})

describe('pendingActorIdsFor', () => {
  it('is empty with no game_state row yet (lobby)', () => {
    expect(pendingActorIdsFor(null)).toEqual([])
  })

  it('returns the active player during a turn-order phase', () => {
    expect(pendingActorIdsFor(makeSummary({ roundPhase: 'actions', activePlayerId: 'p2' }))).toEqual(['p2'])
  })

  it('is empty once the game is completed', () => {
    expect(pendingActorIdsFor(makeSummary({ status: 'completed', roundPhase: null }))).toEqual([])
  })

  // game_state_meta.pending_player_ids (0027_game_state_meta_pending_players.sql,
  // updated by 0030_purchase_phase_simultaneous.sql for issue #553) mirrors
  // state.pendingPlayerIds during these simultaneous phases: everyone still
  // owed a turn at once, not just one "active" player.
  it('returns everyone still pending during a simultaneous selectCards/decline/purchase phase', () => {
    expect(
      pendingActorIdsFor(makeSummary({ roundPhase: 'selectCards', activePlayerId: null, pendingPlayerIds: ['p1', 'p2'] })),
    ).toEqual(['p1', 'p2'])
    expect(
      pendingActorIdsFor(makeSummary({ roundPhase: 'decline', activePlayerId: null, pendingPlayerIds: ['p2'] })),
    ).toEqual(['p2'])
    expect(
      pendingActorIdsFor(makeSummary({ roundPhase: 'purchase', activePlayerId: null, pendingPlayerIds: ['p1', 'p2'] })),
    ).toEqual(['p1', 'p2'])
  })

  // decline's pendingPlayerIds can repeat a player id (once per card still
  // owed) — pendingActorIdsFor collapses that to the distinct set of ids.
  it('dedupes repeated ids in a simultaneous phase', () => {
    expect(
      pendingActorIdsFor(makeSummary({ roundPhase: 'decline', activePlayerId: null, pendingPlayerIds: ['p1', 'p1', 'p2'] })),
    ).toEqual(['p1', 'p2'])
  })

  // The board-setup tile/unit placer (engine/boardSetup.ts's
  // currentTilePlacerId/currentUnitPlacerId) is derived by the same trigger
  // into pending_player_ids, so this can recover it from GameStateSummary
  // alone.
  it('returns the current placer during board setup', () => {
    expect(pendingActorIdsFor(makeSummary({ status: 'boardSetup', roundPhase: null, pendingPlayerIds: ['p2'] }))).toEqual(['p2'])
  })

  it('is empty during board setup with nobody currently placing (e.g. between tile and unit placement)', () => {
    expect(pendingActorIdsFor(makeSummary({ status: 'boardSetup', roundPhase: null, pendingPlayerIds: [] }))).toEqual([])
  })
})

describe('isMyTurnFor', () => {
  it('is true when one of my seats is the active player', () => {
    expect(isMyTurnFor(makeSummary({ roundPhase: 'actions', activePlayerId: 'p1' }), ['p1'])).toBe(true)
  })

  it('is false when a different seat is active', () => {
    expect(isMyTurnFor(makeSummary({ roundPhase: 'actions', activePlayerId: 'p2' }), ['p1'])).toBe(false)
  })

  it('checks every seat I hold, e.g. a hotseat host with several local players', () => {
    expect(isMyTurnFor(makeSummary({ roundPhase: 'actions', activePlayerId: 'p2' }), ['p1', 'p2'])).toBe(true)
  })

  it('is false with no game_state row yet (lobby)', () => {
    expect(isMyTurnFor(null, ['p1'])).toBe(false)
  })
})

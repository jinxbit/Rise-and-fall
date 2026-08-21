import { describe, expect, it } from 'vitest'
import { applyAction } from '../../engine/applyAction'
import { replayActions } from '../../engine/replay'
import { buildGenesisState, resolveMapPoolRandomAtStart, resolveSoloBuildMap } from '../gameGenesis'
import type { GameRow, GameSettings, MapPoolRow, PlayerRow } from '../dbTypes'

function makeGame(overrides: Partial<GameRow> = {}, settingsOverrides: Partial<GameSettings> = {}): GameRow {
  return {
    id: 'game_1',
    room_code: 'ABCDE',
    name: 'Test room',
    play_mode: 'hotseat',
    status: 'lobby',
    min_players: 2,
    max_players: 4,
    created_by: 'auth_1',
    created_at: '',
    updated_at: '',
    settings: {
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
      activeTaleIds: [],
      gameLength: 4,
      ...settingsOverrides,
    },
    config_version: 0,
    visibility: 'private',
    ...overrides,
  }
}

function makePlayers(): PlayerRow[] {
  return [
    { id: 'p1', game_id: 'game_1', user_id: 'auth_1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '', ready_for_version: 0 },
    { id: 'p2', game_id: 'game_1', user_id: 'auth_2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '', ready_for_version: 0 },
  ]
}

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
    activeTaleIds: [],
    gameLength: 4,
    ...overrides,
  }
}

function makePoolRow(overrides: Partial<MapPoolRow> = {}): MapPoolRow {
  const board = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers()).board
  return { id: 'pool_1', player_count: 2, board, board_key: 'key', created_by: 'auth_1', created_at: '', ...overrides }
}

describe('buildGenesisState', () => {
  it('is deterministic: the same game/players always rebuild the same genesis', () => {
    const game = makeGame()
    const players = makePlayers()

    const first = buildGenesisState(game, players)
    const second = buildGenesisState(game, players)

    // Genesis's actionHistory is always empty (see GameState.actionHistory's
    // doc comment), so there's no wall-clock timestamp anywhere on it left
    // to strip before comparing.
    expect(first).toEqual(second)
  })

  it('without a map template, starts interactive board setup (tiles still to be placed)', () => {
    const genesis = buildGenesisState(makeGame({}, { mapTemplateId: null }), makePlayers())

    expect(genesis.status).toBe('boardSetup')
    expect(genesis.boardSetup?.tileTierQueue.length).toBeGreaterThan(0)
    expect(genesis.actionHistory).toEqual([])
  })

  it('with a map template, skips straight to unit placement on the preset board', () => {
    const genesis = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())

    expect(genesis.status).toBe('boardSetup')
    expect(genesis.boardSetup?.tileTierQueue).toEqual([])
    expect(Object.keys(genesis.board.tiles).length).toBeGreaterThan(50)
    expect(genesis.actionHistory).toEqual([])
  })

  it('with a mapPoolBoard, skips straight to unit placement on that exact board (same mechanism as a map template)', () => {
    const poolBoard = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers()).board
    const genesis = buildGenesisState(makeGame({}, { mapTemplateId: null, mapPoolBoard: poolBoard }), makePlayers())

    expect(genesis.status).toBe('boardSetup')
    expect(genesis.boardSetup?.tileTierQueue).toEqual([])
    expect(genesis.board).toEqual(poolBoard)
  })

  it('prefers mapTemplateId over mapPoolBoard if both are somehow set', () => {
    const templateGenesis = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())
    const otherBoard = buildGenesisState(makeGame({}, { mapTemplateId: null }), makePlayers()).board
    const genesis = buildGenesisState(makeGame({}, { mapTemplateId: 'classic', mapPoolBoard: otherBoard }), makePlayers())

    expect(genesis.board).toEqual(templateGenesis.board)
  })

  it('throws for an unknown map template id', () => {
    expect(() => buildGenesisState(makeGame({}, { mapTemplateId: 'not-a-real-template' }), makePlayers())).toThrow(/Unknown map template/)
  })

  it('preserves seat order as turn order', () => {
    const genesis = buildGenesisState(makeGame(), makePlayers())
    expect(genesis.turnOrder).toEqual(['p1', 'p2'])
  })

  // GameState.activeTaleIds/gameLength carry the games row's creation-time
  // choice into the running game (see GameState's own doc comments) — once
  // genesis is built, GamePage.tsx reads these off gameState, not `game`,
  // so a game (and its game export) is self-contained.
  it("carries the game row's settings.activeTaleIds/gameLength into GameState", () => {
    const genesis = buildGenesisState(makeGame({}, { activeTaleIds: ['the-ports'], gameLength: 6 }), makePlayers())
    expect(genesis.activeTaleIds).toEqual(['the-ports'])
    expect(genesis.gameLength).toBe(6)
  })

  it('undo mechanism: replaying genesis + history.slice(0, -1) reconstructs the pre-action state', () => {
    // GamePage.tsx's handleUndo does exactly this: rebuild genesis (since
    // it isn't stored) and replay every logged action except the last one.
    const genesis = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())

    const step1 = applyAction(genesis, { type: 'PLACE_UNIT', playerId: 'p1', unitKind: 'city', coord: { q: 0, r: 0 } })
    if (!step1.ok) throw new Error(step1.error)
    expect(step1.state.units).toHaveLength(1)

    const rebuiltGenesis = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())
    const undone = replayActions(rebuiltGenesis, step1.state.actionHistory.slice(0, -1))

    expect(undone.units).toHaveLength(0)
    expect(undone.actionHistory).toEqual([])
    expect(undone.board).toEqual(rebuiltGenesis.board)
  })

  describe('"build alone" mode (soloBuildMap, issue #243)', () => {
    it("resolves the room creator's player id as builder by default (soloBuilderSelection: 'owner')", () => {
      const genesis = buildGenesisState(makeGame({ created_by: 'auth_2' }, { soloBuildMap: true }), makePlayers())
      expect(genesis.boardSetup?.builderId).toBe('p2')
    })

    it("uses the persisted soloBuilderId when soloBuilderSelection is 'random' — never re-rolls it itself", () => {
      const genesis = buildGenesisState(
        makeGame({ created_by: 'auth_1' }, { soloBuildMap: true, soloBuilderSelection: 'random', soloBuilderId: 'p2' }),
        makePlayers(),
      )
      expect(genesis.boardSetup?.builderId).toBe('p2')
    })

    it("moves the builder to the end of turnOrder when soloBuilderUnitOrder is 'last' (the default) — starting-unit placement still starts with whoever's now first", () => {
      const genesis = buildGenesisState(makeGame({ created_by: 'auth_1' }, { soloBuildMap: true }), makePlayers())
      expect(genesis.turnOrder).toEqual(['p2', 'p1'])
    })

    it("uses the persisted soloBuilderTurnOrder verbatim when soloBuilderUnitOrder is 'random'", () => {
      const genesis = buildGenesisState(
        makeGame({ created_by: 'auth_1' }, { soloBuildMap: true, soloBuilderUnitOrder: 'random', soloBuilderTurnOrder: ['p2', 'p1'] }),
        makePlayers(),
      )
      expect(genesis.turnOrder).toEqual(['p2', 'p1'])
    })

    it('leaves tile placement to the builder alone — everyone else is rejected', () => {
      const genesis = buildGenesisState(makeGame({ created_by: 'auth_1' }, { soloBuildMap: true }), makePlayers())
      expect(genesis.boardSetup?.tileTierQueue.length).toBeGreaterThan(0)

      const fromBuilder = applyAction(genesis, { type: 'PLACE_TILE', playerId: 'p1', anchor: { q: 100, r: 100 }, rotationSteps: 0 })
      const fromOther = applyAction(genesis, { type: 'PLACE_TILE', playerId: 'p2', anchor: { q: 100, r: 100 }, rotationSteps: 0 })
      // Both are far off-board (illegal placements either way), but only
      // the builder even gets past the turn-order check to reach that error.
      if (fromBuilder.ok || fromOther.ok) throw new Error('expected both to fail (off-board anchor)')
      expect(fromBuilder.error).not.toContain("not this player's turn")
      expect(fromOther.error).toContain("not this player's turn")
    })

    it('is a no-op (normal "build together" behavior) when soloBuildMap is off', () => {
      const genesis = buildGenesisState(makeGame({ created_by: 'auth_1' }, { soloBuildMap: false }), makePlayers())
      expect(genesis.boardSetup?.builderId ?? null).toBeNull()
      expect(genesis.turnOrder).toEqual(['p1', 'p2'])
    })
  })
})

describe('resolveMapPoolRandomAtStart', () => {
  it("locks a picked map's board/id into settings when random-at-start is active and nothing is locked in yet", () => {
    const settings = makeSettings({ mapPoolRandomAtStart: true })
    const picked = makePoolRow()

    const resolved = resolveMapPoolRandomAtStart(settings, picked)

    expect(resolved.mapPoolBoard).toEqual(picked.board)
    expect(resolved.mapPoolMapId).toBe(picked.id)
    expect(resolved.mapPoolRandomAtStart).toBe(true)
  })

  it('falls back to interactive board building (returns settings unchanged) when no saved map fits the actual player count', () => {
    const settings = makeSettings({ mapPoolRandomAtStart: true })

    const resolved = resolveMapPoolRandomAtStart(settings, null)

    expect(resolved).toBe(settings)
    expect(resolved.mapPoolBoard).toBeNull()
  })

  it('is a no-op when random-at-start is off', () => {
    const settings = makeSettings({ mapPoolRandomAtStart: false })
    const resolved = resolveMapPoolRandomAtStart(settings, makePoolRow())
    expect(resolved).toBe(settings)
  })

  it('is a no-op when a board is already locked in (e.g. a second call after the first already resolved it)', () => {
    const settings = makeSettings({ mapPoolRandomAtStart: true, mapPoolBoard: makePoolRow({ id: 'pool_1' }).board, mapPoolMapId: 'pool_1' })
    const resolved = resolveMapPoolRandomAtStart(settings, makePoolRow({ id: 'pool_2' }))
    expect(resolved).toBe(settings)
    expect(resolved.mapPoolMapId).toBe('pool_1')
  })
})

describe('resolveSoloBuildMap', () => {
  it("picks a builder among the seated players when soloBuilderSelection is 'random' and none is locked in yet", () => {
    const settings = makeSettings({ soloBuildMap: true, soloBuilderSelection: 'random' })
    const resolved = resolveSoloBuildMap(settings, makePlayers())
    expect(['p1', 'p2']).toContain(resolved.soloBuilderId)
  })

  it("rolls a full turn order among the seated players when soloBuilderUnitOrder is 'random' and none is locked in yet", () => {
    const settings = makeSettings({ soloBuildMap: true, soloBuilderUnitOrder: 'random' })
    const resolved = resolveSoloBuildMap(settings, makePlayers())
    expect(resolved.soloBuilderTurnOrder).not.toBeNull()
    expect([...(resolved.soloBuilderTurnOrder ?? [])].sort()).toEqual(['p1', 'p2'])
  })

  it("is a no-op when soloBuildMap is off, even if selection/order are 'random'", () => {
    const settings = makeSettings({ soloBuildMap: false, soloBuilderSelection: 'random', soloBuilderUnitOrder: 'random' })
    const resolved = resolveSoloBuildMap(settings, makePlayers())
    expect(resolved).toBe(settings)
  })

  it("is a no-op when soloBuilderSelection/soloBuilderUnitOrder are 'owner'/'last' — those resolve deterministically inside buildGenesisState instead", () => {
    const settings = makeSettings({ soloBuildMap: true, soloBuilderSelection: 'owner', soloBuilderUnitOrder: 'last' })
    const resolved = resolveSoloBuildMap(settings, makePlayers())
    expect(resolved).toBe(settings)
  })

  it('is a no-op when a builder is already locked in (e.g. a second call after the first already resolved it)', () => {
    const settings = makeSettings({ soloBuildMap: true, soloBuilderSelection: 'random', soloBuilderId: 'p1' })
    const resolved = resolveSoloBuildMap(settings, makePlayers())
    expect(resolved).toBe(settings)
    expect(resolved.soloBuilderId).toBe('p1')
  })

  it('is a no-op when a turn order is already locked in (e.g. a second call after the first already resolved it)', () => {
    const settings = makeSettings({ soloBuildMap: true, soloBuilderUnitOrder: 'random', soloBuilderTurnOrder: ['p2', 'p1'] })
    const resolved = resolveSoloBuildMap(settings, makePlayers())
    expect(resolved).toBe(settings)
    expect(resolved.soloBuilderTurnOrder).toEqual(['p2', 'p1'])
  })
})

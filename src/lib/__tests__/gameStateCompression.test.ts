import { describe, expect, it } from 'vitest'
import { buildGenesisState } from '../gameGenesis'
import { compressGameStateForStorage, decompressGameStateFromStorage } from '../gameStateCompression'
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
      ruleEnforcementEnabled: true,
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

describe('gameStateCompression', () => {
  it('round-trips a real game state through compress/decompress', async () => {
    const state = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())

    const compressed = await compressGameStateForStorage(state)
    expect(typeof compressed.__gz).toBe('string')

    const decompressed = await decompressGameStateFromStorage(compressed)
    expect(decompressed).toEqual(state)
  })

  it('is dramatically smaller than the pretty-printed JSON it replaces', async () => {
    const state = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())
    const pretty = JSON.stringify(state, null, 2)

    const compressed = await compressGameStateForStorage(state)

    expect(JSON.stringify(compressed).length).toBeLessThan(pretty.length / 2)
  })

  it('passes a legacy/client-trusted row (no __gz key) through unchanged', async () => {
    const state = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())

    const decompressed = await decompressGameStateFromStorage(state)

    expect(decompressed).toBe(state)
  })

  it('duplicates status/roundPhase/turn/pendingPlayerIds/turnOrder/boardSetup in plaintext, for the game_state_sync_meta trigger to read (issue #451)', async () => {
    const state = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())

    const compressed = await compressGameStateForStorage(state)

    expect(compressed.status).toBe(state.status)
    expect(compressed.roundPhase).toBe(state.roundPhase)
    expect(compressed.turn).toBe(state.turn)
    expect(compressed.pendingPlayerIds).toEqual(state.pendingPlayerIds)
    expect(compressed.turnOrder).toEqual(state.turnOrder)
    expect(compressed.boardSetup).toEqual(state.boardSetup)
  })
})

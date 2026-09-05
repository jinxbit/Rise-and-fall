import { describe, expect, it } from 'vitest'
import { buildGenesisState } from '../gameGenesis'
import { GAME_STATE_EXPORT_SCHEMA, decodeGameStateExport, encodeGameStateExport } from '../gameStateExport'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes'

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
      ruleEnforcementEnabled: false,
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

describe('gameStateExport', () => {
  it('round-trips a real game state through encode/decode', async () => {
    const state = buildGenesisState(makeGame(), makePlayers())

    const encoded = await encodeGameStateExport(state)
    const parsed = JSON.parse(encoded)
    expect(parsed.schema).toBe(GAME_STATE_EXPORT_SCHEMA)
    expect(typeof parsed.gameStateZipped).toBe('string')

    const envelope = await decodeGameStateExport(encoded)
    expect(envelope.schema).toBe(GAME_STATE_EXPORT_SCHEMA)
    expect(envelope.gameState).toEqual(state)
  })

  it('is dramatically smaller than the pretty-printed JSON it replaces', async () => {
    const state = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())
    const pretty = JSON.stringify(state, null, 2)

    const encoded = await encodeGameStateExport(state)

    expect(encoded.length).toBeLessThan(pretty.length / 2)
  })

  it('rejects text that is not valid JSON', async () => {
    await expect(decodeGameStateExport('not json at all')).rejects.toThrow(/recognized game state export/)
  })

  it('rejects an object whose schema does not match', async () => {
    await expect(decodeGameStateExport('{"not": "an export"}')).rejects.toThrow(/schema/)
  })
})

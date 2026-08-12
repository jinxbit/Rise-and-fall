import { describe, expect, it } from 'vitest'
import { buildGenesisState } from '../gameGenesis'
import { GAME_STATE_EXPORT_SCHEMA, decodeGameStateExport, encodeGameStateExport } from '../gameStateExport'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes'

function makeGame(overrides: Partial<GameRow> = {}, settingsOverrides: Partial<GameSettings> = {}): GameRow {
  return {
    id: 'game_1',
    room_code: 'ABCDE',
    play_mode: 'hotseat',
    status: 'lobby',
    min_players: 2,
    max_players: 4,
    created_by: 'auth_1',
    created_at: '',
    updated_at: '',
    settings: { mapTemplateId: null, skipHotseatPassGate: false, activeTaleIds: [], gameLength: 4, ...settingsOverrides },
    ...overrides,
  }
}

function makePlayers(): PlayerRow[] {
  return [
    { id: 'p1', game_id: 'game_1', user_id: 'auth_1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '' },
    { id: 'p2', game_id: 'game_1', user_id: 'auth_2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '' },
  ]
}

describe('gameStateExport', () => {
  it('round-trips a real game state through encode/decode', async () => {
    const state = buildGenesisState(makeGame(), makePlayers())

    const encoded = await encodeGameStateExport(state)
    expect(encoded.startsWith('RAF-STATE-1:')).toBe(true)

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

  it('rejects text that is not one of its exports', async () => {
    await expect(decodeGameStateExport('{"not": "an export"}')).rejects.toThrow(/RAF-STATE-1/)
  })

  it('rejects a blob whose schema does not match', async () => {
    const foreign = btoa('irrelevant')
    await expect(decodeGameStateExport(`RAF-STATE-1:${foreign}`)).rejects.toThrow()
  })
})

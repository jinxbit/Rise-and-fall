import { describe, expect, it } from 'vitest'
import { buildGenesisState } from '../gameGenesis'
import { remapGameSettingsPlayerIds, remapGameStatePlayerIds } from '../duplicateGameState'
import type { GameRow, GameSettings, PlayerRow } from '../dbTypes'

function makeGame(overrides: Partial<GameRow> = {}, settingsOverrides: Partial<GameSettings> = {}): GameRow {
  return {
    id: 'game_1',
    room_code: 'ABCDE',
    name: 'Test room',
    play_mode: 'hotseat',
    status: 'active',
    min_players: 2,
    max_players: 4,
    created_by: 'auth_1',
    created_at: '',
    updated_at: '',
    settings: makeSettings(settingsOverrides),
    config_version: 0,
    visibility: 'private',
    ...overrides,
  }
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

function makePlayers(): PlayerRow[] {
  return [
    { id: 'p1', game_id: 'game_1', user_id: 'auth_1', display_name: 'Alice', avatar_url: null, seat_index: 0, color: '#ef4444', is_active: true, joined_at: '', ready_for_version: 0 },
    { id: 'p2', game_id: 'game_1', user_id: 'auth_2', display_name: 'Bob', avatar_url: null, seat_index: 1, color: '#3b82f6', is_active: true, joined_at: '', ready_for_version: 0 },
  ]
}

describe('remapGameStatePlayerIds', () => {
  it('rewrites every player-id reference onto the new roster, and sets gameId/authUserId', () => {
    const genesis = buildGenesisState(makeGame({}, { mapTemplateId: 'classic' }), makePlayers())
    // Genesis alone already exercises players[].id, turnOrder,
    // pendingPlayerIds and boardSetup.unitsRemainingByPlayerId — layer on a
    // fake chosen-card pick and a logged action so chosenCardIdByPlayerId
    // and actionHistory get covered too, without simulating a full round.
    const state = {
      ...genesis,
      chosenCardIdByPlayerId: { p1: 'card_1', p2: null },
      actionHistory: [{ action: { type: 'CHOOSE_CARD' as const, playerId: 'p1', cardId: 'card_1' }, turn: 1, timestamp: '2026-01-01T00:00:00Z' }],
    }

    const playerIdMap = { p1: 'new-p1', p2: 'new-p2' }
    const remapped = remapGameStatePlayerIds(state, { newGameId: 'game_2', playerIdMap, hostUserId: 'host_1' })

    expect(remapped.gameId).toBe('game_2')
    expect(remapped.players.map((p) => p.id)).toEqual(['new-p1', 'new-p2'])
    expect(remapped.players.every((p) => p.authUserId === 'host_1')).toBe(true)
    expect(remapped.turnOrder).toEqual(state.turnOrder.map((id) => playerIdMap[id as keyof typeof playerIdMap]))
    expect(remapped.pendingPlayerIds).toEqual(state.pendingPlayerIds.map((id) => playerIdMap[id as keyof typeof playerIdMap]))
    expect(Object.keys(remapped.chosenCardIdByPlayerId).sort()).toEqual(['new-p1', 'new-p2'])
    expect(remapped.chosenCardIdByPlayerId['new-p1']).toBe('card_1')
    expect(Object.keys(remapped.boardSetup?.unitsRemainingByPlayerId ?? {}).sort()).toEqual(['new-p1', 'new-p2'])
    expect(remapped.actionHistory[0].action.playerId).toBe('new-p1')

    // Source state is untouched.
    expect(state.players.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('remaps boardSetup.builderId for a solo-build-map game', () => {
    const players = makePlayers()
    const genesis = buildGenesisState(makeGame({ created_by: 'auth_1' }, { mapTemplateId: null, soloBuildMap: true, soloBuilderSelection: 'owner' }), players)
    expect(genesis.boardSetup?.builderId).toBe('p1')

    const remapped = remapGameStatePlayerIds(genesis, { newGameId: 'game_2', playerIdMap: { p1: 'new-p1', p2: 'new-p2' }, hostUserId: 'host_1' })

    expect(remapped.boardSetup?.builderId).toBe('new-p1')
  })
})

describe('remapGameSettingsPlayerIds', () => {
  it('remaps soloBuilderId and every entry of soloBuilderTurnOrder', () => {
    const settings = makeSettings({ soloBuildMap: true, soloBuilderId: 'p1', soloBuilderTurnOrder: ['p2', 'p1'] })

    const remapped = remapGameSettingsPlayerIds(settings, { p1: 'new-p1', p2: 'new-p2' })

    expect(remapped.soloBuilderId).toBe('new-p1')
    expect(remapped.soloBuilderTurnOrder).toEqual(['new-p2', 'new-p1'])
  })

  it('leaves null soloBuilderId/soloBuilderTurnOrder as null', () => {
    const settings = makeSettings()

    const remapped = remapGameSettingsPlayerIds(settings, { p1: 'new-p1' })

    expect(remapped.soloBuilderId).toBeNull()
    expect(remapped.soloBuilderTurnOrder).toBeNull()
  })
})

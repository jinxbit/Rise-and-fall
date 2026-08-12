import { describe, expect, it } from 'vitest'
import { applyAction } from '../../engine/applyAction'
import { replayActions } from '../../engine/replay'
import { buildGenesisState } from '../gameGenesis'
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
  // so a game (and its RAF-STATE-1 export) is self-contained.
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
})

import { describe, expect, it } from 'vitest'
import { createEmptyBoard } from '../board'
import { createNewGame } from '../createGame'
import { getUnitLimit, isDeclineTriggered } from '../decline'
import type { GameState, Unit } from '../types'

function makeUnit(ownerId: string, kind: string, id: string): Unit {
  return {
    id,
    ownerId,
    kind,
    coord: { q: 0, r: 0 },
    movement: { domains: [], canTraverseCliffs: false, range: 0 },
    traits: [],
  }
}

function makeGame(unitLimits: Record<string, number>, units: Unit[] = []): GameState {
  const state = createNewGame({
    gameId: 'g1',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
    ],
    unitLimits,
  })
  return { ...state, status: 'active', units }
}

describe('getUnitLimit', () => {
  it('reads the limit for a kind present in unitLimits', () => {
    const state = makeGame({ city: 8, temple: 3 })
    expect(getUnitLimit(state, 'city')).toBe(8)
    expect(getUnitLimit(state, 'temple')).toBe(3)
  })

  it('has no limit (Infinity) for a kind missing from unitLimits', () => {
    const state = makeGame({ city: 8 })
    expect(getUnitLimit(state, 'ship')).toBe(Infinity)
  })
})

describe('isDeclineTriggered', () => {
  // The real per-player caps.
  const unitLimits = { city: 8, temple: 3, nomad: 8, merchant: 6, mountaineer: 3, ship: 5 }

  it('is false when nobody is at any limit', () => {
    const units = [makeUnit('p1', 'city', 'u1'), makeUnit('p1', 'temple', 'u2')]
    expect(isDeclineTriggered(makeGame(unitLimits, units))).toBe(false)
  })

  it('is true once a player reaches a kind\'s limit', () => {
    const units = Array.from({ length: 3 }, (_, i) => makeUnit('p1', 'temple', `u${i}`))
    expect(isDeclineTriggered(makeGame(unitLimits, units))).toBe(true)
  })

  it('is true if any player (not just the first) reaches a limit', () => {
    const units = Array.from({ length: 3 }, (_, i) => makeUnit('p2', 'mountaineer', `u${i}`))
    expect(isDeclineTriggered(makeGame(unitLimits, units))).toBe(true)
  })

  it('is false one unit below the limit', () => {
    const units = Array.from({ length: 2 }, (_, i) => makeUnit('p1', 'temple', `u${i}`))
    expect(isDeclineTriggered(makeGame(unitLimits, units))).toBe(false)
  })

  it('is false for any count when the kind has no limit set', () => {
    const units = Array.from({ length: 50 }, (_, i) => makeUnit('p1', 'city', `u${i}`))
    expect(isDeclineTriggered(makeGame({}, units))).toBe(false)
  })
})

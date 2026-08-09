import { describe, expect, it } from 'vitest'
import { isCliffBetweenTerrains, isCliffEdge } from '../cliffs'

describe('isCliffEdge', () => {
  it('is not a cliff when levels are equal', () => {
    expect(isCliffEdge(0, 0)).toBe(false)
  })

  it('is not a cliff when levels differ by exactly 1', () => {
    expect(isCliffEdge(0, 1)).toBe(false)
    expect(isCliffEdge(1, 0)).toBe(false)
  })

  it('is a cliff when levels differ by more than 1', () => {
    expect(isCliffEdge(0, 2)).toBe(true)
    expect(isCliffEdge(0, 3)).toBe(true)
    expect(isCliffEdge(1, 4)).toBe(true)
  })
})

describe('isCliffBetweenTerrains', () => {
  // Water=0, Plain=1, Forest=2, Mountain=3, Glacier=4 — matches content/terrain.json.
  const levels = { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 }

  it('matches the worked examples from the rules', () => {
    expect(isCliffBetweenTerrains('water', 'water', levels)).toBe(false)
    expect(isCliffBetweenTerrains('water', 'plain', levels)).toBe(false)
    expect(isCliffBetweenTerrains('water', 'mountain', levels)).toBe(true)
  })

  it('is not a cliff between adjacent elevation tiers anywhere on the scale', () => {
    expect(isCliffBetweenTerrains('plain', 'forest', levels)).toBe(false)
    expect(isCliffBetweenTerrains('forest', 'mountain', levels)).toBe(false)
    expect(isCliffBetweenTerrains('mountain', 'glacier', levels)).toBe(false)
  })

  it('is a cliff between tiers more than 1 level apart', () => {
    expect(isCliffBetweenTerrains('water', 'forest', levels)).toBe(true)
    expect(isCliffBetweenTerrains('water', 'glacier', levels)).toBe(true)
    expect(isCliffBetweenTerrains('plain', 'mountain', levels)).toBe(true)
    expect(isCliffBetweenTerrains('plain', 'glacier', levels)).toBe(true)
    expect(isCliffBetweenTerrains('forest', 'glacier', levels)).toBe(true)
  })

  it('defaults a terrain id missing from the levels map to level 0', () => {
    expect(isCliffBetweenTerrains('water', 'unknown', levels)).toBe(false)
    expect(isCliffBetweenTerrains('mountain', 'unknown', levels)).toBe(true)
  })
})

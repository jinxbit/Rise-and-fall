import { describe, expect, it } from 'vitest'
import { createEmptyBoard, coordsWithinDistance, getTile, neighborCoords, setTile } from '../board'
import { coordKey } from '../types'

describe('board', () => {
  it('sets and retrieves a tile by coordinate', () => {
    const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain')
    expect(getTile(board, { q: 0, r: 0 })?.terrain).toBe('plain')
  })

  it('returns undefined for an unset tile', () => {
    const board = createEmptyBoard('hex')
    expect(getTile(board, { q: 5, r: 5 })).toBeUndefined()
  })

  it('computes 6 neighbor coordinates for a hex board', () => {
    const board = createEmptyBoard('hex')
    expect(neighborCoords(board, { q: 0, r: 0 })).toHaveLength(6)
  })

  it('computes 4 neighbor coordinates for a square board', () => {
    const board = createEmptyBoard('square')
    expect(neighborCoords(board, { q: 0, r: 0 })).toHaveLength(4)
  })

  describe('coordsWithinDistance', () => {
    it('at distance 1, matches neighborCoords exactly', () => {
      const board = createEmptyBoard('hex')
      const origin = { q: 0, r: 0 }
      const within1 = new Set(coordsWithinDistance(board, origin, 1).map(coordKey))
      const neighbors = new Set(neighborCoords(board, origin).map(coordKey))
      expect(within1).toEqual(neighbors)
    })

    it('at distance 2 on a hex board, returns the 18 hexes within 2 rings, with no duplicates and never the origin', () => {
      const board = createEmptyBoard('hex')
      const origin = { q: 0, r: 0 }
      const within2 = coordsWithinDistance(board, origin, 2)
      const keys = within2.map(coordKey)
      expect(new Set(keys).size).toBe(keys.length) // no duplicates
      expect(keys).not.toContain(coordKey(origin))
      expect(within2).toHaveLength(18) // 6 at distance 1 + 12 at distance 2
    })

    it('distance 0 returns nothing', () => {
      const board = createEmptyBoard('hex')
      expect(coordsWithinDistance(board, { q: 0, r: 0 }, 0)).toEqual([])
    })
  })
})

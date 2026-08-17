import { describe, expect, it } from 'vitest'
import { canonicalizeBoard, createEmptyBoard, coordsWithinDistance, getTile, neighborCoords, setTile } from '../board'
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

  describe('canonicalizeBoard', () => {
    it('is the same for two boards built with the same tiles in a different order', () => {
      const a = setTile(setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain'), { q: 1, r: 0 }, 'water')
      const b = setTile(setTile(createEmptyBoard('hex'), { q: 1, r: 0 }, 'water'), { q: 0, r: 0 }, 'plain')
      expect(canonicalizeBoard(a)).toBe(canonicalizeBoard(b))
    })

    it('differs when a tile terrain differs', () => {
      const a = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain')
      const b = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'forest')
      expect(canonicalizeBoard(a)).not.toBe(canonicalizeBoard(b))
    })

    it('is unaffected by non-terrain tile state (e.g. occupantIds)', () => {
      const board = setTile(createEmptyBoard('hex'), { q: 0, r: 0 }, 'plain')
      const occupied = { ...board, tiles: { ...board.tiles, '0,0': { ...board.tiles['0,0'], occupantIds: ['unit_1'] } } }
      expect(canonicalizeBoard(board)).toBe(canonicalizeBoard(occupied))
    })
  })
})

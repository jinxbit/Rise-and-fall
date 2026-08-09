import { describe, expect, it } from 'vitest'
import { createEmptyBoard, getTile, neighborCoords, setTile } from '../board'

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
})

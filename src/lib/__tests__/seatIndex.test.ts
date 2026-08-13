import { describe, expect, it } from 'vitest'
import { nextSeatIndex } from '../seatIndex'
import type { PlayerRow } from '../dbTypes'

function makePlayerRow(seatIndex: number): PlayerRow {
  return {
    id: `p${seatIndex}`,
    game_id: 'g1',
    user_id: 'u1',
    display_name: `Player ${seatIndex}`,
    avatar_url: null,
    seat_index: seatIndex,
    color: '#ef4444',
    is_active: true,
    joined_at: '',
    ready_for_version: 0,
  }
}

describe('nextSeatIndex', () => {
  it('returns 0 for an empty roster', () => {
    expect(nextSeatIndex([])).toBe(0)
  })

  it('returns one past the highest taken seat for a contiguous roster', () => {
    expect(nextSeatIndex([makePlayerRow(0), makePlayerRow(1), makePlayerRow(2)])).toBe(3)
  })

  it('fills past a gap left by a removed seat rather than reusing it — max(seat_index) + 1, not roster length', () => {
    // Seat 1 was removed after [0, 1, 2] existed; roster.length (2) would
    // collide with the still-taken seat 2 if used directly.
    expect(nextSeatIndex([makePlayerRow(0), makePlayerRow(2)])).toBe(3)
  })

  it('is order-independent', () => {
    expect(nextSeatIndex([makePlayerRow(2), makePlayerRow(0), makePlayerRow(1)])).toBe(3)
  })
})

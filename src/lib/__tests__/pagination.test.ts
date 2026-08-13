import { describe, expect, it } from 'vitest'
import { pageCount, paginate } from '../pagination'

describe('paginate', () => {
  it('returns the first page by default', () => {
    expect(paginate([1, 2, 3, 4, 5], 0, 2)).toEqual([1, 2])
  })

  it('returns subsequent pages', () => {
    expect(paginate([1, 2, 3, 4, 5], 1, 2)).toEqual([3, 4])
    expect(paginate([1, 2, 3, 4, 5], 2, 2)).toEqual([5])
  })

  it('returns an empty array past the end', () => {
    expect(paginate([1, 2, 3], 5, 2)).toEqual([])
  })
})

describe('pageCount', () => {
  it('is 1 for an empty list, never 0', () => {
    expect(pageCount(0, 10)).toBe(1)
  })

  it('rounds up partial pages', () => {
    expect(pageCount(21, 10)).toBe(3)
    expect(pageCount(20, 10)).toBe(2)
  })
})

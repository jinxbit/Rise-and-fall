import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRefetchOnVisible } from '../useRefetchOnVisible'

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

describe('useRefetchOnVisible', () => {
  afterEach(() => {
    setVisibility('visible')
  })

  it('calls refetch when the tab becomes visible', () => {
    const refetch = vi.fn()
    renderHook(() => useRefetchOnVisible(refetch))

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(refetch).toHaveBeenCalledOnce()
  })

  it('does not call refetch when the tab becomes hidden', () => {
    const refetch = vi.fn()
    renderHook(() => useRefetchOnVisible(refetch))

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(refetch).not.toHaveBeenCalled()
  })

  it('always calls the latest refetch closure without re-subscribing', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ fn }) => useRefetchOnVisible(fn), { initialProps: { fn: first } })

    rerender({ fn: second })
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('stops listening after unmount', () => {
    const refetch = vi.fn()
    const { unmount } = renderHook(() => useRefetchOnVisible(refetch))

    unmount()
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(refetch).not.toHaveBeenCalled()
  })
})

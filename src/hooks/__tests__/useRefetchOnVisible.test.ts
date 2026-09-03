import { renderHook } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useRefetchOnVisible } from '../useRefetchOnVisible'

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

describe('useRefetchOnVisible', () => {
  // jsdom doesn't implement navigator.serviceWorker — stand in with a plain
  // EventTarget so the hook's `message` listener has something real to
  // (un)subscribe from, matching how sw.ts posts { type: 'REFRESH_DATA' }.
  beforeAll(() => {
    Object.defineProperty(navigator, 'serviceWorker', { value: new EventTarget(), configurable: true })
  })

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

  it('calls refetch on a REFRESH_DATA message from the service worker', () => {
    const refetch = vi.fn()
    renderHook(() => useRefetchOnVisible(refetch))

    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'REFRESH_DATA' } }))

    expect(refetch).toHaveBeenCalledOnce()
  })

  it('ignores service worker messages of another type', () => {
    const refetch = vi.fn()
    renderHook(() => useRefetchOnVisible(refetch))

    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'SOMETHING_ELSE' } }))

    expect(refetch).not.toHaveBeenCalled()
  })

  it('stops listening for service worker messages after unmount', () => {
    const refetch = vi.fn()
    const { unmount } = renderHook(() => useRefetchOnVisible(refetch))

    unmount()
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'REFRESH_DATA' } }))

    expect(refetch).not.toHaveBeenCalled()
  })
})

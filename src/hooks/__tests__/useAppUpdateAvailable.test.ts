import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppUpdateAvailable } from '../useAppUpdateAvailable'

describe('useAppUpdateAvailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stays false when the deployed buildId matches the running build', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ buildId: __BUILD_ID__ }) }),
    )

    const { result } = renderHook(() => useAppUpdateAvailable())

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })

  it('becomes true once version.json reports a different buildId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ buildId: 'a-newer-build' }) }),
    )

    const { result } = renderHook(() => useAppUpdateAvailable())

    await waitFor(() => expect(result.current).toBe(true))
  })

  it('stays false when the version check fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

    const { result } = renderHook(() => useAppUpdateAvailable())

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })
})

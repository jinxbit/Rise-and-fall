import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPushSupported } from '../pushNotify'

describe('isPushSupported', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is false in jsdom, which has no PushManager/Notification', () => {
    expect(isPushSupported()).toBe(false)
  })

  it('is true once serviceWorker, PushManager and Notification are all present', () => {
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', class {})
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    expect(isPushSupported()).toBe(true)
  })
})

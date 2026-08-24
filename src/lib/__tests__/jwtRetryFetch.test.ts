import { describe, expect, it, vi } from 'vitest'
import { createJwtRetryFetch } from '../jwtRetryFetch'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('createJwtRetryFetch', () => {
  it('returns the response unchanged on success', async () => {
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    const fetchWithRetry = createJwtRetryFetch(baseFetch, 0)

    const response = await fetchWithRetry('/games')

    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
  })

  it('retries once and returns the retry response on PGRST303', async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { code: 'PGRST303', message: 'JWT issued at future' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    const fetchWithRetry = createJwtRetryFetch(baseFetch, 0)

    const response = await fetchWithRetry('/games')

    expect(baseFetch).toHaveBeenCalledTimes(2)
    expect(response.status).toBe(200)
  })

  it('does not retry other 401 errors', async () => {
    const baseFetch = vi.fn().mockResolvedValue(jsonResponse(401, { code: 'PGRST301', message: 'JWT expired' }))
    const fetchWithRetry = createJwtRetryFetch(baseFetch, 0)

    const response = await fetchWithRetry('/games')

    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(401)
  })

  it('does not retry non-JSON 401 responses', async () => {
    const baseFetch = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const fetchWithRetry = createJwtRetryFetch(baseFetch, 0)

    const response = await fetchWithRetry('/games')

    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(401)
  })
})

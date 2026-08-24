/**
 * PostgREST sometimes rejects a freshly-issued JWT with PGRST303 ("JWT
 * issued at future") when there's a brief clock-skew race between the Auth
 * and database servers — the same token is valid again a moment later.
 * Retrying once after a short delay clears it instead of surfacing a
 * confusing raw error to players (issue #291).
 */
export function createJwtRetryFetch(
  baseFetch: typeof fetch,
  delayMs = 1000,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async function fetchWithJwtRetry(input, init) {
    const response = await baseFetch(input, init)
    if (response.status !== 401) return response

    const body: { code?: string } | null = await response
      .clone()
      .json()
      .catch(() => null)
    if (body?.code !== 'PGRST303') return response

    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return baseFetch(input, init)
  }
}

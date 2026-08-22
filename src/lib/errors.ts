export interface AppError {
  message: string
  details: string
}

function isMessageLike(err: unknown): err is { message: string; code?: unknown; details?: unknown; hint?: unknown } {
  return typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
}

/** A user-facing string with no extra debugging detail beyond itself, e.g. client-side validation messages that never touched a caught exception. */
export function simpleError(message: string): AppError {
  return { message, details: message }
}

/**
 * Turns a caught value into a display message plus full debugging detail for
 * ErrorBanner's "Copy details" button. Supabase's PostgrestError/AuthError
 * responses aren't always `instanceof Error`, so a plain `err instanceof
 * Error ? err.message : fallback` check silently discards the real error
 * (and its code/details/hint) in favor of a hardcoded fallback whenever a
 * query fails — this looks at any object with a `message` field, not just
 * Error instances, so the actual failure reason survives.
 */
export function toAppError(err: unknown, fallback: string): AppError {
  if (err instanceof Error) {
    return { message: err.message || fallback, details: err.stack ?? `${err.name}: ${err.message}` }
  }
  if (isMessageLike(err)) {
    const { message, code, details, hint } = err
    const detailLines = [`message: ${message}`]
    if (code) detailLines.push(`code: ${String(code)}`)
    if (details) detailLines.push(`details: ${String(details)}`)
    if (hint) detailLines.push(`hint: ${String(hint)}`)
    return { message: message || fallback, details: detailLines.join('\n') }
  }
  return simpleError(fallback)
}

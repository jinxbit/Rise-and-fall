// The HTTP half of the production-simulating Supabase stack: a small
// PostgREST + GoTrue + Edge-Functions router that a *real*
// `@supabase/supabase-js` client talks to over a patched `fetch`.
//
// Going through the wire rather than stubbing the client's query builder is
// deliberate. It means the tests exercise the same `select`/`eq`/`maybeSingle`
// URL building, the same `Prefer` header handling, the same
// "non-2xx becomes `error` with the body hidden in `error.context`" behavior
// that gameApi.ts's `invokeGameFunction` has to reach into — all of which are
// production behavior that a hand-written client stub would paper over.
//
// Anything outside the modeled surface throws UnsupportedQueryError rather
// than being quietly approximated: a passing test against a fiction is worse
// than a failing one.

import { Database, DatabaseError, UnsupportedQueryError, type Actor, type TableName } from './database.ts'

export const STACK_URL = 'http://supabase.test'
export const ANON_KEY = 'test-anon-key'
export const SERVICE_ROLE_KEY = 'test-service-role-key'

const TABLES: TableName[] = ['profiles', 'games', 'players', 'game_state', 'game_state_meta']

/** Access tokens minted by ./index.ts, resolved here the way GoTrue resolves a real JWT. */
export type TokenRegistry = Map<string, { userId: string; email: string }>

/**
 * Accounts the fake GoTrue knows how to sign in, keyed by email — the
 * production smoke runner (../productionSmoke/) creates its throwaway users
 * through the admin API and signs them in with a password, so the in-process
 * stack has to answer both to cover that runner in CI.
 */
export type AccountRegistry = Map<string, { userId: string; password: string }>

export type EdgeFunctionHandler = (req: Request) => Promise<Response> | Response

export interface ServerOptions {
  db: Database
  tokens: TokenRegistry
  accounts: AccountRegistry
  edgeFunctions: Map<string, EdgeFunctionHandler>
  /** Every request the stack served, in order — lets a test assert on call counts (e.g. "one CAS write per action"). */
  requestLog: string[]
  /** Registers a user the way GoTrue's admin API does, returning their id and access token. */
  createUser(email: string, password: string): { userId: string; accessToken: string }
  /** Removes a user and invalidates their token, the way `auth.admin.deleteUser` does. */
  deleteUser(userId: string): boolean
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function bearer(req: Request): string | null {
  const header = req.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length)
}

function resolveActor(req: Request, tokens: TokenRegistry): Actor | null {
  const token = bearer(req) ?? req.headers.get('apikey')
  if (!token) return { role: 'anon', userId: null }
  if (token === SERVICE_ROLE_KEY) return { role: 'service_role', userId: null }
  if (token === ANON_KEY) return { role: 'anon', userId: null }
  const session = tokens.get(token)
  if (!session) return null
  return { role: 'authenticated', userId: session.userId }
}

// ---------------------------------------------------------------------------
// PostgREST filters
// ---------------------------------------------------------------------------

/** Reserved query params that select rows' *shape*, not which rows match. */
const NON_FILTER_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

type RowMatcher = (row: Record<string, unknown>) => boolean

function matcherFor(column: string, expression: string): RowMatcher {
  const separator = expression.indexOf('.')
  if (separator === -1) throw new UnsupportedQueryError(`Unparseable PostgREST filter: ${column}=${expression}`)
  const operator = expression.slice(0, separator)
  const operand = expression.slice(separator + 1)

  // Postgres compares typed values; the URL only ever carries strings, so
  // every comparison below is done on the string rendering of the column.
  const asString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

  switch (operator) {
    case 'eq':
      return (row) => asString(row[column]) === operand
    case 'neq':
      return (row) => asString(row[column]) !== operand
    case 'is':
      if (operand === 'null') return (row) => row[column] === null || row[column] === undefined
      if (operand === 'true' || operand === 'false') return (row) => row[column] === (operand === 'true')
      throw new UnsupportedQueryError(`Unsupported \`is\` operand: ${operand}`)
    case 'in': {
      const values = new Set(
        operand
          .replace(/^\(/, '')
          .replace(/\)$/, '')
          .split(',')
          .map((value) => value.replace(/^"|"$/g, '')),
      )
      return (row) => {
        const value = asString(row[column])
        return value !== null && values.has(value)
      }
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const bound = Number(operand)
      if (Number.isNaN(bound)) throw new UnsupportedQueryError(`Only numeric ${operator} filters are modeled: ${column}=${expression}`)
      return (row) => {
        const value = Number(row[column])
        if (Number.isNaN(value)) return false
        return operator === 'gt' ? value > bound : operator === 'gte' ? value >= bound : operator === 'lt' ? value < bound : value <= bound
      }
    }
    default:
      throw new UnsupportedQueryError(
        `PostgREST operator "${operator}" is not modeled by the test stack (${column}=${expression}). Add it to httpServer.ts if a real query needs it.`,
      )
  }
}

function buildMatcher(params: URLSearchParams): RowMatcher {
  const matchers: RowMatcher[] = []
  for (const [key, value] of params) {
    if (NON_FILTER_PARAMS.has(key)) continue
    if (key === 'or' || key === 'and' || key === 'not') {
      throw new UnsupportedQueryError(`Boolean filter trees (${key}=...) are not modeled by the test stack.`)
    }
    matchers.push(matcherFor(key, value))
  }
  return (row) => matchers.every((match) => match(row))
}

function project(rows: Record<string, unknown>[], select: string | null): Record<string, unknown>[] {
  if (!select || select === '*') return rows
  if (select.includes('(')) {
    throw new UnsupportedQueryError(`Embedded resource selects ("${select}") are not modeled by the test stack.`)
  }
  const columns = select.split(',').map((column) => column.trim()).filter(Boolean)
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])))
}

function applyOrder(rows: Record<string, unknown>[], order: string | null): Record<string, unknown>[] {
  if (!order) return rows
  const [column, direction = 'asc'] = order.split('.')
  const sign = direction.startsWith('desc') ? -1 : 1
  return [...rows].sort((left, right) => {
    const a = left[column]
    const b = right[column]
    if (a === b) return 0
    return (a! < b! ? -1 : 1) * sign
  })
}

async function handleRest(req: Request, url: URL, options: ServerOptions): Promise<Response> {
  const table = url.pathname.slice('/rest/v1/'.length) as TableName
  if (!TABLES.includes(table)) {
    return json(404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache`, details: null, hint: null })
  }

  const actor = resolveActor(req, options.tokens)
  if (!actor) return json(401, { code: 'PGRST301', message: 'JWT expired or invalid', details: null, hint: null })

  const params = url.searchParams
  const match = buildMatcher(params)
  const select = params.get('select')
  const prefer = req.headers.get('Prefer') ?? ''
  const wantsRepresentation = prefer.includes('return=representation')
  // postgrest-js's `.single()` asks for a bare object with this Accept header
  // (`.maybeSingle()` does not — it post-processes an array instead). Real
  // PostgREST answers it with the object, or 406 when the result isn't
  // exactly one row; a fake that always returned an array would hand
  // `.single()` callers an array where they expect a row.
  const wantsObject = (req.headers.get('Accept') ?? '').includes('application/vnd.pgrst.object+json')
  const asBody = (rows: Record<string, unknown>[]): [number, unknown] => {
    if (!wantsObject) return [200, rows]
    if (rows.length === 1) return [200, rows[0]]
    return [
      406,
      {
        code: 'PGRST116',
        message: 'JSON object requested, multiple (or no) rows returned',
        details: `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
        hint: null,
      },
    ]
  }

  try {
    switch (req.method) {
      case 'GET': {
        const rows = applyOrder(options.db.select(actor, table, match), params.get('order'))
        const [status, body] = asBody(project(rows, select))
        return json(status, body)
      }
      case 'POST': {
        const body = (await req.json()) as Record<string, unknown> | Record<string, unknown>[]
        const inserted = options.db.insert(actor, table, Array.isArray(body) ? body : [body])
        if (!wantsRepresentation) return new Response(null, { status: 201 })
        const [status, responseBody] = asBody(project(inserted, select))
        return json(status === 200 ? 201 : status, responseBody)
      }
      case 'PATCH': {
        const body = (await req.json()) as Record<string, unknown>
        const updated = options.db.update(actor, table, match, body)
        if (!wantsRepresentation) return new Response(null, { status: 204 })
        const [status, responseBody] = asBody(project(updated, select))
        return json(status, responseBody)
      }
      case 'DELETE': {
        const deleted = options.db.delete(actor, table, match)
        if (!wantsRepresentation) return new Response(null, { status: 204 })
        const [status, responseBody] = asBody(project(deleted, select))
        return json(status, responseBody)
      }
      default:
        throw new UnsupportedQueryError(`Unsupported PostgREST method: ${req.method}`)
    }
  } catch (error) {
    if (error instanceof DatabaseError) {
      return json(error.status, { code: error.code, message: error.message, details: error.details, hint: error.hint })
    }
    throw error
  }
}

function userPayload(userId: string, email: string): Record<string, unknown> {
  return {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  }
}

/**
 * The GoTrue endpoints this stack answers:
 *
 * - `GET /auth/v1/user` — the one auth call the Edge Functions make
 *   (`getCallerUserId`, supabase/functions/_shared/gameEnforcement.ts). A
 *   token this stack never minted is a 401 exactly as an expired or forged
 *   JWT would be, which is what drives that function's `return null` -> 401.
 * - `POST /auth/v1/admin/users` / `DELETE /auth/v1/admin/users/:id` —
 *   service-role only, the way the real admin API is. The production smoke
 *   runner creates and destroys throwaway users through these.
 * - `POST /auth/v1/token?grant_type=password` — how that runner then signs
 *   each of them in.
 *
 * The last two exist so the smoke runner is exercised in CI against this
 * stack rather than only ever against production, where a mistake in it
 * costs a failed nightly run and some cleanup.
 */
async function handleAuth(req: Request, url: URL, options: ServerOptions): Promise<Response> {
  if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
    const token = bearer(req)
    const session = token ? options.tokens.get(token) : undefined
    if (!session) return json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid claim: missing sub claim' })
    return json(200, userPayload(session.userId, session.email))
  }

  if (url.pathname.startsWith('/auth/v1/admin/users')) {
    // The real admin API is service-role only; anything else is a 403 there
    // too, which is worth preserving — a smoke runner accidentally holding
    // only the anon key should fail loudly, not create nothing quietly.
    if ((bearer(req) ?? req.headers.get('apikey')) !== SERVICE_ROLE_KEY) {
      return json(403, { code: 403, error_code: 'not_admin', msg: 'User not allowed' })
    }
    if (req.method === 'POST') {
      const body = (await req.json()) as { email?: string; password?: string }
      if (!body.email || !body.password) return json(422, { code: 422, msg: 'email and password are required' })
      if (options.accounts.has(body.email)) return json(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' })
      const { userId } = options.createUser(body.email, body.password)
      return json(200, userPayload(userId, body.email))
    }
    if (req.method === 'DELETE') {
      const userId = url.pathname.slice('/auth/v1/admin/users/'.length)
      if (!options.deleteUser(userId)) return json(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' })
      return json(200, {})
    }
  }

  if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
    if (url.searchParams.get('grant_type') !== 'password') {
      throw new UnsupportedQueryError(`Only grant_type=password is modeled by the test stack (got ${url.searchParams.get('grant_type')}).`)
    }
    const body = (await req.json()) as { email?: string; password?: string }
    const account = body.email ? options.accounts.get(body.email) : undefined
    if (!account || account.password !== body.password) {
      return json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
    }
    const accessToken = [...options.tokens.entries()].find(([, session]) => session.userId === account.userId)?.[0]
    if (!accessToken) return json(500, { code: 500, msg: 'No access token registered for that account' })
    return json(200, {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: `refresh-${account.userId}`,
      user: userPayload(account.userId, body.email!),
    })
  }

  throw new UnsupportedQueryError(`${req.method} ${url.pathname} is not modeled by the test stack's auth endpoint.`)
}

async function handleFunctions(req: Request, url: URL, options: ServerOptions): Promise<Response> {
  const name = url.pathname.slice('/functions/v1/'.length)
  const handler = options.edgeFunctions.get(name)
  if (!handler) {
    throw new UnsupportedQueryError(`No Edge Function named "${name}" is loaded into the test stack.`)
  }
  return await handler(req)
}

/** The single entry point the patched global `fetch` delegates to. */
export async function serveStackRequest(req: Request, options: ServerOptions): Promise<Response> {
  const url = new URL(req.url)
  options.requestLog.push(`${req.method} ${url.pathname}${url.search}`)

  if (req.method === 'OPTIONS') return new Response('ok', { status: 200 })
  if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, url, options)
  if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, url, options)
  if (url.pathname.startsWith('/functions/v1/')) return await handleFunctions(req, url, options)
  throw new UnsupportedQueryError(`The test stack does not model ${url.pathname}.`)
}

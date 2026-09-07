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

/** Access tokens minted by ./index.ts's `stack.actAs(userId)`, resolved here the way GoTrue resolves a real JWT. */
export type TokenRegistry = Map<string, { userId: string; email: string }>

export type EdgeFunctionHandler = (req: Request) => Promise<Response> | Response

export interface ServerOptions {
  db: Database
  tokens: TokenRegistry
  edgeFunctions: Map<string, EdgeFunctionHandler>
  /** Every request the stack served, in order — lets a test assert on call counts (e.g. "one CAS write per action"). */
  requestLog: string[]
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

  try {
    switch (req.method) {
      case 'GET': {
        const rows = applyOrder(options.db.select(actor, table, match), params.get('order'))
        return json(200, project(rows, select))
      }
      case 'POST': {
        const body = (await req.json()) as Record<string, unknown> | Record<string, unknown>[]
        const inserted = options.db.insert(actor, table, Array.isArray(body) ? body : [body])
        if (!wantsRepresentation) return new Response(null, { status: 201 })
        return json(201, project(inserted, select))
      }
      case 'PATCH': {
        const body = (await req.json()) as Record<string, unknown>
        const updated = options.db.update(actor, table, match, body)
        if (!wantsRepresentation) return new Response(null, { status: 204 })
        return json(200, project(updated, select))
      }
      case 'DELETE': {
        const deleted = options.db.delete(actor, table, match)
        if (!wantsRepresentation) return new Response(null, { status: 204 })
        return json(200, project(deleted, select))
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

/**
 * GoTrue's `GET /auth/v1/user`, the one auth call the Edge Functions make
 * (`getCallerUserId`, supabase/functions/_shared/gameEnforcement.ts). A token
 * this stack never minted is a 401 exactly as an expired/forged JWT would be,
 * which is what drives that function's `return null` -> 401 branch.
 */
function handleAuth(req: Request, url: URL, options: ServerOptions): Response {
  if (url.pathname !== '/auth/v1/user' || req.method !== 'GET') {
    throw new UnsupportedQueryError(`Only GET /auth/v1/user is modeled by the test stack (got ${req.method} ${url.pathname}).`)
  }
  const token = bearer(req)
  const session = token ? options.tokens.get(token) : undefined
  if (!session) {
    return json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid claim: missing sub claim' })
  }
  return json(200, {
    id: session.userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: session.email,
    app_metadata: { provider: 'discord' },
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  })
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
  if (url.pathname.startsWith('/auth/v1/')) return handleAuth(req, url, options)
  if (url.pathname.startsWith('/functions/v1/')) return await handleFunctions(req, url, options)
  throw new UnsupportedQueryError(`The test stack does not model ${url.pathname}.`)
}

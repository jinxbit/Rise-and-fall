import {
  BONUS_COUNT_PER_TYPE,
  BONUS_LABELS,
  BONUS_VP,
  CITY_COLORS,
  GOOD_VP,
  HOUSE_VP,
  LOT_COUNT,
  LOT_SIZE,
  RAID_MARKER_VP,
  RESERVE_COUNTS,
  RING_ORDER,
  SUPPLY_COUNTS,
  WINNING_DP,
  markerColor,
} from './board'
import { bidKey, compareBids, countMarkers, describeBid, hasLegalBid } from './bids'
import { randomInt, shuffle } from './rng'
import {
  BONUS_TYPES,
  GOOD_COLORS,
  type GoodColor,
  type Goods,
  type KoggeAction,
  type KoggeCity,
  type KoggePlayer,
  type KoggeSetup,
  type KoggeState,
  type MarkerCounts,
  type Payment,
  type TradeBundle,
  type TurnActionKind,
} from './types'

/**
 * The Kogge rules engine — KOGGE_PLAN.md is the rules reference and records
 * every interpretation made here. Pure and deterministic: all randomness
 * comes from `state.rng`, seeded from `setup.seed`, so
 * `replayKogge(setup, actions)` always rebuilds the same state. Every
 * accepted action is appended to `actionHistory` exactly once.
 */

export class KoggeRuleError extends Error {}

function fail(message: string): never {
  throw new KoggeRuleError(message)
}

export function emptyGoods(): Goods {
  return { grey: 0, orange: 0, purple: 0, white: 0 }
}

export function emptyMarkers(): MarkerCounts {
  return new Array<number>(9).fill(0)
}

export function goodsTotal(goods: Goods): number {
  return GOOD_COLORS.reduce((sum, c) => sum + goods[c], 0)
}

function addGoods(into: Goods, from: Goods) {
  for (const c of GOOD_COLORS) into[c] += from[c]
}

function drawFromReserve(state: KoggeState): number | null {
  const total = state.reserve.reduce((a, b) => a + b, 0)
  if (total === 0) return null
  let r = randomInt(state, total)
  for (let v = 0; v < 9; v++) {
    if (r < state.reserve[v]) {
      state.reserve[v] -= 1
      return v
    }
    r -= state.reserve[v]
  }
  return null
}

function takeFromReserve(state: KoggeState, value: number) {
  if (state.reserve[value] <= 0) fail(`No ${value} markers left in the reserve.`)
  state.reserve[value] -= 1
}

/** Moves up to `count` goods of `color` from the supply; returns how many moved. */
function takeFromSupply(state: KoggeState, color: GoodColor, count: number, into: Goods): number {
  const n = Math.min(count, state.supply[color])
  state.supply[color] -= n
  into[color] += n
  return n
}

function player(state: KoggeState, id: string): KoggePlayer {
  const p = state.players.find((pl) => pl.id === id)
  if (!p) fail(`Unknown player ${id}.`)
  return p
}

export function playerName(state: KoggeState, id: string): string {
  return state.players.find((p) => p.id === id)?.name ?? id
}

export function developmentPoints(state: KoggeState, id: string): number {
  return state.houses.filter((h) => h.ownerId === id).length + player(state, id).bonuses.length
}

export interface VictoryBreakdown {
  houses: number
  raidMarkers: number
  bonuses: number
  goods: number
  total: number
}

export function victoryPoints(state: KoggeState, id: string): VictoryBreakdown {
  const p = player(state, id)
  const owned = houseList(state, id)
  const goods = { ...p.goods }
  for (const h of owned) addGoods(goods, h.goods)
  const breakdown = {
    houses: owned.length * HOUSE_VP,
    raidMarkers: p.raidMarkersInHand * RAID_MARKER_VP,
    bonuses: p.bonuses.length * BONUS_VP,
    goods: GOOD_COLORS.reduce((sum, c) => sum + goods[c] * GOOD_VP[c], 0),
  }
  return { ...breakdown, total: breakdown.houses + breakdown.raidMarkers + breakdown.bonuses + breakdown.goods }
}

function houseList(state: KoggeState, id: string) {
  return state.houses.filter((h) => h.ownerId === id)
}

function hasBonus(p: KoggePlayer, bonus: (typeof BONUS_TYPES)[number]) {
  return p.bonuses.includes(bonus)
}

function raidedBy(city: KoggeCity, id: string) {
  return city.raids.includes(id)
}

// ─── Setup ────────────────────────────────────────────────────────────────

export function createKoggeGame(setup: KoggeSetup): KoggeState {
  if (setup.players.length < 2 || setup.players.length > 4) fail('Kogge needs 2 to 4 players.')
  if (new Set(setup.players.map((p) => p.id)).size !== setup.players.length) fail('Player ids must be unique.')

  const state: KoggeState = {
    setup: JSON.parse(JSON.stringify(setup)) as KoggeSetup,
    rng: setup.seed | 0,
    phase: 'startPick',
    round: 0,
    players: [],
    cities: [],
    ring: RING_ORDER.slice(),
    houses: [],
    reserve: RESERVE_COUNTS.slice(),
    supply: { ...SUPPLY_COUNTS },
    bonusSupply: { tripleTrade: BONUS_COUNT_PER_TYPE, extraMarker: BONUS_COUNT_PER_TYPE, freeSecondMove: BONUS_COUNT_PER_TYPE, secretPassage: BONUS_COUNT_PER_TYPE },
    guildmaster: { city: 0, start: 0, returns: 0 },
    finalRound: false,
    turnOrder: [],
    lots: [],
    startPicks: {},
    bids: [],
    turn: null,
    pending: null,
    winnerIds: [],
    endReason: null,
    log: [],
    actionHistory: [],
  }

  // 1. Three goods of its own colour on each city.
  for (let n = 0; n < 9; n++) {
    const city: KoggeCity = { number: n, color: CITY_COLORS[n], slots: [{ value: 0, faceUp: true }, { value: 0, faceUp: true }], goods: emptyGoods(), raids: [] }
    takeFromSupply(state, city.color, 3, city.goods)
    state.cities.push(city)
  }

  // 2. Starting hands.
  setup.players.forEach((sp, seat) => {
    const p: KoggePlayer = {
      id: sp.id,
      name: sp.name,
      seat,
      boatCity: null,
      hand: emptyMarkers(),
      goods: emptyGoods(),
      raidMarkersInHand: 1,
      secondRaidMarkerTaken: false,
      bonuses: [],
    }
    takeFromSupply(state, 'grey', 2, p.goods)
    takeFromSupply(state, 'orange', 1, p.goods)
    for (let v = 0; v < 9; v++) {
      takeFromReserve(state, v)
      p.hand[v] = 1
    }
    state.players.push(p)
    state.startPicks[p.id] = null
  })

  // 3. Guildmaster start.
  const gmMarker = drawFromReserve(state)
  if (gmMarker === null) fail('Reserve is empty.')
  state.guildmaster = { city: gmMarker, start: gmMarker, returns: 0 }

  // 4. Two sets of 0..8 into the city slots: no city shows its own number,
  // and a city's two markers differ.
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8]
  let first: number[]
  do first = shuffle(state, values)
  while (first.some((v, n) => v === n))
  let second: number[]
  do second = shuffle(state, values)
  while (second.some((v, n) => v === n || v === first[n]))
  for (let n = 0; n < 9; n++) {
    takeFromReserve(state, first[n])
    takeFromReserve(state, second[n])
    state.cities[n].slots = [{ value: first[n], faceUp: true }, { value: second[n], faceUp: true }]
  }

  // 5. The Guildmaster's marker goes back.
  state.reserve[gmMarker] += 1

  state.log.push(`Game set up. The Guildmaster starts in city ${gmMarker}. Each player secretly picks a starting city.`)
  return state
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

export function applyKoggeAction(prev: KoggeState, action: KoggeAction): KoggeState {
  if (prev.phase === 'finished') fail('The game is over.')
  const state = JSON.parse(JSON.stringify(prev)) as KoggeState
  switch (action.type) {
    case 'PICK_START':
      pickStart(state, action.playerId, action.value)
      break
    case 'BID':
      bid(state, action.playerId, action.markers)
      break
    case 'MOVE_GUILDMASTER':
      moveGuildmaster(state, action.playerId, action.steps)
      break
    case 'MOVE':
      move(state, action.playerId, action.route, action.payments)
      break
    case 'BUILD_HOUSE':
      buildHouse(state, action.playerId)
      break
    case 'GUILD_RAID_MARKER':
      guildRaidMarker(state, action.playerId, action.value)
      break
    case 'GUILD_BONUS':
      guildBonus(state, action.playerId, action.color, action.bonus)
      break
    case 'GUILD_BUY_MARKER':
      guildBuyMarker(state, action.playerId, action.value)
      break
    case 'GUILD_SELL_MARKER':
      guildSellMarker(state, action.playerId, action.value)
      break
    case 'BUY_LOT':
      buyLot(state, action.playerId, action.lot, action.payment)
      break
    case 'TRADE_CITY':
      tradeCity(state, action.playerId, action.give, action.take)
      break
    case 'CHANGE_ROUTE':
      changeRoute(state, action.playerId, action.slot, action.value)
      break
    case 'RAID':
      raid(state, action.playerId, action.mode === 'player' ? action.targetId : null)
      break
    case 'RAID_SPLIT':
      raidSplit(state, action.playerId, action.groupA)
      break
    case 'RAID_TAKE':
      raidTake(state, action.playerId, action.group)
      break
    case 'RAID_ROUTE':
      raidRoute(state, action.playerId, action.slot)
      break
    case 'TRADE_PLAYERS':
      tradePlayers(state, action.playerId, action.partnerId, action.give, action.receive)
      break
    case 'END_TURN':
      endTurn(state, action.playerId)
      break
    default:
      fail('Unknown action.')
  }
  state.actionHistory.push(action)
  return state
}

export function replayKogge(setup: KoggeSetup, actions: KoggeAction[]): KoggeState {
  return actions.reduce(applyKoggeAction, createKoggeGame(setup))
}

/** The error message `action` would raise, or null if it is legal. */
export function validateKoggeAction(state: KoggeState, action: KoggeAction): string | null {
  try {
    applyKoggeAction(state, action)
    return null
  } catch (err) {
    if (err instanceof KoggeRuleError) return err.message
    throw err
  }
}

/** The player the game is currently waiting on, if a single one. */
export function activePlayerId(state: KoggeState): string | null {
  switch (state.phase) {
    case 'startPick':
      return state.players.find((p) => state.startPicks[p.id] === null)?.id ?? null
    case 'auction':
      return state.turnOrder[state.bids.length] ?? null
    case 'guildmaster':
      return state.turnOrder[0]
    case 'actions':
      if (state.pending?.kind === 'split') return state.pending.defenderId
      if (state.pending?.kind === 'choose') return state.pending.attackerId
      if (state.pending?.kind === 'route') return state.pending.chooserId
      return state.turn?.playerId ?? null
    default:
      return null
  }
}

// ─── Start pick ───────────────────────────────────────────────────────────

function pickStart(state: KoggeState, playerId: string, value: number) {
  if (state.phase !== 'startPick') fail('Starting cities have already been chosen.')
  const p = player(state, playerId)
  if (state.startPicks[p.id] !== null) fail('You already picked.')
  if (!Number.isInteger(value) || value < 0 || value > 8 || p.hand[value] <= 0) fail('Pick a marker from your hand.')
  state.startPicks[p.id] = value
  if (Object.values(state.startPicks).some((v) => v === null)) return

  const byCity = new Map<number, string[]>()
  for (const pl of state.players) {
    const v = state.startPicks[pl.id] as number
    byCity.set(v, [...(byCity.get(v) ?? []), pl.id])
  }
  const crowded = [...byCity.entries()].filter(([, ids]) => ids.length > 2)
  if (crowded.length > 0) {
    for (const [city, ids] of crowded) {
      for (const id of ids) state.startPicks[id] = null
      state.log.push(`${ids.map((id) => playerName(state, id)).join(', ')} all picked city ${city} — they pick again.`)
    }
    return
  }

  for (const pl of state.players) {
    const city = state.startPicks[pl.id] as number
    pl.boatCity = city
    state.houses.push({ ownerId: pl.id, city, goods: emptyGoods() })
  }
  state.log.push(`Starting cities: ${state.players.map((pl) => `${pl.name} → ${pl.boatCity}`).join(', ')}.`)

  const cities = [...byCity.keys()].sort((a, b) => a - b)
  state.turnOrder = cities.flatMap((c) => shuffle(state, byCity.get(c) as string[]))
  startRound(state)
}

// ─── Round start and auction ──────────────────────────────────────────────

function startRound(state: KoggeState) {
  state.round += 1
  state.phase = 'auction'
  state.bids = []
  state.turn = null
  state.log.push(`— Round ${state.round} —`)

  for (const id of state.turnOrder) {
    const p = player(state, id)
    for (const bonus of p.bonuses) {
      if (bonus !== 'extraMarker') continue
      const v = drawFromReserve(state)
      if (v !== null) {
        p.hand[v] += 1
        state.log.push(`${p.name} draws a ${v} (Extra marker).`)
      }
    }
  }

  for (const lot of state.lots) for (const v of lot) state.reserve[v] += 1
  state.lots = []
  for (let i = 0; i < LOT_COUNT; i++) {
    const lot: number[] = []
    for (let j = 0; j < LOT_SIZE; j++) {
      const v = drawFromReserve(state)
      if (v !== null) lot.push(v)
    }
    if (lot.length > 0) state.lots.push(lot)
  }
}

function bid(state: KoggeState, playerId: string, markers: number[]) {
  if (state.phase !== 'auction') fail('It is not the auction.')
  if (activePlayerId(state) !== playerId) fail('It is not your turn to bid.')
  const p = player(state, playerId)
  const previous = state.bids.map((b) => b.markers)

  if (markers.length === 0) {
    if (hasLegalBid(p.hand, previous)) fail('You must bid while any legal bid is possible.')
  } else {
    if (markers.some((m) => !Number.isInteger(m) || m < 0 || m > 8)) fail('Invalid marker.')
    const counts = countMarkers(markers)
    if (counts.some((c, v) => c > p.hand[v])) fail('You do not hold those markers.')
    if (previous.some((b) => b.length > 0 && bidKey(b) === bidKey(markers))) fail('That exact bid was already made.')
    counts.forEach((c, v) => (p.hand[v] -= c))
  }
  state.bids.push({ playerId, markers: markers.slice().sort((a, b) => b - a) })
  state.log.push(`${p.name} bids ${describeBid(markers)}.`)

  if (state.bids.length < state.turnOrder.length) return
  resolveAuction(state)
}

function resolveAuction(state: KoggeState) {
  // Stable sort: bids are in previous turn order, so earlier bidders win ties.
  const ranked = state.bids.map((b, i) => ({ b, i })).sort((x, y) => compareBids(y.b.markers, x.b.markers) || x.i - y.i)
  state.turnOrder = ranked.map((r) => r.b.playerId)
  state.log.push(`Turn order: ${state.turnOrder.map((id, i) => `${i + 1}. ${playerName(state, id)}`).join(', ')}.`)

  const used = emptyMarkers()
  for (const b of state.bids) for (const m of b.markers) used[m] += 1
  for (let n = 8; n >= 0; n--) {
    if (used[n] === 0) continue
    const city = state.cities[n]
    const added = emptyGoods()
    const got = takeFromSupply(state, city.color, 2 * used[n], added)
    const houses = state.houses.filter((h) => h.city === n)
    if (houses.length > 0 && got >= houses.length) {
      for (const h of houses) {
        h.goods[city.color] += 1
        added[city.color] -= 1
      }
    }
    addGoods(city.goods, added)
    if (got > 0) state.log.push(`City ${n} gains ${got} ${city.color}${houses.length > 0 && got >= houses.length ? ` (${houses.length} set beside houses)` : ''}.`)
  }
  for (let v = 0; v < 9; v++) state.reserve[v] += used[v]
  state.phase = 'guildmaster'
}

// ─── Guildmaster ──────────────────────────────────────────────────────────

/** The cities the Guildmaster would pass through for `steps`, last = destination. */
export function guildmasterPath(state: KoggeState, steps: 1 | 2): number[] {
  const path: number[] = []
  let idx = state.ring.indexOf(state.guildmaster.city)
  let counted = 0
  for (let guard = 0; guard < state.ring.length * 3 && counted < steps; guard++) {
    idx = (idx + 1) % state.ring.length
    const city = state.ring[idx]
    path.push(city)
    if (state.cities[city].raids.length === 0) counted += 1
  }
  // Every other city raided: the Guildmaster cannot move.
  if (counted < steps) return []
  return path
}

function moveGuildmaster(state: KoggeState, playerId: string, steps: 1 | 2) {
  if (state.phase !== 'guildmaster') fail('It is not the Guildmaster phase.')
  if (state.turnOrder[0] !== playerId) fail('Only the start player moves the Guildmaster.')
  if (steps !== 1 && steps !== 2) fail('The Guildmaster moves 1 or 2 cities.')
  const path = guildmasterPath(state, steps)
  if (path.length > 0) {
    const dest = path[path.length - 1]
    state.guildmaster.city = dest
    if (path.includes(state.guildmaster.start)) {
      state.guildmaster.returns += 1
      if (state.guildmaster.returns >= 2) state.finalRound = true
    }
    const city = state.cities[dest]
    const got = takeFromSupply(state, city.color, 2, city.goods)
    state.log.push(`${playerName(state, playerId)} moves the Guildmaster to city ${dest}${got > 0 ? `, which gains ${got} ${city.color}` : ''}.`)
    if (state.finalRound) state.log.push('The Guildmaster has returned to its start for the second time — this is the final round.')
  } else {
    state.log.push('The Guildmaster cannot move.')
  }
  state.phase = 'actions'
  beginTurn(state, state.turnOrder[0])
}

// ─── Action phase ─────────────────────────────────────────────────────────

function beginTurn(state: KoggeState, playerId: string) {
  state.turn = { playerId, movesMade: 0, moved: false, movementClosed: false, used: [] }
}

function requireTurn(state: KoggeState, playerId: string) {
  if (state.phase !== 'actions' || !state.turn) fail('It is not the action phase.')
  if (state.pending) fail('A raid must be resolved first.')
  if (state.turn.playerId !== playerId) fail('It is not your turn.')
  return { turn: state.turn, p: player(state, playerId) }
}

function startAction(state: KoggeState, playerId: string, kind: TurnActionKind) {
  const ctx = requireTurn(state, playerId)
  if (ctx.turn.used.includes(kind)) fail('You already took that action this turn.')
  if (ctx.p.boatCity === null) fail('Your boat is not on the board.')
  return { ...ctx, city: state.cities[ctx.p.boatCity] }
}

function finishAction(state: KoggeState, kind: TurnActionKind) {
  const turn = state.turn as NonNullable<KoggeState['turn']>
  turn.used.push(kind)
  turn.movementClosed = true
}

function collectHouseGoods(state: KoggeState, p: KoggePlayer, cityNumber: number) {
  for (const h of state.houses) {
    if (h.ownerId !== p.id || h.city !== cityNumber || goodsTotal(h.goods) === 0) continue
    state.log.push(`${p.name} collects ${formatGoods(h.goods)} from their house in city ${cityNumber}.`)
    addGoods(p.goods, h.goods)
    h.goods = emptyGoods()
  }
}

/** Cost (goods or markers) of the next movement for `p` this turn. */
export function nextMoveCost(state: KoggeState, p: KoggePlayer, route: 0 | 1 | 'guildmaster'): number {
  const made = state.turn?.movesMade ?? 0
  const base = made === 0 ? 0 : made === 1 && hasBonus(p, 'freeSecondMove') ? 0 : 1
  return base + (route === 'guildmaster' ? 1 : 0)
}

function pay(state: KoggeState, p: KoggePlayer, payments: Payment[]) {
  for (const pm of payments) {
    if (pm.kind === 'good') {
      if (!GOOD_COLORS.includes(pm.color) || p.goods[pm.color] <= 0) fail(`You have no ${pm.color} good to pay with.`)
      p.goods[pm.color] -= 1
      state.supply[pm.color] += 1
    } else {
      if (!Number.isInteger(pm.value) || pm.value < 0 || pm.value > 8 || p.hand[pm.value] <= 0) fail(`You have no ${pm.value} marker to pay with.`)
      p.hand[pm.value] -= 1
      state.reserve[pm.value] += 1
    }
  }
}

function move(state: KoggeState, playerId: string, route: 0 | 1 | 'guildmaster', payments: Payment[]) {
  const { turn, p } = requireTurn(state, playerId)
  if (turn.movementClosed) fail('You can no longer sail this turn.')
  const from = p.boatCity as number
  const cost = nextMoveCost(state, p, route)
  if (payments.length !== cost) fail(cost === 0 ? 'This move is free.' : `This move costs ${cost} good${cost === 1 ? '' : 's'} or marker${cost === 1 ? '' : 's'}.`)

  let dest: number
  let revealed = false
  if (route === 'guildmaster') {
    if (!hasBonus(p, 'secretPassage')) fail('You need the Secret passage bonus.')
    dest = state.guildmaster.city
    if (dest === from) fail('The Guildmaster is already here.')
    if (raidedBy(state.cities[dest], p.id)) fail('You may never sail to a city you raided.')
  } else {
    if (route !== 0 && route !== 1) fail('Choose route 0 or 1.')
    const slot = state.cities[from].slots[route]
    dest = slot.value
    if (slot.faceUp && (dest === from || raidedBy(state.cities[dest], p.id))) fail('You may never sail to a city you raided.')
    revealed = !slot.faceUp
    slot.faceUp = true
  }

  pay(state, p, payments)
  turn.movesMade += 1
  if (revealed) state.log.push(`${p.name} flips a hidden route: it leads to ${dest}.`)
  if (dest === from || raidedBy(state.cities[dest], p.id)) {
    state.log.push(`${p.name} cannot sail there — the move is lost.`)
    return
  }
  collectHouseGoods(state, p, from)
  p.boatCity = dest
  turn.moved = true
  state.log.push(`${p.name} sails ${from} → ${dest}${payments.length > 0 ? ` paying ${payments.map(formatPayment).join(', ')}` : ''}.`)
  collectHouseGoods(state, p, dest)
}

export function buildCost(state: KoggeState, cityNumber: number): { goods: GoodColor[]; markers: number } {
  const color = state.cities[cityNumber].color
  const existing = state.houses.filter((h) => h.city === cityNumber).length
  return { goods: GOOD_COLORS.filter((c) => c !== color), markers: existing >= 1 ? 2 : 1 }
}

function buildHouse(state: KoggeState, playerId: string) {
  const { p, city } = startAction(state, playerId, 'build')
  if (state.houses.filter((h) => h.city === city.number).length >= 2) fail('This city already has two houses.')
  const cost = buildCost(state, city.number)
  for (const c of cost.goods) if (p.goods[c] < 1) fail(`Building here needs a ${c} good.`)
  if (p.hand[city.number] < cost.markers) fail(`Building here needs ${cost.markers} route marker${cost.markers === 1 ? '' : 's'} numbered ${city.number}.`)
  for (const c of cost.goods) {
    p.goods[c] -= 1
    state.supply[c] += 1
  }
  p.hand[city.number] -= cost.markers
  state.reserve[city.number] += cost.markers
  state.houses.push({ ownerId: p.id, city: city.number, goods: emptyGoods() })
  finishAction(state, 'build')
  state.log.push(`${p.name} builds a house in city ${city.number}.`)
  checkDevelopmentWin(state, p)
}

function startGuild(state: KoggeState, playerId: string) {
  const ctx = startAction(state, playerId, 'guild')
  if (state.guildmaster.city !== ctx.city.number) fail('The Guildmaster is not in your city.')
  return ctx
}

function guildRaidMarker(state: KoggeState, playerId: string, value: number) {
  const { p } = startGuild(state, playerId)
  if (p.secondRaidMarkerTaken) fail('You already earned your second raid marker.')
  if (!Number.isInteger(value) || value < 0 || value > 8 || p.hand[value] < 3) fail('You need three identical route markers.')
  p.hand[value] -= 3
  state.reserve[value] += 3
  p.raidMarkersInHand += 1
  p.secondRaidMarkerTaken = true
  finishAction(state, 'guild')
  state.log.push(`${p.name} returns three ${value}s to the Guildmaster for a second raid marker.`)
}

function guildBonus(state: KoggeState, playerId: string, color: GoodColor, bonus: (typeof BONUS_TYPES)[number]) {
  const { p } = startGuild(state, playerId)
  if (!GOOD_COLORS.includes(color) || p.goods[color] < 6) fail('You need six goods of one colour.')
  if (!BONUS_TYPES.includes(bonus) || state.bonusSupply[bonus] <= 0) fail('That bonus marker is gone.')
  p.goods[color] -= 6
  state.supply[color] += 6
  state.bonusSupply[bonus] -= 1
  p.bonuses.push(bonus)
  finishAction(state, 'guild')
  state.log.push(`${p.name} sells six ${color} to the Guildmaster for ${BONUS_LABELS[bonus]}.`)
  checkDevelopmentWin(state, p)
}

function guildBuyMarker(state: KoggeState, playerId: string, value: number) {
  const { p } = startGuild(state, playerId)
  if (!Number.isInteger(value) || value < 0 || value > 8) fail('Invalid marker.')
  const color = markerColor(value)
  if (p.goods[color] < 1) fail(`A ${value} marker costs a ${color} good.`)
  if (state.reserve[value] <= 0) fail(`No ${value} markers left in the reserve.`)
  p.goods[color] -= 1
  state.supply[color] += 1
  state.reserve[value] -= 1
  p.hand[value] += 1
  finishAction(state, 'guild')
  state.log.push(`${p.name} buys a ${value} marker for a ${color} good.`)
}

function guildSellMarker(state: KoggeState, playerId: string, value: number) {
  const { p } = startGuild(state, playerId)
  if (!Number.isInteger(value) || value < 0 || value > 8 || p.hand[value] < 1) fail('You do not hold that marker.')
  const color = markerColor(value)
  if (state.supply[color] < 1) fail(`No ${color} goods left in the supply.`)
  p.hand[value] -= 1
  state.reserve[value] += 1
  state.supply[color] -= 1
  p.goods[color] += 1
  finishAction(state, 'guild')
  state.log.push(`${p.name} returns a ${value} marker for a ${color} good.`)
}

function buyLot(state: KoggeState, playerId: string, lot: number, payment: GoodColor) {
  const { p } = startAction(state, playerId, 'buyLot')
  const markers = state.lots[lot]
  if (!markers) fail('That lot is not available.')
  if (!GOOD_COLORS.includes(payment) || p.goods[payment] < 1) fail(`You have no ${payment} good.`)
  p.goods[payment] -= 1
  state.supply[payment] += 1
  for (const v of markers) p.hand[v] += 1
  state.lots.splice(lot, 1)
  finishAction(state, 'buyLot')
  state.log.push(`${p.name} buys the lot ${markers.join(' + ')} for a ${payment} good.`)
}

function tradeCity(state: KoggeState, playerId: string, give: GoodColor, take: GoodColor[]) {
  const { turn, p, city } = startAction(state, playerId, 'tradeCity')
  if (!turn.moved) fail('You can only trade with a city after sailing this turn.')
  if (!GOOD_COLORS.includes(give) || p.goods[give] < 1) fail(`You have no ${give} good.`)
  const max = hasBonus(p, 'tripleTrade') ? 3 : 2
  if (take.length !== 2 && take.length !== max) fail(`Take ${max === 3 ? '2 or 3' : '2'} goods.`)
  if (take.some((c) => !GOOD_COLORS.includes(c) || c === give)) fail('You must take goods of a different colour from the one you give.')
  const wanted = emptyGoods()
  for (const c of take) wanted[c] += 1
  for (const c of GOOD_COLORS) if (wanted[c] > city.goods[c]) fail(`The city does not have ${wanted[c]} ${c}.`)
  p.goods[give] -= 1
  city.goods[give] += 1
  for (const c of GOOD_COLORS) {
    city.goods[c] -= wanted[c]
    p.goods[c] += wanted[c]
  }
  finishAction(state, 'tradeCity')
  state.log.push(`${p.name} trades a ${give} good to city ${city.number} for ${formatGoods(wanted)}.`)
}

function changeRoute(state: KoggeState, playerId: string, slot: 0 | 1, value: number) {
  const { p, city } = startAction(state, playerId, 'changeRoute')
  const target = city.slots[slot]
  if (!target) fail('Choose route 0 or 1.')
  if (!target.faceUp) fail('Only a face-up route can be changed.')
  if (!Number.isInteger(value) || value < 0 || value > 8 || p.hand[value] < 1) fail('You do not hold that marker.')
  if (value === city.number) fail('A city cannot hold a route to itself.')
  const old = target.value
  p.hand[value] -= 1
  p.hand[old] += 1
  city.slots[slot] = { value, faceUp: false }
  finishAction(state, 'changeRoute')
  state.log.push(`${p.name} takes the ${old} route from city ${city.number} and lays a hidden one.`)
}

function raid(state: KoggeState, playerId: string, targetId: string | null) {
  const { p, city } = startAction(state, playerId, 'raid')
  if (p.raidMarkersInHand < 1) fail('You have no raid marker.')
  if (raidedBy(city, p.id)) fail('You already raided this city.')
  let target: KoggePlayer | null = null
  if (targetId !== null) {
    target = player(state, targetId)
    if (target.id === p.id) fail('You cannot raid yourself.')
    if (target.boatCity !== city.number) fail(`${target.name}'s boat is not here.`)
  }
  p.raidMarkersInHand -= 1
  city.raids.push(p.id)
  finishAction(state, 'raid')

  if (target) {
    state.log.push(`${p.name} raids ${target.name}'s boat in city ${city.number}.`)
    if (goodsTotal(target.goods) > 0) {
      state.pending = { kind: 'split', attackerId: p.id, defenderId: target.id }
      return
    }
    state.log.push(`${target.name} has nothing to take.`)
  } else {
    const loot = { ...city.goods }
    city.goods = emptyGoods()
    for (const h of state.houses) {
      if (h.city !== city.number) continue
      addGoods(loot, h.goods)
      h.goods = emptyGoods()
    }
    addGoods(p.goods, loot)
    state.log.push(`${p.name} raids city ${city.number} and takes ${goodsTotal(loot) > 0 ? formatGoods(loot) : 'nothing'}.`)
  }
  beginForcedMove(state, p)
}

function raidSplit(state: KoggeState, playerId: string, groupA: Goods) {
  const pending = state.pending
  if (pending?.kind !== 'split' || pending.defenderId !== playerId) fail('You are not splitting goods for a raid.')
  const d = player(state, playerId)
  const groupB = emptyGoods()
  for (const c of GOOD_COLORS) {
    const a = groupA[c]
    if (!Number.isInteger(a) || a < 0 || a > d.goods[c]) fail('Invalid split.')
    groupB[c] = d.goods[c] - a
  }
  if (Math.abs(goodsTotal(groupA) - goodsTotal(groupB)) > 1) fail('The two piles must differ by at most one good.')
  state.pending = { kind: 'choose', attackerId: pending.attackerId, defenderId: d.id, groupA: { ...groupA }, groupB }
  state.log.push(`${d.name} splits their goods: ${formatGoods(groupA)} | ${formatGoods(groupB)}.`)
}

function raidTake(state: KoggeState, playerId: string, group: 'A' | 'B') {
  const pending = state.pending
  if (pending?.kind !== 'choose' || pending.attackerId !== playerId) fail('You are not choosing a raid pile.')
  if (group !== 'A' && group !== 'B') fail('Choose pile A or B.')
  const a = player(state, playerId)
  const d = player(state, pending.defenderId)
  const pile = group === 'A' ? pending.groupA : pending.groupB
  for (const c of GOOD_COLORS) {
    d.goods[c] -= pile[c]
    a.goods[c] += pile[c]
  }
  state.log.push(`${a.name} takes ${goodsTotal(pile) > 0 ? formatGoods(pile) : 'nothing'} from ${d.name}.`)
  beginForcedMove(state, a)
}

/** The next seat after the raider — "the player to your left". */
export function leftOf(state: KoggeState, id: string): string {
  const seat = player(state, id).seat
  return state.players.find((p) => p.seat === (seat + 1) % state.players.length)!.id
}

function beginForcedMove(state: KoggeState, raider: KoggePlayer) {
  state.pending = { kind: 'route', attackerId: raider.id, chooserId: leftOf(state, raider.id) }
}

function raidRoute(state: KoggeState, playerId: string, slot: 0 | 1) {
  const pending = state.pending
  if (pending?.kind !== 'route' || pending.chooserId !== playerId) fail('You are not choosing the raider’s route.')
  if (slot !== 0 && slot !== 1) fail('Choose route 0 or 1.')
  const raider = player(state, pending.attackerId)
  const from = raider.boatCity as number
  const s = state.cities[from].slots[slot]
  s.faceUp = true
  const dest = s.value
  state.pending = null
  if (raidedBy(state.cities[dest], raider.id) || dest === from) {
    state.log.push(`${playerName(state, playerId)} sends ${raider.name} toward ${dest}, a city they raided — the boat stays in ${from}.`)
  } else {
    raider.boatCity = dest
    state.log.push(`${playerName(state, playerId)} sends ${raider.name} ${from} → ${dest}.`)
    collectHouseGoods(state, raider, dest)
  }
  advanceTurn(state)
}

function tradePlayers(state: KoggeState, playerId: string, partnerId: string, give: TradeBundle, receive: TradeBundle) {
  const { p } = requireTurn(state, playerId)
  const partner = player(state, partnerId)
  if (partner.id === p.id) fail('Choose another player.')
  if (partner.boatCity !== p.boatCity) fail(`${partner.name}'s boat is not in your city.`)
  checkBundle(p, give)
  checkBundle(partner, receive)
  if (goodsTotal(give.goods) + give.markers.reduce((a, b) => a + b, 0) + goodsTotal(receive.goods) + receive.markers.reduce((a, b) => a + b, 0) === 0) fail('The trade is empty.')
  transferBundle(p, partner, give)
  transferBundle(partner, p, receive)
  state.log.push(`${p.name} trades ${formatBundle(give)} to ${partner.name} for ${formatBundle(receive)}.`)
}

function checkBundle(from: KoggePlayer, bundle: TradeBundle) {
  for (const c of GOOD_COLORS) {
    const n = bundle.goods[c]
    if (!Number.isInteger(n) || n < 0 || n > from.goods[c]) fail(`${from.name} does not have those goods.`)
  }
  if (bundle.markers.length !== 9) fail('Invalid markers.')
  bundle.markers.forEach((n, v) => {
    if (!Number.isInteger(n) || n < 0 || n > from.hand[v]) fail(`${from.name} does not have those markers.`)
  })
}

function transferBundle(from: KoggePlayer, to: KoggePlayer, bundle: TradeBundle) {
  for (const c of GOOD_COLORS) {
    from.goods[c] -= bundle.goods[c]
    to.goods[c] += bundle.goods[c]
  }
  bundle.markers.forEach((n, v) => {
    from.hand[v] -= n
    to.hand[v] += n
  })
}

function endTurn(state: KoggeState, playerId: string) {
  requireTurn(state, playerId)
  state.log.push(`${playerName(state, playerId)} ends their turn.`)
  advanceTurn(state)
}

function advanceTurn(state: KoggeState) {
  const idx = state.turnOrder.indexOf((state.turn as NonNullable<KoggeState['turn']>).playerId)
  const next = state.turnOrder[idx + 1]
  if (next) {
    beginTurn(state, next)
    return
  }
  state.turn = null
  if (state.finalRound) {
    finishByVictoryPoints(state)
    return
  }
  startRound(state)
}

// ─── Game end ─────────────────────────────────────────────────────────────

function checkDevelopmentWin(state: KoggeState, p: KoggePlayer) {
  if (developmentPoints(state, p.id) < WINNING_DP) return
  state.phase = 'finished'
  state.turn = null
  state.winnerIds = [p.id]
  state.endReason = 'development'
  state.log.push(`${p.name} reaches ${WINNING_DP} development points and wins!`)
}

function finishByVictoryPoints(state: KoggeState) {
  const scores = state.players.map((p) => ({ id: p.id, vp: victoryPoints(state, p.id).total }))
  const best = Math.max(...scores.map((s) => s.vp))
  state.phase = 'finished'
  state.winnerIds = scores.filter((s) => s.vp === best).map((s) => s.id)
  state.endReason = 'guildmaster'
  state.log.push(`Game over. ${scores.map((s) => `${playerName(state, s.id)} ${s.vp} VP`).join(', ')}. Winner: ${state.winnerIds.map((id) => playerName(state, id)).join(' & ')}.`)
}

// ─── Formatting ───────────────────────────────────────────────────────────

export function formatGoods(goods: Goods): string {
  const parts = GOOD_COLORS.filter((c) => goods[c] > 0).map((c) => `${goods[c]} ${c}`)
  return parts.length > 0 ? parts.join(', ') : 'no goods'
}

function formatPayment(pm: Payment): string {
  return pm.kind === 'good' ? `a ${pm.color} good` : `a ${pm.value} marker`
}

function formatBundle(b: TradeBundle): string {
  const markers = b.markers.flatMap((n, v) => new Array<number>(n).fill(v))
  const parts = [goodsTotal(b.goods) > 0 ? formatGoods(b.goods) : '', markers.length > 0 ? `markers ${markers.join(', ')}` : ''].filter(Boolean)
  return parts.length > 0 ? parts.join(' and ') : 'nothing'
}

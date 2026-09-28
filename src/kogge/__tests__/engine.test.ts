import { describe, expect, it } from 'vitest'
import { compareBids, hasLegalBid } from '../bids'
import { RESERVE_COUNTS, SUPPLY_COUNTS } from '../board'
import {
  activePlayerId,
  applyKoggeAction,
  createKoggeGame,
  developmentPoints,
  emptyGoods,
  emptyMarkers,
  goodsTotal,
  guildmasterPath,
  replayKogge,
  validateKoggeAction,
  victoryPoints,
} from '../engine'
import { GOOD_COLORS, type KoggeAction, type KoggeState } from '../types'

const SETUP = {
  seed: 12345,
  players: [
    { id: 'a', name: 'Ada' },
    { id: 'b', name: 'Bo' },
    { id: 'c', name: 'Cy' },
  ],
}

function run(state: KoggeState, ...actions: KoggeAction[]): KoggeState {
  return actions.reduce(applyKoggeAction, state)
}

/** Picks distinct starting cities 1, 2, 3 for a, b, c — so turn order is a, b, c. */
function started(): KoggeState {
  return run(
    createKoggeGame(SETUP),
    { type: 'PICK_START', playerId: 'a', value: 1 },
    { type: 'PICK_START', playerId: 'b', value: 2 },
    { type: 'PICK_START', playerId: 'c', value: 3 },
  )
}

/** Runs the auction with single-marker bids a:8, b:7, c:6 and moves the Guildmaster 1. */
function inActions(): KoggeState {
  return run(
    started(),
    { type: 'BID', playerId: 'a', markers: [8] },
    { type: 'BID', playerId: 'b', markers: [7] },
    { type: 'BID', playerId: 'c', markers: [6] },
    { type: 'MOVE_GUILDMASTER', playerId: 'a', steps: 1 },
  )
}

function totalMarkers(state: KoggeState): number[] {
  const counts = state.reserve.slice()
  for (const p of state.players) p.hand.forEach((n, v) => (counts[v] += n))
  for (const c of state.cities) for (const s of c.slots) counts[s.value] += 1
  for (const lot of state.lots) for (const v of lot) counts[v] += 1
  // Bid markers are out of hand until the auction resolves.
  if (state.phase === 'auction') for (const b of state.bids) for (const v of b.markers) counts[v] += 1
  return counts
}

function totalGoods(state: KoggeState) {
  const t = { ...state.supply }
  for (const p of state.players) for (const c of GOOD_COLORS) t[c] += p.goods[c]
  for (const city of state.cities) for (const c of GOOD_COLORS) t[c] += city.goods[c]
  for (const h of state.houses) for (const c of GOOD_COLORS) t[c] += h.goods[c]
  return t
}

describe('setup', () => {
  it('deals hands, goods, and legal city routes', () => {
    const s = createKoggeGame(SETUP)
    expect(s.phase).toBe('startPick')
    for (const p of s.players) {
      expect(p.hand).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
      expect(p.goods).toEqual({ grey: 2, orange: 1, purple: 0, white: 0 })
      expect(p.raidMarkersInHand).toBe(1)
    }
    for (const city of s.cities) {
      expect(goodsTotal(city.goods)).toBe(3)
      expect(city.goods[city.color]).toBe(3)
      const [x, y] = city.slots
      expect(x.value).not.toBe(city.number)
      expect(y.value).not.toBe(city.number)
      expect(x.value).not.toBe(y.value)
    }
    expect(totalMarkers(s)).toEqual(RESERVE_COUNTS)
    expect(totalGoods(s)).toEqual(SUPPLY_COUNTS)
  })

  it('is deterministic for a seed and differs across seeds', () => {
    expect(createKoggeGame(SETUP)).toEqual(createKoggeGame(SETUP))
    expect(createKoggeGame({ ...SETUP, seed: 99 }).cities).not.toEqual(createKoggeGame(SETUP).cities)
  })

  it('rejects bad player counts', () => {
    expect(() => createKoggeGame({ seed: 1, players: [{ id: 'a', name: 'A' }] })).toThrow()
  })
})

describe('start pick', () => {
  it('places boats and houses and orders by city number', () => {
    const s = run(
      createKoggeGame(SETUP),
      { type: 'PICK_START', playerId: 'a', value: 5 },
      { type: 'PICK_START', playerId: 'b', value: 2 },
      { type: 'PICK_START', playerId: 'c', value: 7 },
    )
    expect(s.phase).toBe('auction')
    expect(s.round).toBe(1)
    expect(s.turnOrder).toEqual(['b', 'a', 'c'])
    expect(s.players.map((p) => p.boatCity)).toEqual([5, 2, 7])
    expect(s.houses).toHaveLength(3)
    expect(s.lots).toHaveLength(4)
    expect(s.lots.every((l) => l.length === 2)).toBe(true)
  })

  it('makes three players on one city pick again', () => {
    const s = run(
      createKoggeGame(SETUP),
      { type: 'PICK_START', playerId: 'a', value: 4 },
      { type: 'PICK_START', playerId: 'b', value: 4 },
      { type: 'PICK_START', playerId: 'c', value: 4 },
    )
    expect(s.phase).toBe('startPick')
    expect(Object.values(s.startPicks)).toEqual([null, null, null])
  })

  it('allows two players to share a city', () => {
    const s = run(
      createKoggeGame(SETUP),
      { type: 'PICK_START', playerId: 'a', value: 4 },
      { type: 'PICK_START', playerId: 'b', value: 4 },
      { type: 'PICK_START', playerId: 'c', value: 0 },
    )
    expect(s.turnOrder[0]).toBe('c')
    expect(s.turnOrder.slice(1).sort()).toEqual(['a', 'b'])
  })
})

describe('bids', () => {
  it('ranks sets above mixed bids, then by size, then by value', () => {
    expect(compareBids([0, 0], [7, 8])).toBeGreaterThan(0)
    expect(compareBids([2, 2, 2], [6, 6])).toBeGreaterThan(0)
    expect(compareBids([6, 6], [5, 5])).toBeGreaterThan(0)
    expect(compareBids([8], [7])).toBeGreaterThan(0)
    expect(compareBids([1, 8], [4, 4])).toBeLessThan(0)
    expect(compareBids([1, 8], [2, 6])).toBeGreaterThan(0)
    expect(compareBids([0], [])).toBeGreaterThan(0)
  })

  it('knows when no legal bid remains', () => {
    const hand = emptyMarkers()
    hand[3] = 1
    expect(hasLegalBid(hand, [[3]])).toBe(false)
    expect(hasLegalBid(hand, [[4]])).toBe(true)
    expect(hasLegalBid(emptyMarkers(), [])).toBe(false)
  })

  it('forbids duplicate bids and passing while a bid is possible', () => {
    const s = run(started(), { type: 'BID', playerId: 'a', markers: [5] })
    expect(validateKoggeAction(s, { type: 'BID', playerId: 'b', markers: [5] })).toMatch(/already/)
    expect(validateKoggeAction(s, { type: 'BID', playerId: 'b', markers: [] })).toMatch(/must bid/)
    expect(validateKoggeAction(s, { type: 'BID', playerId: 'c', markers: [4] })).toMatch(/not your turn/)
  })

  it('reorders turns and resupplies cities, feeding houses', () => {
    const before = started()
    const s = run(
      before,
      { type: 'BID', playerId: 'a', markers: [2] },
      { type: 'BID', playerId: 'b', markers: [0, 8] },
      { type: 'BID', playerId: 'c', markers: [1] },
    )
    // b bid 0+8 (sum 8), a bid set {2}, c bid set {1}: sets beat mixed bids.
    expect(s.turnOrder).toEqual(['a', 'c', 'b'])
    expect(s.phase).toBe('guildmaster')
    // City 2 (b's house) gained 2 grey: one goes beside b's house.
    const house = s.houses.find((h) => h.ownerId === 'b')!
    expect(house.goods.grey).toBe(1)
    expect(s.cities[2].goods.grey).toBe(before.cities[2].goods.grey + 1)
    expect(s.cities[8].goods.white).toBe(before.cities[8].goods.white + 2)
    expect(totalMarkers(s)).toEqual(RESERVE_COUNTS)
    expect(totalGoods(s)).toEqual(SUPPLY_COUNTS)
  })
})

describe('guildmaster', () => {
  it('skips raided cities and adds goods', () => {
    const s = run(started(), { type: 'BID', playerId: 'a', markers: [8] }, { type: 'BID', playerId: 'b', markers: [7] }, { type: 'BID', playerId: 'c', markers: [6] })
    const ringIdx = s.ring.indexOf(s.guildmaster.city)
    const next = s.ring[(ringIdx + 1) % 9]
    const after = s.ring[(ringIdx + 2) % 9]
    s.cities[next].raids.push('c')
    expect(guildmasterPath(s, 1)).toEqual([next, after])
    const moved = applyKoggeAction(s, { type: 'MOVE_GUILDMASTER', playerId: 'a', steps: 1 })
    expect(moved.guildmaster.city).toBe(after)
    expect(moved.phase).toBe('actions')
    expect(moved.turn?.playerId).toBe('a')
  })

  it('marks the final round on the second return and ends by VP', () => {
    let s = inActions()
    s.guildmaster.returns = 1
    s.phase = 'guildmaster'
    // Put the Guildmaster just before its start.
    s.guildmaster.city = s.ring[(s.ring.indexOf(s.guildmaster.start) + 8) % 9]
    s = run(s, { type: 'MOVE_GUILDMASTER', playerId: s.turnOrder[0], steps: 2 })
    expect(s.finalRound).toBe(true)
    for (const id of s.turnOrder) s = applyKoggeAction(s, { type: 'END_TURN', playerId: id })
    expect(s.phase).toBe('finished')
    expect(s.endReason).toBe('guildmaster')
    expect(s.winnerIds.length).toBeGreaterThan(0)
  })
})

describe('movement', () => {
  it('first move is free, later moves cost, face-down reveal can lose the move', () => {
    let s = inActions()
    const a = s.players[0]
    const from = a.boatCity!
    const dest = s.cities[from].slots[0].value
    expect(validateKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 0, payments: [{ kind: 'good', color: 'grey' }] })).toMatch(/free/)
    s = applyKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 0, payments: [] })
    expect(s.players[0].boatCity).toBe(dest)
    expect(validateKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 0, payments: [] })).toMatch(/costs 1/)
    const greyBefore = s.players[0].goods.grey
    const dest2 = s.cities[dest].slots[1].value
    s = applyKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 1, payments: [{ kind: 'good', color: 'grey' }] })
    expect(s.players[0].boatCity).toBe(dest2)
    expect(s.players[0].goods.grey).toBe(greyBefore - 1)
  })

  it('never sails into an own raided city; a hidden route there wastes the free move', () => {
    const s = inActions()
    const from = s.players[0].boatCity!
    const target = s.cities[from].slots[0].value
    s.cities[target].raids.push('a')
    expect(validateKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 0, payments: [] })).toMatch(/raided/)
    s.cities[from].slots[0].faceUp = false
    const after = applyKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 0, payments: [] })
    expect(after.players[0].boatCity).toBe(from)
    expect(after.cities[from].slots[0].faceUp).toBe(true)
    expect(after.turn?.movesMade).toBe(1)
    expect(after.turn?.moved).toBe(false)
  })

  it('collects goods waiting beside houses along the way', () => {
    const s = inActions()
    const from = s.players[0].boatCity!
    s.houses.find((h) => h.ownerId === 'a')!.goods.white = 2
    const after = applyKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 0, payments: [] })
    expect(after.players[0].goods.white).toBe(2)
    expect(after.houses.find((h) => h.ownerId === 'a' && h.city === from)!.goods.white).toBe(0)
  })

  it('secret passage sails to the Guildmaster for an extra payment', () => {
    const s = inActions()
    s.players[0].bonuses.push('secretPassage')
    s.guildmaster.city = 7
    expect(validateKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 'guildmaster', payments: [] })).toMatch(/costs 1/)
    const after = applyKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 'guildmaster', payments: [{ kind: 'marker', value: 0 }] })
    expect(after.players[0].boatCity).toBe(7)
  })

  it('stops sailing once an action is taken', () => {
    let s = inActions()
    s = applyKoggeAction(s, { type: 'BUY_LOT', playerId: 'a', lot: 0, payment: 'grey' })
    expect(validateKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 0, payments: [] })).toMatch(/no longer sail/)
  })
})

describe('actions', () => {
  it('builds a house with the right cost and wins at 5 DP', () => {
    const s = inActions()
    const a = s.players[0]
    a.boatCity = 4 // orange city, empty
    a.goods = { grey: 1, orange: 0, purple: 1, white: 1 }
    const built = applyKoggeAction(s, { type: 'BUILD_HOUSE', playerId: 'a' })
    expect(built.houses.filter((h) => h.ownerId === 'a')).toHaveLength(2)
    expect(built.players[0].goods).toEqual(emptyGoods())
    expect(built.players[0].hand[4]).toBe(0)
    expect(validateKoggeAction(built, { type: 'BUILD_HOUSE', playerId: 'a' })).toMatch(/already/)

    // A second house in a city needs two matching markers.
    s.players[0].boatCity = 2
    s.players[0].goods = { grey: 0, orange: 1, purple: 1, white: 1 }
    expect(validateKoggeAction(s, { type: 'BUILD_HOUSE', playerId: 'a' })).toMatch(/2 route markers/)

    s.players[0].boatCity = 4
    s.players[0].goods = { grey: 1, orange: 0, purple: 1, white: 1 }
    s.players[0].bonuses = ['tripleTrade', 'extraMarker', 'freeSecondMove']
    const won = applyKoggeAction(s, { type: 'BUILD_HOUSE', playerId: 'a' })
    expect(developmentPoints(won, 'a')).toBe(5)
    expect(won.phase).toBe('finished')
    expect(won.winnerIds).toEqual(['a'])
    expect(won.endReason).toBe('development')
  })

  it('trades with the Guildmaster once per turn', () => {
    const s = inActions()
    s.guildmaster.city = s.players[0].boatCity!
    s.players[0].goods.purple = 6
    const bonus = applyKoggeAction(s, { type: 'GUILD_BONUS', playerId: 'a', color: 'purple', bonus: 'secretPassage' })
    expect(bonus.players[0].bonuses).toEqual(['secretPassage'])
    expect(bonus.bonusSupply.secretPassage).toBe(1)
    expect(validateKoggeAction(bonus, { type: 'GUILD_SELL_MARKER', playerId: 'a', value: 3 })).toMatch(/already/)

    s.supply.white = 1
    const sold = applyKoggeAction(s, { type: 'GUILD_SELL_MARKER', playerId: 'a', value: 7 })
    expect(sold.players[0].goods.white).toBe(1)
    const bought = applyKoggeAction(s, { type: 'GUILD_BUY_MARKER', playerId: 'a', value: 3 })
    expect(bought.players[0].hand[3]).toBe(2)
    expect(bought.players[0].goods.orange).toBe(0)
    s.players[0].hand[5] = 3
    const raidMarker = applyKoggeAction(s, { type: 'GUILD_RAID_MARKER', playerId: 'a', value: 5 })
    expect(raidMarker.players[0].raidMarkersInHand).toBe(2)
    expect(raidMarker.players[0].secondRaidMarkerTaken).toBe(true)

    s.guildmaster.city = (s.players[0].boatCity! + 1) % 9
    expect(validateKoggeAction(s, { type: 'GUILD_SELL_MARKER', playerId: 'a', value: 7 })).toMatch(/not in your city/)
  })

  it('trades with a city only after sailing, taking other colours', () => {
    let s = inActions()
    expect(validateKoggeAction(s, { type: 'TRADE_CITY', playerId: 'a', give: 'grey', take: ['orange', 'orange'] })).toMatch(/after sailing/)
    s = applyKoggeAction(s, { type: 'MOVE', playerId: 'a', route: 0, payments: [] })
    const city = s.cities[s.players[0].boatCity!]
    city.goods.purple = 2
    expect(validateKoggeAction(s, { type: 'TRADE_CITY', playerId: 'a', give: 'grey', take: ['grey', 'purple'] })).toMatch(/different colour/)
    const traded = applyKoggeAction(s, { type: 'TRADE_CITY', playerId: 'a', give: 'orange', take: ['purple', 'purple'] })
    expect(traded.players[0].goods.purple).toBe(2)
    expect(traded.players[0].goods.orange).toBe(0)
  })

  it('changes a route to a hidden marker', () => {
    const s = inActions()
    const cityN = s.players[0].boatCity!
    const old = s.cities[cityN].slots[1].value
    expect(validateKoggeAction(s, { type: 'CHANGE_ROUTE', playerId: 'a', slot: 1, value: cityN })).toMatch(/itself/)
    const value = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((v) => v !== cityN && s.players[0].hand[v] > 0 && v !== old)!
    const after = applyKoggeAction(s, { type: 'CHANGE_ROUTE', playerId: 'a', slot: 1, value })
    expect(after.cities[cityN].slots[1]).toEqual({ value, faceUp: false })
    expect(after.players[0].hand[old]).toBe(s.players[0].hand[old] + 1)
  })

  it('raids a boat: split, choose, forced move by the player to the left', () => {
    let s = inActions()
    s.players[1].boatCity = s.players[0].boatCity
    s.players[1].goods = { grey: 2, orange: 1, purple: 1, white: 0 }
    s = applyKoggeAction(s, { type: 'RAID', playerId: 'a', mode: 'player', targetId: 'b' })
    expect(activePlayerId(s)).toBe('b')
    expect(validateKoggeAction(s, { type: 'RAID_SPLIT', playerId: 'b', groupA: { grey: 2, orange: 1, purple: 1, white: 0 } })).toMatch(/at most one/)
    s = applyKoggeAction(s, { type: 'RAID_SPLIT', playerId: 'b', groupA: { grey: 2, orange: 0, purple: 0, white: 0 } })
    expect(activePlayerId(s)).toBe('a')
    s = applyKoggeAction(s, { type: 'RAID_TAKE', playerId: 'a', group: 'B' })
    expect(s.players[0].goods).toEqual({ grey: 2, orange: 2, purple: 1, white: 0 })
    expect(s.players[1].goods).toEqual({ grey: 2, orange: 0, purple: 0, white: 0 })
    expect(activePlayerId(s)).toBe('b') // b sits left of a
    const from = s.players[0].boatCity!
    const dest = s.cities[from].slots[0].value
    s = applyKoggeAction(s, { type: 'RAID_ROUTE', playerId: 'b', slot: 0 })
    expect(s.players[0].boatCity).toBe(dest)
    expect(s.cities[from].raids).toEqual(['a'])
    expect(s.players[0].raidMarkersInHand).toBe(0)
    expect(s.turn?.playerId).toBe('b')
  })

  it('raids a city, taking its goods and goods beside houses there', () => {
    let s = inActions()
    const cityN = s.players[0].boatCity!
    s.houses.find((h) => h.ownerId === 'a')!.goods.grey = 1
    const cityGoods = goodsTotal(s.cities[cityN].goods)
    const before = goodsTotal(s.players[0].goods)
    s = applyKoggeAction(s, { type: 'RAID', playerId: 'a', mode: 'city' })
    expect(goodsTotal(s.players[0].goods)).toBe(before + cityGoods + 1)
    expect(goodsTotal(s.cities[cityN].goods)).toBe(0)
    expect(s.pending).toEqual({ kind: 'route', attackerId: 'a', chooserId: 'b' })
    expect(victoryPoints(s, 'a').raidMarkers).toBe(0)
  })

  it('trades between players sharing a city', () => {
    const s = inActions()
    const give = { goods: { ...emptyGoods(), grey: 1 }, markers: emptyMarkers() }
    const receive = { goods: emptyGoods(), markers: emptyMarkers() }
    receive.markers[4] = 1
    expect(validateKoggeAction(s, { type: 'TRADE_PLAYERS', playerId: 'a', partnerId: 'b', give, receive })).toMatch(/not in your city/)
    s.players[1].boatCity = s.players[0].boatCity
    const after = applyKoggeAction(s, { type: 'TRADE_PLAYERS', playerId: 'a', partnerId: 'b', give, receive })
    expect(after.players[0].goods.grey).toBe(1)
    expect(after.players[1].goods.grey).toBe(3)
    expect(after.players[0].hand[4]).toBe(2)
    expect(after.players[1].hand[4]).toBe(0)
  })
})

describe('scoring and replay', () => {
  it('scores VP from houses, raid markers, bonuses and goods', () => {
    const s = inActions()
    s.players[0].goods = { grey: 1, orange: 1, purple: 1, white: 1 }
    s.players[0].bonuses = ['tripleTrade']
    s.houses.find((h) => h.ownerId === 'a')!.goods.white = 1
    expect(victoryPoints(s, 'a')).toEqual({ houses: 10, raidMarkers: 10, bonuses: 20, goods: 1 + 3 + 5 + 7 + 7, total: 63 })
  })

  it('replays the action history to the same state', () => {
    let s = inActions()
    s = run(
      s,
      { type: 'MOVE', playerId: 'a', route: 0, payments: [] },
      { type: 'END_TURN', playerId: 'a' },
      { type: 'END_TURN', playerId: 'b' },
      { type: 'END_TURN', playerId: 'c' },
    )
    expect(s.round).toBe(2)
    expect(replayKogge(s.setup, s.actionHistory)).toEqual(s)
  })

  it('plays a long random game without breaking conservation', () => {
    let s = createKoggeGame({ ...SETUP, seed: 7 })
    let rngState = 42
    const rand = (n: number) => {
      rngState = (rngState * 1103515245 + 12345) & 0x7fffffff
      return rngState % n
    }
    for (let step = 0; step < 3000 && s.phase !== 'finished'; step++) {
      const id = activePlayerId(s)!
      const p = s.players.find((pl) => pl.id === id)!
      const candidates: KoggeAction[] = []
      if (s.phase === 'startPick') candidates.push({ type: 'PICK_START', playerId: id, value: rand(9) })
      if (s.phase === 'auction') {
        const held = p.hand.flatMap((n, v) => new Array<number>(n).fill(v))
        for (const v of held) candidates.push({ type: 'BID', playerId: id, markers: [v] })
        if (held.length > 1) candidates.push({ type: 'BID', playerId: id, markers: [held[rand(held.length)], held[rand(held.length)]] })
        candidates.push({ type: 'BID', playerId: id, markers: [] })
      }
      if (s.phase === 'guildmaster') candidates.push({ type: 'MOVE_GUILDMASTER', playerId: id, steps: (1 + rand(2)) as 1 | 2 })
      if (s.phase === 'actions') {
        if (s.pending?.kind === 'split') {
          const half = emptyGoods()
          let n = Math.floor(goodsTotal(p.goods) / 2)
          for (const c of GOOD_COLORS) {
            const k = Math.min(n, p.goods[c])
            half[c] = k
            n -= k
          }
          candidates.push({ type: 'RAID_SPLIT', playerId: id, groupA: half })
        } else if (s.pending?.kind === 'choose') candidates.push({ type: 'RAID_TAKE', playerId: id, group: rand(2) ? 'A' : 'B' })
        else if (s.pending?.kind === 'route') candidates.push({ type: 'RAID_ROUTE', playerId: id, slot: rand(2) as 0 | 1 })
        else {
          candidates.push({ type: 'MOVE', playerId: id, route: rand(2) as 0 | 1, payments: s.turn!.movesMade === 0 ? [] : [{ kind: 'good', color: 'grey' }] })
          candidates.push({ type: 'BUILD_HOUSE', playerId: id })
          candidates.push({ type: 'BUY_LOT', playerId: id, lot: 0, payment: GOOD_COLORS[rand(4)] })
          candidates.push({ type: 'TRADE_CITY', playerId: id, give: GOOD_COLORS[rand(4)], take: [GOOD_COLORS[rand(4)], GOOD_COLORS[rand(4)]] })
          candidates.push({ type: 'GUILD_SELL_MARKER', playerId: id, value: rand(9) })
          candidates.push({ type: 'GUILD_BONUS', playerId: id, color: GOOD_COLORS[rand(4)], bonus: 'freeSecondMove' })
          if (rand(10) === 0) candidates.push({ type: 'RAID', playerId: id, mode: 'city' })
          candidates.push({ type: 'END_TURN', playerId: id })
        }
      }
      const legal = candidates.filter((a) => validateKoggeAction(s, a) === null)
      expect(legal.length).toBeGreaterThan(0)
      s = applyKoggeAction(s, legal[rand(legal.length)])
      expect(totalGoods(s)).toEqual(SUPPLY_COUNTS)
      expect(totalMarkers(s)).toEqual(RESERVE_COUNTS)
    }
    expect(s.phase).toBe('finished')
  })
})

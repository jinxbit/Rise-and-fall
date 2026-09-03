import { describe, expect, it } from 'vitest'
import type { AchievementContent } from '../achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../achievementContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import type { BoardGenerationContent } from '../boardGenerationContent'
import { cardIdFor, createPlayerCards, syncCardZonesWithBoard } from '../cards'
import { createNewGame, startGame } from '../createGame'
import { buildGameLog, buildGameLogFrom, extendGameLog, PLAYER_PLACEHOLDER } from '../gameLog'
import { beginSelectCardsPhase } from '../round'
import type { Card, GameState, Player, Terrain, Unit } from '../types'
import type { UnitAction, UnitContent } from '../unitContent'

function makePlayer(id: string, cards: Card[]): Player {
  return {
    id,
    authUserId: null,
    displayName: id,
    color: 'red',
    handCardIds: [],
    currentlyPlayedCardId: null,
    discardCardIds: [],
    supplyCardIds: cards.map((c) => c.id),
    declineCardIds: [],
    eliminated: false,
    resources: { gold: 0, wood: 0, stone: 0 },
  }
}

function boardOf(cells: Array<[number, number, Terrain]>) {
  let board = createEmptyBoard('hex')
  for (const [q, r, terrain] of cells) board = setTile(board, { q, r }, terrain)
  return board
}

const CITY_ACTIONS: UnitAction[] = [
  { id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: { plain: 3 } } },
  { id: 'create-nomad', name: 'Create Nomad', description: '', effect: { actionType: 'create', targetUnit: 'nomad', targetHex: { location: 'adj' }, cost: {} } },
  {
    id: 'convert-to-merchant',
    name: 'Convert to Merchant',
    description: '',
    effect: { actionType: 'convert', targetHex: { location: 'adj' }, targetOwner: 'own', targetMobileOnly: false, requiredTargetKind: 'nomad', resultUnit: 'merchant', cost: {} },
  },
]
const NOMAD_ACTIONS: UnitAction[] = [
  { id: 'produce-resource', name: 'Produce Resource', description: '', effect: { actionType: 'produce', resourceByTerrain: { forest: { wood: 2 } } } },
]

const content: UnitContent = {
  actionsByKind: { city: CITY_ACTIONS, nomad: NOMAD_ACTIONS },
  movementByKind: {
    city: { isMobile: false, terrains: [], canCrossCliffs: false },
    nomad: { isMobile: true, terrains: ['plain', 'forest'], canCrossCliffs: false, moveDistance: 1 },
    merchant: { isMobile: true, terrains: ['plain', 'forest', 'water'], canCrossCliffs: false, moveDistance: 4 },
  },
  terrainLevels: { water: 0, plain: 1, forest: 2, mountain: 3, glacier: 4 },
  resourceCaps: { gold: null, wood: null, stone: null },
  unitSupplyCaps: { city: 2 },
  companionKindsByCardKind: {},
  activationsPerTurnByKind: {},
}

const achievementContent: AchievementContent = {
  ...EMPTY_ACHIEVEMENT_CONTENT,
  unitKindByAchievementId: { 'city-mastery': 'city' },
}

function makeGenesis(units: Unit[], board: GameState['board']): GameState {
  const p1Cards = createPlayerCards('p1')
  const p2Cards = createPlayerCards('p2')
  const cards: Record<string, Card> = {}
  for (const c of [...p1Cards, ...p2Cards]) cards[c.id] = c
  const lobby = createNewGame({
    gameId: 'g',
    playMode: 'hotseat',
    board,
    players: [
      { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
    ],
    resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
  })
  // Most callers only give p1 any units, leaving p2 with an empty hand —
  // beginSelectCardsPhase would eliminate them for that, and since
  // eliminatePlayer now ends the game outright once only one player
  // remains (elimination.ts), that would complete the game before this
  // genesis is even returned. So p2 is excluded up front (not in
  // turnOrder, marked eliminated) unless the caller actually gave them a
  // unit.
  const p2HasAUnit = units.some((u) => u.ownerId === 'p2')
  const active: GameState = {
    ...lobby,
    board,
    players: [makePlayer('p1', p1Cards), { ...makePlayer('p2', p2Cards), eliminated: !p2HasAUnit }],
    cards,
    turnOrder: p2HasAUnit ? ['p1', 'p2'] : ['p1'],
    units,
    status: 'active',
  }
  return beginSelectCardsPhase(syncCardZonesWithBoard(active))
}

/** Drives `actions` through applyAction in order, throwing with the failing action's index/error if any is rejected. */
function drive(state: GameState, actions: Parameters<typeof applyAction>[1][]): GameState {
  let next = state
  for (const [i, action] of actions.entries()) {
    const result = applyAction(next, action, content, achievementContent)
    if (!result.ok) throw new Error(`action ${i} (${action.type}) failed: ${result.error}`)
    next = result.state
  }
  return next
}

function messages(events: ReturnType<typeof buildGameLog>): string[] {
  return events.map((e) => e.message)
}

describe('buildGameLog', () => {
  it('names the played card', () => {
    const board = boardOf([[0, 0, 'plain']])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const genesis = makeGenesis([city], board)
    const state = drive(genesis, [{ type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }])

    const log = buildGameLog(genesis, state.actionHistory, content, achievementContent)
    expect(messages(log)).toContainEqual(expect.stringContaining(`${PLAYER_PLACEHOLDER} chose to play city`))
    expect(log.find((e) => e.message.includes('chose to play city'))?.playerId).toBe('p1')
  })

  it('reports the actual resource amount a resolved action produced, not just its name', () => {
    const board = boardOf([[0, 0, 'plain']])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const genesis = makeGenesis([city], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
    ])

    const log = buildGameLog(genesis, state.actionHistory, content, achievementContent)
    const entry = messages(log).find((m) => m.includes('Generate Income'))
    expect(entry).toContain('+3 gold')
  })

  it("notes when resolving was that unit kind's last acting unit, ending the turn", () => {
    // p2 needs a real unit of their own too — otherwise they're
    // auto-eliminated at genesis (no card to choose), pendingPlayerIds
    // never advances to them, and p1's turn ending would immediately
    // close the round instead (a different, separately-tested case: see
    // "logs 'Round N begins'" below).
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const otherNomad: Unit = { id: 'nomad_p2', ownerId: 'p2', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([city, otherNomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'nomad') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
    ])
    expect(state.turn).toBe(0)
    expect(state.pendingPlayerIds[0]).toBe('p2')

    const log = buildGameLog(genesis, state.actionHistory, content, achievementContent)
    expect(messages(log)).toContainEqual(expect.stringContaining('finished acting — turn ends'))
  })

  it('logs a retracted choice without naming the card that was chosen', () => {
    // p2 needs a real unit of their own too, same as the "finished acting"
    // case above — otherwise they're auto-eliminated at genesis and p1's
    // lone CHOOSE_CARD immediately resolves the phase, leaving nothing to
    // retract from.
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const otherNomad: Unit = { id: 'nomad_p2', ownerId: 'p2', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([city, otherNomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'RETRACT_CHOICE', playerId: 'p1' },
    ])

    const log = buildGameLog(genesis, state.actionHistory, content, achievementContent)
    expect(messages(log)).toContainEqual(expect.stringContaining('retracted their card choice'))
  })

  it('logs an explicit pass', () => {
    const board = boardOf([[0, 0, 'plain']])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const nomad: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 0, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([city, nomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'PASS_ACTIONS', playerId: 'p1' },
    ])

    const log = buildGameLog(genesis, state.actionHistory, content, achievementContent)
    expect(messages(log)).toContainEqual(`${PLAYER_PLACEHOLDER} passed on resolving further actions`)
    expect(log.find((e) => e.message.includes('passed on resolving'))?.playerId).toBe('p1')
  })

  it('logs a newly claimed achievement', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const cityA: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const cityB: Unit = { id: 'city_b', ownerId: 'p1', kind: 'city', coord: { q: 1, r: 0 }, movement: content.movementByKind.city, traits: [] }
    // Both Cities already on the board means creating one more Nomad has no
    // bearing on the city-mastery cap — instead just start with the cap
    // already met by having 2 Cities and unitSupplyCaps.city = 2, so the
    // very first RESOLVE_UNIT_ACTION triggers the claim check.
    const genesis = makeGenesis([cityA, cityB], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
    ])

    const log = buildGameLog(genesis, state.actionHistory, content, achievementContent)
    expect(messages(log)).toContainEqual(expect.stringContaining('claimed the city mastery achievement'))
  })

  it('logs "Round N begins" once the round cycles', () => {
    const board = boardOf([[0, 0, 'plain']])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const genesis = makeGenesis([city], board)
    expect(genesis.players.find((p) => p.id === 'p2')?.eliminated).toBe(true)

    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
    ])
    expect(state.turn).toBe(1)

    const log = buildGameLog(genesis, state.actionHistory, content, achievementContent)
    expect(messages(log)).toContainEqual('Round 1 begins')
  })

  it('logs a concede as "conceded", not also the auto-elimination cascade\'s misleading "was eliminated" line', () => {
    // Three players (each with their own unit, so nobody is auto-eliminated
    // at genesis) so that p1 conceding leaves two players active rather than
    // ending the game outright (eliminatePlayer's last-player-standing check
    // in ./elimination.ts).
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
      [2, 0, 'plain'],
    ])
    const p1Cards = createPlayerCards('p1')
    const p2Cards = createPlayerCards('p2')
    const p3Cards = createPlayerCards('p3')
    const cards: Record<string, Card> = {}
    for (const c of [...p1Cards, ...p2Cards, ...p3Cards]) cards[c.id] = c
    const lobby = createNewGame({
      gameId: 'g3',
      playMode: 'hotseat',
      board,
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
        { id: 'p3', authUserId: null, displayName: 'Cleo', color: 'green' },
      ],
      resourceBank: { gold: 1000, wood: 1000, stone: 1000 },
    })
    const units: Unit[] = [
      { id: 'city_p1', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] },
      { id: 'city_p2', ownerId: 'p2', kind: 'city', coord: { q: 1, r: 0 }, movement: content.movementByKind.city, traits: [] },
      { id: 'city_p3', ownerId: 'p3', kind: 'city', coord: { q: 2, r: 0 }, movement: content.movementByKind.city, traits: [] },
    ]
    const active: GameState = {
      ...lobby,
      board,
      players: [makePlayer('p1', p1Cards), makePlayer('p2', p2Cards), makePlayer('p3', p3Cards)],
      cards,
      turnOrder: ['p1', 'p2', 'p3'],
      units,
      status: 'active',
    }
    const genesis = beginSelectCardsPhase(syncCardZonesWithBoard(active))

    const state = drive(genesis, [{ type: 'CONCEDE', playerId: 'p1' }])
    expect(state.players.find((p) => p.id === 'p1')?.conceded).toBe(true)

    const log = buildGameLog(genesis, state.actionHistory, content, achievementContent)
    expect(messages(log)).toContainEqual(`${PLAYER_PLACEHOLDER} conceded`)
    expect(log.find((e) => e.message.includes('conceded'))?.playerId).toBe('p1')
    expect(messages(log)).not.toContainEqual(expect.stringContaining('was eliminated'))
  })

  it('logs a card zone change caused by converting a different unit than the one acting', () => {
    // p1 plays their City (not their Nomad) this turn, and the City
    // converts the adjacent Nomad into a Merchant. Since it's the City's
    // card being discarded at turn-end, not the Nomad's, the Nomad card's
    // hand -> supply resync (it has no units left) and the Merchant card's
    // supply -> hand resync (it has one now) both survive to the final
    // state, unlike a card that's converted back and forth within the same
    // dispatch its own turn would produce.
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'plain'],
    ])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const nomad: Unit = { id: 'nomad_a', ownerId: 'p1', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([city, nomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'convert-to-merchant', target: { q: 1, r: 0 } }] },
    ])

    const log = buildGameLog(genesis, state.actionHistory, content, achievementContent)
    expect(messages(log)).toContainEqual(expect.stringContaining("nomad card returned to supply"))
    expect(messages(log)).toContainEqual(expect.stringContaining("merchant card entered their hand"))
  })

  it('prefixes a "Board setup begins" line when genesis starts in boardSetup', () => {
    const boardGenerationContent: BoardGenerationContent = {
      startingWaterShapeCells: [{ q: 0, r: 0 }],
      tiers: [{ terrain: 'plain', shapeCells: [{ q: 0, r: 0 }], placesOn: ['water'], poolSize: 1 }],
    }
    const lobby = createNewGame({
      gameId: 'g2',
      playMode: 'hotseat',
      board: createEmptyBoard('hex'),
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
      ],
      resourceBank: { gold: 100, wood: 100, stone: 100 },
    })
    const genesis = startGame(lobby, boardGenerationContent)

    const log = buildGameLog(genesis, [], content, achievementContent, boardGenerationContent)
    expect(messages(log)).toEqual(['Board setup begins'])
  })

  it('names the placed tile terrain', () => {
    const boardGenerationContent: BoardGenerationContent = {
      startingWaterShapeCells: [{ q: 0, r: 0 }],
      tiers: [{ terrain: 'plain', shapeCells: [{ q: 0, r: 0 }], placesOn: ['water'], poolSize: 1 }],
    }
    const lobby = createNewGame({
      gameId: 'g3',
      playMode: 'hotseat',
      board: createEmptyBoard('hex'),
      players: [
        { id: 'p1', authUserId: null, displayName: 'Alice', color: 'red' },
        { id: 'p2', authUserId: null, displayName: 'Bob', color: 'blue' },
      ],
      resourceBank: { gold: 100, wood: 100, stone: 100 },
    })
    const genesis = startGame(lobby, boardGenerationContent)
    const step = applyAction(genesis, { type: 'PLACE_TILE', playerId: 'p1', anchor: { q: 0, r: 0 }, rotationSteps: 0 }, content, achievementContent, boardGenerationContent)
    if (!step.ok) throw new Error(step.error)

    const log = buildGameLog(genesis, step.state.actionHistory, content, achievementContent, boardGenerationContent)
    expect(messages(log)).toContainEqual(`${PLAYER_PLACEHOLDER} placed a plain tile`)
    expect(log.find((e) => e.message.includes('placed a plain tile'))?.playerId).toBe('p1')
  })
})

describe('extendGameLog / buildGameLogFrom', () => {
  // GamePage.tsx caches a previous buildGameLogFrom/extendGameLog result and
  // extends it with only the newly-appended actions each time actionHistory
  // grows, instead of replaying the entire history from genesis again (see
  // GamePage.tsx's gameLog memo) — that's only correct if picking up
  // mid-stream via extendGameLog produces *exactly* the same events (same
  // ids included, so React keys stay stable) as computing the whole thing
  // in one buildGameLog/buildGameLogFrom call. This exercises that
  // equivalence directly across a several-actions-long game, split at every
  // possible point.
  it('produces identical events (including ids) whether built in one call or resumed partway through via extendGameLog', () => {
    const board = boardOf([
      [0, 0, 'plain'],
      [1, 0, 'forest'],
    ])
    const city: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: content.movementByKind.city, traits: [] }
    const otherNomad: Unit = { id: 'nomad_p2', ownerId: 'p2', kind: 'nomad', coord: { q: 1, r: 0 }, movement: content.movementByKind.nomad, traits: [] }
    const genesis = makeGenesis([city, otherNomad], board)
    const state = drive(genesis, [
      { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') },
      { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'nomad') },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] },
      { type: 'RESOLVE_UNIT_ACTION', playerId: 'p2', unitActions: [{ unitId: 'nomad_p2', actionId: 'produce-resource' }] },
    ])

    const fullLog = buildGameLog(genesis, state.actionHistory, content, achievementContent)

    for (let splitAt = 0; splitAt <= state.actionHistory.length; splitAt++) {
      const firstHalf = buildGameLogFrom(genesis, state.actionHistory.slice(0, splitAt), content, achievementContent)
      const extended = extendGameLog(firstHalf.state, state.actionHistory.slice(splitAt), firstHalf.events.length + 1, content, achievementContent)
      const resumedLog = [...firstHalf.events, ...extended.events]
      expect(resumedLog).toEqual(fullLog)
    }
  })
})

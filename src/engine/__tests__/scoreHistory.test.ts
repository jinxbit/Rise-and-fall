import { describe, expect, it } from 'vitest'
import type { AchievementContent } from '../achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../achievementContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard, setTile } from '../board'
import { cardIdFor, moveCard, UNIT_KINDS } from '../cards'
import { createNewGame } from '../createGame'
import { calculateScoreHistory } from '../scoreHistory'
import type { GameState, Unit } from '../types'
import type { UnitAction, UnitContent } from '../unitContent'

// A City with a real income action, so PASS_ACTIONS-only rounds still move
// gold — matching round.test.ts's filler-content convention (these tests
// are about the resulting score series, not about resolving actions).
const testUnitContent: UnitContent = {
  actionsByKind: {},
  movementByKind: {},
  terrainLevels: {},
  resourceCaps: {},
  unitSupplyCaps: {},
  companionKindsByCardKind: {},
  activationsPerTurnByKind: {},
}

const achievementContent: AchievementContent = { ...EMPTY_ACHIEVEMENT_CONTENT, goldPerVictoryPoint: 1 }

/** Same shape as round.test.ts's makeActiveGameWithFullHands, minimal for this file's own needs. */
function makeActiveGame(): GameState {
  const state = createNewGame({
    gameId: 'game_1',
    playMode: 'hotseat',
    board: createEmptyBoard('hex'),
    players: [
      { id: 'p1', authUserId: 'auth_1', displayName: 'Alice', color: 'red' },
      { id: 'p2', authUserId: 'auth_2', displayName: 'Bob', color: 'blue' },
    ],
  })

  const players = state.players.map((player) => {
    let next = player
    for (const cardId of player.supplyCardIds) next = moveCard(next, cardId, 'hand')
    return next
  })

  const units: Unit[] = state.players.flatMap((player, playerIndex) =>
    UNIT_KINDS.filter((kind) => kind !== 'city').map((kind, kindIndex) => ({
      id: `${player.id}_seed_${kind}`,
      ownerId: player.id,
      kind,
      coord: { q: 100 + kindIndex, r: 100 + playerIndex },
      movement: { isMobile: false, terrains: [], canCrossCliffs: false },
      traits: [],
    })),
  )

  return { ...state, status: 'active', players, units }
}

function playOutRound(state: GameState, kind: string): GameState {
  let result = applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', kind) }, testUnitContent, achievementContent)
  if (!result.ok) throw new Error(result.error)
  result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', kind) }, testUnitContent, achievementContent)
  if (!result.ok) throw new Error(result.error)
  result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' }, testUnitContent, achievementContent)
  if (!result.ok) throw new Error(result.error)
  result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' }, testUnitContent, achievementContent)
  if (!result.ok) throw new Error(result.error)
  return result.state
}

describe('calculateScoreHistory', () => {
  it('takes one snapshot at genesis, plus one per round boundary, tracking each player total VP', () => {
    const genesis = makeActiveGame()
    expect(genesis.turn).toBe(0)

    const afterRound1 = playOutRound(genesis, 'city')
    expect(afterRound1.turn).toBe(1)
    const afterRound2 = playOutRound(afterRound1, 'temple')
    expect(afterRound2.turn).toBe(2)

    const { snapshots } = calculateScoreHistory(genesis, afterRound2.actionHistory, testUnitContent, achievementContent)

    expect(snapshots.map((snapshot) => snapshot.turn)).toEqual([0, 1, 2])
    // No gold-producing action content in this test, so totals stay 0 at every round — the point here is the number and ordering of snapshots, not nonzero scoring (that's victoryPoints.test.ts's job).
    for (const snapshot of snapshots) {
      expect(snapshot.totalByPlayerId).toEqual({ p1: 0, p2: 0 })
    }
  })

  it('captures a final snapshot even when the replay ends mid-round (no trailing round-boundary snapshot to rely on)', () => {
    const genesis = makeActiveGame()
    let result = applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    const midRound = result.state
    expect(midRound.turn).toBe(0)

    const { snapshots } = calculateScoreHistory(genesis, midRound.actionHistory, testUnitContent, achievementContent)

    // genesis (turn 0) + the mid-round final state (also turn 0, since the round hasn't finished) = 2 snapshots, not deduplicated away.
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0].turn).toBe(0)
    expect(snapshots[1].turn).toBe(0)
  })

  it('returns just the genesis snapshot for an empty action history', () => {
    const genesis = makeActiveGame()
    const { snapshots } = calculateScoreHistory(genesis, [], testUnitContent, achievementContent)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].turn).toBe(0)
  })

  it('returns no achievement claims when none were claimed during the replay', () => {
    const genesis = makeActiveGame()
    const afterRound1 = playOutRound(genesis, 'city')

    const { achievementClaims } = calculateScoreHistory(genesis, afterRound1.actionHistory, testUnitContent, achievementContent)
    expect(achievementClaims).toEqual([])
  })

  it('records the round and claiming player of each achievement claimed mid-replay', () => {
    const cityActions: UnitAction[] = [{ id: 'generate-income', name: 'Generate Income', description: '', effect: { actionType: 'income', goldByTerrain: { plain: 3 } } }]
    const contentWithActions: UnitContent = { ...testUnitContent, actionsByKind: { city: cityActions }, unitSupplyCaps: { city: 2 } }
    const claimAchievementContent: AchievementContent = { ...achievementContent, unitKindByAchievementId: { 'city-mastery': 'city' } }

    let board = createEmptyBoard('hex')
    board = setTile(board, { q: 0, r: 0 }, 'plain')
    board = setTile(board, { q: 1, r: 0 }, 'plain')
    const cityA: Unit = { id: 'city_a', ownerId: 'p1', kind: 'city', coord: { q: 0, r: 0 }, movement: { isMobile: false, terrains: [], canCrossCliffs: false }, traits: [] }
    const cityB: Unit = { id: 'city_b', ownerId: 'p1', kind: 'city', coord: { q: 1, r: 0 }, movement: { isMobile: false, terrains: [], canCrossCliffs: false }, traits: [] }
    const genesis = { ...makeActiveGame(), board, units: [cityA, cityB], resourceBank: { gold: 100, wood: 100, stone: 100 } }

    let result = applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, contentWithActions, claimAchievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }, contentWithActions, claimAchievementContent)
    if (!result.ok) throw new Error(result.error)
    // Both Cities already meet unitSupplyCaps.city (2), so resolving any city action triggers the claim check.
    result = applyAction(result.state, { type: 'RESOLVE_UNIT_ACTION', playerId: 'p1', unitActions: [{ unitId: 'city_a', actionId: 'generate-income' }] }, contentWithActions, claimAchievementContent)
    if (!result.ok) throw new Error(result.error)
    expect(result.state.claimedByAchievementId['city-mastery']).toBe('p1')
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p1' }, contentWithActions, claimAchievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'PASS_ACTIONS', playerId: 'p2' }, contentWithActions, claimAchievementContent)
    if (!result.ok) throw new Error(result.error)
    // Claiming an achievement mid-round triggers the decline phase (see isDeclineTriggered, ./decline.ts) — each player owes one card before the round can finish.
    expect(result.state.roundPhase).toBe('decline')
    result = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, contentWithActions, claimAchievementContent)
    if (!result.ok) throw new Error(result.error)
    result = applyAction(result.state, { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }, contentWithActions, claimAchievementContent)
    if (!result.ok) throw new Error(result.error)
    // Whoever still owes a purchase decision (gold to afford the buyback, per skipEmptyDeclinePurchasers) passes it, to reach the round boundary.
    while (result.state.roundPhase === 'purchase' && result.state.pendingPlayerIds.length > 0) {
      result = applyAction(result.state, { type: 'PASS_PURCHASE', playerId: result.state.pendingPlayerIds[0] }, contentWithActions, claimAchievementContent)
      if (!result.ok) throw new Error(result.error)
    }
    const finalState = result.state
    expect(finalState.turn).toBe(1)

    const { achievementClaims } = calculateScoreHistory(genesis, finalState.actionHistory, contentWithActions, claimAchievementContent)
    expect(achievementClaims).toEqual([{ turn: 0, achievementId: 'city-mastery', playerId: 'p1' }])
  })
})

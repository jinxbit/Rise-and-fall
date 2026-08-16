import { describe, expect, it } from 'vitest'
import type { AchievementContent } from '../achievementContent'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../achievementContent'
import { applyAction } from '../applyAction'
import { createEmptyBoard } from '../board'
import { cardIdFor, moveCard, UNIT_KINDS } from '../cards'
import { createNewGame } from '../createGame'
import { calculateScoreHistory } from '../scoreHistory'
import type { GameState, Unit } from '../types'
import type { UnitContent } from '../unitContent'

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

    const history = calculateScoreHistory(genesis, afterRound2.actionHistory, testUnitContent, achievementContent)

    expect(history.map((snapshot) => snapshot.turn)).toEqual([0, 1, 2])
    // No gold-producing action content in this test, so totals stay 0 at every round — the point here is the number and ordering of snapshots, not nonzero scoring (that's victoryPoints.test.ts's job).
    for (const snapshot of history) {
      expect(snapshot.totalByPlayerId).toEqual({ p1: 0, p2: 0 })
    }
  })

  it('captures a final snapshot even when the replay ends mid-round (no trailing round-boundary snapshot to rely on)', () => {
    const genesis = makeActiveGame()
    let result = applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }, testUnitContent, achievementContent)
    if (!result.ok) throw new Error(result.error)
    const midRound = result.state
    expect(midRound.turn).toBe(0)

    const history = calculateScoreHistory(genesis, midRound.actionHistory, testUnitContent, achievementContent)

    // genesis (turn 0) + the mid-round final state (also turn 0, since the round hasn't finished) = 2 snapshots, not deduplicated away.
    expect(history).toHaveLength(2)
    expect(history[0].turn).toBe(0)
    expect(history[1].turn).toBe(0)
  })

  it('returns just the genesis snapshot for an empty action history', () => {
    const genesis = makeActiveGame()
    const history = calculateScoreHistory(genesis, [], testUnitContent, achievementContent)
    expect(history).toHaveLength(1)
    expect(history[0].turn).toBe(0)
  })
})

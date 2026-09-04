import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard } from '../board'
import { cardIdFor, moveCard, UNIT_KINDS } from '../cards'
import { createNewGame } from '../createGame'
import { buildGameLog, PLAYER_PLACEHOLDER } from '../gameLog'
import { applyActionAtPointer } from '../historyPointer'
import { redactGameLog, redactStateForPlayer, redactStateForPlayerAtPointer } from '../redaction'
import type { GameState, Unit } from '../types'

/**
 * Same shape as round.test.ts's own fixture of the same name — an active
 * game with p1/p2 each holding their full six-card hand, so CHOOSE_CARD/
 * MOVE_TO_DECLINE can be driven directly through applyAction without first
 * running board setup.
 */
function makeActiveGameWithFullHands(): GameState {
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
    for (const cardId of player.supplyCardIds) {
      next = moveCard(next, cardId, 'hand')
    }
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

function requireOk(result: ReturnType<typeof applyAction>): GameState {
  if (!result.ok) throw new Error(`setup failed: ${result.error}`)
  return result.state
}

describe('redactStateForPlayer', () => {
  describe('selectCards phase', () => {
    it('shows nobody has chosen yet to every viewer before anyone picks', () => {
      const state = makeActiveGameWithFullHands()

      for (const viewerId of ['p1', 'p2']) {
        const redacted = redactStateForPlayer(state, viewerId)
        expect(redacted.chosenCardIdByPlayerId.p1).toEqual({ chosen: false })
        expect(redacted.chosenCardIdByPlayerId.p2).toEqual({ chosen: false })
      }
    })

    it("hides another player's in-progress pick while they're still pending, but shows the viewer their own", () => {
      const base = makeActiveGameWithFullHands()
      const state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
      expect(state.roundPhase).toBe('selectCards')
      expect(state.pendingPlayerIds).toEqual(['p2'])

      const asP2 = redactStateForPlayer(state, 'p2')
      expect(asP2.chosenCardIdByPlayerId.p1).toEqual({ chosen: true, cardId: null })
      expect(asP2.chosenCardIdByPlayerId.p2).toEqual({ chosen: false })

      const asP1 = redactStateForPlayer(state, 'p1')
      expect(asP1.chosenCardIdByPlayerId.p1).toEqual({ chosen: true, cardId: cardIdFor('p1', 'city') })

      // A non-seated viewer (e.g. an observer) gets the same treatment as
      // any player who isn't p1.
      const asObserver = redactStateForPlayer(state, 'nobody')
      expect(asObserver.chosenCardIdByPlayerId.p1).toEqual({ chosen: true, cardId: null })
    })

    it('reveals both picks to everyone once the phase resolves and moves on', () => {
      const base = makeActiveGameWithFullHands()
      let state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
      state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
      expect(state.roundPhase).toBe('actions')

      const asP2 = redactStateForPlayer(state, 'p2')
      expect(asP2.chosenCardIdByPlayerId.p1).toEqual({ chosen: true, cardId: cardIdFor('p1', 'city') })
      expect(asP2.chosenCardIdByPlayerId.p2).toEqual({ chosen: true, cardId: cardIdFor('p2', 'city') })
    })
  })

  describe('decline phase', () => {
    function reachDeclinePhase(achievementsClaimedThisRound: number): GameState {
      const base = { ...makeActiveGameWithFullHands(), achievementsClaimedThisRound }
      let state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
      state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
      state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p1' }))
      state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p2' }))
      expect(state.roundPhase).toBe('decline')
      return state
    }

    it("hides another player's this-phase decline addition, but shows it to that player and to anyone once resolved", () => {
      let state = reachDeclinePhase(1)
      const p1Temple = cardIdFor('p1', 'temple')
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Temple }))
      expect(state.roundPhase).toBe('decline')
      expect(state.pendingPlayerIds).toEqual(['p2'])

      const p1Real = state.players.find((p) => p.id === 'p1')!.declineCardIds
      expect(p1Real).toEqual([p1Temple])

      const asP2 = redactStateForPlayer(state, 'p2')
      const p1AsSeenByP2 = asP2.players.find((p) => p.id === 'p1')!.declineCardIds
      // Same length as the real array — the fact a card was moved isn't
      // secret, only which one.
      expect(p1AsSeenByP2).toEqual([null])

      const asP1 = redactStateForPlayer(state, 'p1')
      expect(asP1.players.find((p) => p.id === 'p1')!.declineCardIds).toEqual([p1Temple])

      // Once the whole phase resolves, it's public to everyone.
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }))
      expect(state.roundPhase).toBe('purchase')
      const resolvedAsP2 = redactStateForPlayer(state, 'p2')
      expect(resolvedAsP2.players.find((p) => p.id === 'p1')!.declineCardIds).toEqual([p1Temple])
    })

    it("keeps an earlier round's already-public decline pile visible during a later, still-in-progress decline phase", () => {
      let state = reachDeclinePhase(1)
      const oldCardId = cardIdFor('p1', 'nomad')
      const newCardId = cardIdFor('p1', 'temple')

      // Simulate a card already sitting in p1's decline pile from a
      // previously-resolved round: present on the player, but logged
      // against an earlier turn than the round currently in progress.
      const p1Index = state.players.findIndex((p) => p.id === 'p1')
      const p1WithOldCard = moveCard(state.players[p1Index], oldCardId, 'decline')
      const players = [...state.players]
      players[p1Index] = p1WithOldCard
      state = {
        ...state,
        players,
        actionHistory: [
          { action: { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: oldCardId }, turn: state.turn - 1, timestamp: 'earlier' },
          ...state.actionHistory,
        ],
      }

      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: newCardId }))
      expect(state.roundPhase).toBe('decline')

      const asP2 = redactStateForPlayer(state, 'p2')
      const p1AsSeenByP2 = asP2.players.find((p) => p.id === 'p1')!.declineCardIds
      expect(p1AsSeenByP2).toEqual([oldCardId, null])
    })

    it('keeps masking a multi-card decline addition until every owed card has been supplied and the phase resolves', () => {
      let state = reachDeclinePhase(2)
      const p1Cards = [cardIdFor('p1', 'temple'), cardIdFor('p1', 'nomad')]
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Cards[0] }))
      // p1 still owes a second card this phase.
      expect(state.pendingPlayerIds).toContain('p1')

      let asP2 = redactStateForPlayer(state, 'p2')
      expect(asP2.players.find((p) => p.id === 'p1')!.declineCardIds).toEqual([null])

      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Cards[1] }))
      asP2 = redactStateForPlayer(state, 'p2')
      expect(asP2.players.find((p) => p.id === 'p1')!.declineCardIds).toEqual([null, null])
    })
  })

  describe('passthrough', () => {
    it('leaves hands, board, resources and everything else unchanged for any viewer', () => {
      const state = makeActiveGameWithFullHands()
      const redacted = redactStateForPlayer(state, 'p2')

      expect(redacted.board).toBe(state.board)
      expect(redacted.resourceBank).toEqual(state.resourceBank)
      const p1 = redacted.players.find((p) => p.id === 'p1')!
      const originalP1 = state.players.find((p) => p.id === 'p1')!
      expect(p1.handCardIds).toEqual(originalP1.handCardIds)
      expect(p1.discardCardIds).toEqual(originalP1.discardCardIds)
      expect(p1.resources).toEqual(originalP1.resources)
    })

    it('does not mask decline piles outside the decline phase', () => {
      let state = makeActiveGameWithFullHands()
      const p1Index = state.players.findIndex((p) => p.id === 'p1')
      const p1WithDecline = moveCard(state.players[p1Index], cardIdFor('p1', 'nomad'), 'decline')
      const players = [...state.players]
      players[p1Index] = p1WithDecline
      state = { ...state, players }

      const asP2 = redactStateForPlayer(state, 'p2')
      expect(asP2.players.find((p) => p.id === 'p1')!.declineCardIds).toEqual([cardIdFor('p1', 'nomad')])
    })
  })
})

describe('redactStateForPlayerAtPointer (§5.3 reveal high-water mark)', () => {
  it('does not re-mask a resolved selectCards phase on a review-only rewind back into it (no flicker)', () => {
    const genesis = makeActiveGameWithFullHands()
    const afterP1 = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const tip = requireOk(applyAction(afterP1, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
    expect(tip.roundPhase).toBe('actions')

    // Rewind the pointer to right after p1's own pick (mid-phase, as
    // originally recorded) — a plain review, no branch.
    const reviewed = redactStateForPlayerAtPointer(genesis, tip.actionHistory, 1, 'p2')
    expect(reviewed.roundPhase).toBe('selectCards')
    expect(reviewed.pendingPlayerIds).toEqual(['p2'])
    // Without the reveal mark, p1's already-seen pick would mask back to
    // null here — the whole point of §5.3.
    expect(reviewed.chosenCardIdByPlayerId.p1).toEqual({ chosen: true, cardId: cardIdFor('p1', 'city') })
  })

  it('masks normally when the phase never actually resolved on the tip', () => {
    const genesis = makeActiveGameWithFullHands()
    const afterP1 = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    expect(afterP1.roundPhase).toBe('selectCards')

    const asP2 = redactStateForPlayerAtPointer(genesis, afterP1.actionHistory, afterP1.actionHistory.length, 'p2')
    expect(asP2.chosenCardIdByPlayerId.p1).toEqual({ chosen: true, cardId: null })
  })

  it('re-masks after a branch prunes the entry that had resolved the phase', () => {
    const genesis = makeActiveGameWithFullHands()
    const afterP1 = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const tip = requireOk(applyAction(afterP1, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
    expect(tip.roundPhase).toBe('actions')

    // p1 rewinds all the way to genesis and re-picks their own card,
    // discarding p2's real (revealing) pick — p2 is pending again for real.
    const { result } = applyActionAtPointer(genesis, tip.actionHistory, 0, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') })
    if (!result.ok) throw new Error('setup failed')
    expect(result.state.roundPhase).toBe('selectCards')

    const asP2 = redactStateForPlayerAtPointer(genesis, result.state.actionHistory, result.state.actionHistory.length, 'p2')
    expect(asP2.chosenCardIdByPlayerId.p1).toEqual({ chosen: true, cardId: null })
  })

  it('does not re-mask a resolved decline phase on a review-only rewind back into it', () => {
    const base = makeActiveGameWithFullHands()
    const genesis = { ...base, achievementsClaimedThisRound: 1 }
    let state = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
    state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p1' }))
    state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p2' }))
    expect(state.roundPhase).toBe('decline')
    const p1Temple = cardIdFor('p1', 'temple')
    state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Temple }))
    const pointerAfterP1 = state.actionHistory.length
    const p2Temple = cardIdFor('p2', 'temple')
    const tip = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: p2Temple }))
    expect(tip.roundPhase).toBe('purchase')

    // Review-only rewind to right after p1's own decline addition but
    // before p2's (the moment that resolved the phase) — still within the
    // same, unpruned history.
    const reviewed = redactStateForPlayerAtPointer(genesis, tip.actionHistory, pointerAfterP1, 'p2')
    expect(reviewed.roundPhase).toBe('decline')
    // Without the reveal mark, this would still read as masked ([null]) —
    // the whole point of §5.3.
    const p1AsSeenByP2 = reviewed.players.find((p) => p.id === 'p1')!.declineCardIds
    expect(p1AsSeenByP2).toEqual([p1Temple])
  })
})

describe('redactGameLog (issue #399)', () => {
  it("hides another player's chosen card name while they're still pending, but shows the viewer their own choice", () => {
    const genesis = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    expect(state.roundPhase).toBe('selectCards')
    expect(state.pendingPlayerIds).toEqual(['p2'])
    const log = buildGameLog(genesis, state.actionHistory)

    const asP2 = redactGameLog(log, state, 'p2')
    const p1Entry = asP2.find((e) => e.playerId === 'p1' && e.message.includes('chose'))!
    expect(p1Entry.message).toBe(`${PLAYER_PLACEHOLDER} chose a card`)

    const asP1 = redactGameLog(log, state, 'p1')
    const ownEntry = asP1.find((e) => e.playerId === 'p1' && e.message.includes('chose'))!
    expect(ownEntry.message).toBe(`${PLAYER_PLACEHOLDER} chose to play city`)

    // An unseated observer gets the same treatment as any player who isn't p1.
    const asObserver = redactGameLog(log, state, null)
    expect(asObserver.find((e) => e.playerId === 'p1' && e.message.includes('chose'))!.message).toBe(`${PLAYER_PLACEHOLDER} chose a card`)
  })

  it('reveals both picks to every viewer once the selectCards phase resolves and moves on', () => {
    const genesis = makeActiveGameWithFullHands()
    let state = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
    expect(state.roundPhase).toBe('actions')
    const log = buildGameLog(genesis, state.actionHistory)

    const asP2 = redactGameLog(log, state, 'p2')
    expect(asP2.find((e) => e.playerId === 'p1' && e.message.includes('chose'))!.message).toBe(`${PLAYER_PLACEHOLDER} chose to play city`)
  })

  it("keeps an earlier round's resolved pick revealed even while a later round's selectCards phase is back in progress", () => {
    const genesis = makeActiveGameWithFullHands()
    let state = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
    const firstRoundTurn = state.turn

    // Simulate a later round back in its own still-in-progress selectCards
    // window, without needing to fully replay an entire round of unit
    // actions/purchases to get there for real.
    const actionHistory = state.actionHistory
    state = { ...state, turn: firstRoundTurn + 1, roundPhase: 'selectCards', pendingPlayerIds: ['p2'] }
    const log = buildGameLog(genesis, actionHistory)

    const asP2 = redactGameLog(log, state, 'p2')
    // The earlier, already-resolved round's CHOOSE_CARD line is unaffected
    // by the new round's in-progress phase — only an event logged against
    // *this* round's turn number would be masked.
    expect(asP2.find((e) => e.playerId === 'p1' && e.message.includes('chose'))!.message).toBe(`${PLAYER_PLACEHOLDER} chose to play city`)
  })

  it('passes through every non-secret event (playerId mismatch or no secret at all) unchanged', () => {
    const genesis = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const log = buildGameLog(genesis, state.actionHistory)

    const redacted = redactGameLog(log, state, 'p2')
    const nonChooseEvents = log.filter((e) => !e.secret)
    for (const event of nonChooseEvents) {
      expect(redacted.find((e) => e.id === event.id)).toEqual(event)
    }
  })
})

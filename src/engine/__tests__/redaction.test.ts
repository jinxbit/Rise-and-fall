import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { createEmptyBoard } from '../board'
import { cardIdFor, moveCard, UNIT_KINDS } from '../cards'
import { createNewGame } from '../createGame'
import { buildGameLog, PLAYER_PLACEHOLDER } from '../gameLog'
import { resolveHistory } from '../historyFold'
import { redactGameLog, redactStateForPlayer, revealedGameStateView, toClientGameState, unredactedPrefix } from '../redaction'
import type { GameState, Unit } from '../types'
import { applyUndoAction } from '../undoRedo'

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

    it("masks another player's CHOOSE_CARD actionHistory entry the same way it masks chosenCardIdByPlayerId, but not the viewer's own", () => {
      const base = makeActiveGameWithFullHands()
      const state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
      expect(state.pendingPlayerIds).toEqual(['p2'])

      const asP2 = redactStateForPlayer(state, 'p2')
      const p1Entry = asP2.actionHistory.find((e) => e.action.type === 'CHOOSE_CARD' && e.action.playerId === 'p1')!
      expect(p1Entry.action).toMatchObject({ type: 'CHOOSE_CARD', cardId: null })

      const asP1 = redactStateForPlayer(state, 'p1')
      const ownEntry = asP1.actionHistory.find((e) => e.action.type === 'CHOOSE_CARD' && e.action.playerId === 'p1')!
      expect(ownEntry.action).toMatchObject({ type: 'CHOOSE_CARD', cardId: cardIdFor('p1', 'city') })
    })

    it('reveals a masked CHOOSE_CARD actionHistory entry once the phase resolves, but never re-masks an earlier round once a new one starts', () => {
      const base = makeActiveGameWithFullHands()
      let state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
      state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
      expect(state.roundPhase).toBe('actions')

      const asP2 = redactStateForPlayer(state, 'p2')
      const p1Entry = asP2.actionHistory.find((e) => e.action.type === 'CHOOSE_CARD' && e.action.playerId === 'p1')!
      expect(p1Entry.action).toMatchObject({ type: 'CHOOSE_CARD', cardId: cardIdFor('p1', 'city') })

      // A later round's own still-pending selectCards phase must not reach
      // back and re-mask this already-resolved round's entry (same
      // turn-scoping bug class chosenCardIdByPlayerId is immune to since it
      // only ever holds the current round's picks).
      const laterRoundState = { ...state, turn: state.turn + 1, roundPhase: 'selectCards' as const, pendingPlayerIds: ['p2'] }
      const asP2Later = redactStateForPlayer(laterRoundState, 'p2')
      const p1EntryLater = asP2Later.actionHistory.find((e) => e.action.type === 'CHOOSE_CARD' && e.action.playerId === 'p1')!
      expect(p1EntryLater.action).toMatchObject({ type: 'CHOOSE_CARD', cardId: cardIdFor('p1', 'city') })
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

      // The same masking applies to the raw MOVE_TO_DECLINE actionHistory
      // entry, not just the derived declineCardIds array above.
      const p1LogEntry = asP2.actionHistory.find((e) => e.action.type === 'MOVE_TO_DECLINE' && e.action.playerId === 'p1')!
      expect(p1LogEntry.action).toMatchObject({ type: 'MOVE_TO_DECLINE', cardId: null })
      const p1LogEntryAsP1 = asP1.actionHistory.find((e) => e.action.type === 'MOVE_TO_DECLINE' && e.action.playerId === 'p1')!
      expect(p1LogEntryAsP1.action).toMatchObject({ type: 'MOVE_TO_DECLINE', cardId: p1Temple })

      // Once the whole phase resolves, it's public to everyone.
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }))
      expect(state.roundPhase).toBe('purchase')
      const resolvedAsP2 = redactStateForPlayer(state, 'p2')
      expect(resolvedAsP2.players.find((p) => p.id === 'p1')!.declineCardIds).toEqual([p1Temple])
      const resolvedLogEntry = resolvedAsP2.actionHistory.find((e) => e.action.type === 'MOVE_TO_DECLINE' && e.action.playerId === 'p1')!
      expect(resolvedLogEntry.action).toMatchObject({ type: 'MOVE_TO_DECLINE', cardId: p1Temple })
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

      // The earlier round's own MOVE_TO_DECLINE actionHistory entry is
      // unaffected — only this round's still-open addition is masked.
      const oldLogEntry = asP2.actionHistory.find((e) => e.action.type === 'MOVE_TO_DECLINE' && e.turn === state.turn - 1)!
      expect(oldLogEntry.action).toMatchObject({ type: 'MOVE_TO_DECLINE', cardId: oldCardId })
      const newLogEntry = asP2.actionHistory.find((e) => e.action.type === 'MOVE_TO_DECLINE' && e.turn === state.turn)!
      expect(newLogEntry.action).toMatchObject({ type: 'MOVE_TO_DECLINE', cardId: null })
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

    it("masks a single-card RETRACT_DECLINE naming a still-secret addition (issue #505) — otherwise the retraction's own payload would leak what the masked MOVE_TO_DECLINE hid", () => {
      let state = reachDeclinePhase(2) // owes 2, so the phase stays open after retracting one
      const p1Temple = cardIdFor('p1', 'temple')
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Temple }))
      state = requireOk(applyAction(state, { type: 'RETRACT_DECLINE', playerId: 'p1', cardId: p1Temple }))
      expect(state.roundPhase).toBe('decline')

      const asP2 = redactStateForPlayer(state, 'p2')
      const retractEntry = asP2.actionHistory.find((e) => e.action.type === 'RETRACT_DECLINE')!
      expect(retractEntry.action).toMatchObject({ type: 'RETRACT_DECLINE', cardId: null })

      const asP1 = redactStateForPlayer(state, 'p1')
      const ownRetractEntry = asP1.actionHistory.find((e) => e.action.type === 'RETRACT_DECLINE')!
      expect(ownRetractEntry.action).toMatchObject({ type: 'RETRACT_DECLINE', cardId: p1Temple })
    })

    it('never masks a no-cardId "retract everything this phase" RETRACT_DECLINE, since it carries nothing to leak', () => {
      let state = reachDeclinePhase(2)
      const p1Temple = cardIdFor('p1', 'temple')
      const p1Nomad = cardIdFor('p1', 'nomad')
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Temple }))
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Nomad }))
      state = requireOk(applyAction(state, { type: 'RETRACT_DECLINE', playerId: 'p1' }))
      expect(state.roundPhase).toBe('decline')

      const asP2 = redactStateForPlayer(state, 'p2')
      const retractEntry = asP2.actionHistory.find((e) => e.action.type === 'RETRACT_DECLINE')!
      expect(retractEntry.action.type).toBe('RETRACT_DECLINE')
      expect((retractEntry.action as { cardId?: string | null }).cardId).toBeUndefined()
    })

    it('reveals a masked RETRACT_DECLINE entry once the phase resolves', () => {
      let state = reachDeclinePhase(2)
      const p1Temple = cardIdFor('p1', 'temple')
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Temple }))
      state = requireOk(applyAction(state, { type: 'RETRACT_DECLINE', playerId: 'p1', cardId: p1Temple }))
      // p1 re-declines and both players finish supplying every owed card, resolving the phase.
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Temple }))
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: cardIdFor('p1', 'nomad') }))
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: cardIdFor('p2', 'temple') }))
      state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p2', cardId: cardIdFor('p2', 'nomad') }))
      expect(state.roundPhase).toBe('purchase')

      const asP2 = redactStateForPlayer(state, 'p2')
      const retractEntry = asP2.actionHistory.find((e) => e.action.type === 'RETRACT_DECLINE')!
      expect(retractEntry.action).toMatchObject({ type: 'RETRACT_DECLINE', cardId: p1Temple })
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

    it('leaves every other actionHistory entry — including a still-pending phase\'s non-CHOOSE_CARD/MOVE_TO_DECLINE actions — unchanged', () => {
      const base = makeActiveGameWithFullHands()
      const state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
      const asP2 = redactStateForPlayer(state, 'p2')
      expect(asP2.actionHistory).toHaveLength(state.actionHistory.length)
      for (const [redactedEntry, originalEntry] of asP2.actionHistory.map((e, i) => [e, state.actionHistory[i]] as const)) {
        if (redactedEntry.action.type === 'CHOOSE_CARD' && redactedEntry.action.playerId !== 'p2') continue // covered by the selectCards describe block above
        expect(redactedEntry).toEqual(originalEntry)
      }
    })
  })
})

describe('revealedGameStateView', () => {
  it('reports every chosenCardIdByPlayerId entry as its real value, RedactedChoice-shaped', () => {
    const base = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const revealed = revealedGameStateView(state)
    expect(revealed.chosenCardIdByPlayerId.p1).toEqual({ chosen: true, cardId: cardIdFor('p1', 'city') })
    expect(revealed.chosenCardIdByPlayerId.p2).toEqual({ chosen: false })
  })
})

describe('unredactedPrefix', () => {
  it('returns the whole history unchanged when nothing is masked', () => {
    const base = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    // The real, unredacted history — nothing masked, so nothing truncated.
    expect(unredactedPrefix(state.actionHistory)).toEqual(state.actionHistory)
  })

  it('truncates at the first masked CHOOSE_CARD/MOVE_TO_DECLINE entry, dropping everything after it too', () => {
    const base = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const asP2 = redactStateForPlayer(state, 'p2')
    // p1's masked pick is the only entry, and it's now dropped entirely.
    expect(unredactedPrefix(asP2.actionHistory)).toEqual([])
  })

  it("keeps a real RETRACT_CHOICE that closes a masked pick in the prefix, along with the masked pick itself (issue #527)", () => {
    const base = makeActiveGameWithFullHands()
    let state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    state = requireOk(applyAction(state, { type: 'RETRACT_CHOICE', playerId: 'p1' }))
    const asP2 = redactStateForPlayer(state, 'p2')
    // p1's pick is retracted, not undone, so resolveHistory().effective still
    // includes both entries — but the RETRACT_CHOICE closes the mask it
    // follows (gameLog.ts's extendGameLog treats both as narration-only
    // no-ops), so there's nothing left to truncate.
    expect(unredactedPrefix(asP2.actionHistory).map((e) => e.action.type)).toEqual(['CHOOSE_CARD', 'RETRACT_CHOICE'])
  })

  it("keeps a real UNDO_ACTION (and the resolveHistory().canRedo it powers) in the prefix even though it comes right after a masked pick, since undoing that pick means it's no longer in effect (issue #498)", () => {
    const genesis = makeActiveGameWithFullHands()
    const afterChoice = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    expect(afterChoice.pendingPlayerIds).toEqual(['p2'])

    // p2 undoes p1's still-secret pick — reverting the round back to both
    // players pending, same as GamePage.tsx's handleUndo/undo-action.
    const undone = requireOk(applyUndoAction(genesis, afterChoice, 'p2'))
    expect(undone.roundPhase).toBe('selectCards')
    expect(undone.pendingPlayerIds).toEqual(['p1', 'p2'])

    const asP2 = redactStateForPlayer(undone, 'p2')
    // p1's pick is masked from p2 exactly as before (it's still secret —
    // undoing it doesn't retroactively reveal what it was)...
    const choiceEntry = asP2.actionHistory.find((e) => e.action.type === 'CHOOSE_CARD')!
    expect(choiceEntry.action).toMatchObject({ cardId: null })
    // ...but since it's no longer in effect, the real UNDO_ACTION entry that
    // follows it must survive unredactedPrefix's truncation — previously
    // this dropped the UNDO_ACTION too, permanently hiding from p2's own
    // client that anything was ever undone at all.
    const prefix = unredactedPrefix(asP2.actionHistory)
    expect(prefix.map((e) => e.action.type)).toEqual(['CHOOSE_CARD', 'UNDO_ACTION'])

    // This is what actually powers GamePage.tsx's Redo button
    // (historyPointer.canRedo) — p2's own client must agree with the server
    // that p1's pick is redoable, not just p1's.
    expect(resolveHistory(prefix).canRedo).toBe(true)

    // p1's own view was never masked (it's their own pick), so it was never
    // affected by the bug — asserted here so the fix's effect on p2's view
    // is the only thing under test above.
    const asP1 = redactStateForPlayer(undone, 'p1')
    expect(resolveHistory(unredactedPrefix(asP1.actionHistory)).canRedo).toBe(true)
  })

  it('still truncates away a real entry that follows a masked pick which remains in effect (not undone or retracted) — the ordinary still-pending case is unaffected by the issue #527 fix', () => {
    const base = makeActiveGameWithFullHands()
    let state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    state = requireOk(applyAction(state, { type: 'RETRACT_CHOICE', playerId: 'p1' }))
    state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'temple') }))
    const asP2 = redactStateForPlayer(state, 'p2')
    // The first pick's mask is closed by the RETRACT_CHOICE between them
    // (issue #527) and so no longer gates anything — but p1's second,
    // still-in-effect, still-secret pick masks the same way the first one
    // did, and nothing retracts *that* one, so there's nothing safe to
    // replay past it.
    expect(unredactedPrefix(asP2.actionHistory).map((e) => e.action.type)).toEqual(['CHOOSE_CARD', 'RETRACT_CHOICE'])
  })

  it("truncates before a still-masked decline addition even once it's been retracted — the retraction doesn't unmask it (issue #505)", () => {
    const base = { ...makeActiveGameWithFullHands(), achievementsClaimedThisRound: 2 }
    let state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
    state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p1' }))
    state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p2' }))
    expect(state.roundPhase).toBe('decline')
    const p1Temple = cardIdFor('p1', 'temple')
    state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: p1Temple }))
    state = requireOk(applyAction(state, { type: 'RETRACT_DECLINE', playerId: 'p1', cardId: p1Temple }))

    const asP2 = redactStateForPlayer(state, 'p2')
    // Both the original MOVE_TO_DECLINE and the RETRACT_DECLINE that follows
    // it are masked, and still in effect (RETRACT_DECLINE is an ordinary
    // action, not an UNDO_ACTION, so resolveHistory never folds either away)
    // — everything up to (not including) the MOVE_TO_DECLINE survives, but
    // nothing from there on is safe to replay.
    expect(unredactedPrefix(asP2.actionHistory).map((e) => e.action.type)).toEqual(['CHOOSE_CARD', 'CHOOSE_CARD', 'PASS_ACTIONS', 'PASS_ACTIONS'])
  })

  it('keeps a no-cardId "retract everything this phase" RETRACT_DECLINE in the prefix when nothing before it was masked', () => {
    const base = { ...makeActiveGameWithFullHands(), achievementsClaimedThisRound: 1 }
    let state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
    state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p1' }))
    state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p2' }))
    expect(state.roundPhase).toBe('decline')
    // p1's own only owed card this phase — p1 no longer has anything of
    // their own to retract by the time p2 is the viewer below, so there's
    // nothing left for p2 to have masked either.
    state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: cardIdFor('p1', 'temple') }))
    state = requireOk(applyAction(state, { type: 'RETRACT_DECLINE', playerId: 'p1' }))

    const asP1 = redactStateForPlayer(state, 'p1')
    expect(unredactedPrefix(asP1.actionHistory).map((e) => e.action.type)).toEqual(['CHOOSE_CARD', 'CHOOSE_CARD', 'PASS_ACTIONS', 'PASS_ACTIONS', 'MOVE_TO_DECLINE', 'RETRACT_DECLINE'])
  })
})

describe('toClientGameState', () => {
  it('collapses RedactedChoice back to a plain string|null, and drops the still-secret actionHistory tail', () => {
    const base = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const asP2 = redactStateForPlayer(state, 'p2')

    const client = toClientGameState(asP2)
    expect(client.chosenCardIdByPlayerId.p1).toBeNull() // masked ("chosen but hidden") collapses the same as "not chosen"
    expect(client.chosenCardIdByPlayerId.p2).toBeNull()
    expect(client.actionHistory).toEqual([])
  })

  it("collapses a viewer's own unmasked choice through unchanged", () => {
    const base = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const asP1 = redactStateForPlayer(state, 'p1')

    const client = toClientGameState(asP1)
    expect(client.chosenCardIdByPlayerId.p1).toBe(cardIdFor('p1', 'city'))
    expect(client.actionHistory).toHaveLength(1)
  })

  it("preserves resolveHistory().canRedo (GamePage.tsx's Redo button) across an undo of another player's still-secret pick (issue #498)", () => {
    const genesis = makeActiveGameWithFullHands()
    const afterChoice = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const undone = requireOk(applyUndoAction(genesis, afterChoice, 'p2'))

    const asP2 = redactStateForPlayer(undone, 'p2')
    const client = toClientGameState(asP2)
    expect(resolveHistory(client.actionHistory).canRedo).toBe(true)
  })

  it("keeps a masked decline addition's null in place (not filtered out), preserving the pile's length", () => {
    const base = makeActiveGameWithFullHands()
    let state = { ...base, achievementsClaimedThisRound: 1 }
    state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    state = requireOk(applyAction(state, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))
    state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p1' }))
    state = requireOk(applyAction(state, { type: 'PASS_ACTIONS', playerId: 'p2' }))
    expect(state.roundPhase).toBe('decline')
    state = requireOk(applyAction(state, { type: 'MOVE_TO_DECLINE', playerId: 'p1', cardId: cardIdFor('p1', 'temple') }))

    const asP2 = redactStateForPlayer(state, 'p2')
    const client = toClientGameState(asP2)
    expect(client.players.find((p) => p.id === 'p1')!.declineCardIds).toEqual([null])
  })

  it('round-trips a fully-revealed view (revealedGameStateView) back to the exact original chosenCardIdByPlayerId', () => {
    const base = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(base, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const client = toClientGameState(revealedGameStateView(state))
    expect(client.chosenCardIdByPlayerId).toEqual(state.chosenCardIdByPlayerId)
    expect(client.actionHistory).toEqual(state.actionHistory)
  })
})

describe("narrating a client's redacted actionHistory (issue #514)", () => {
  it("shows an UNDO_ACTION that follows a still-masked pick — the pick stays masked, but its own undo is never itself secret", () => {
    const genesis = makeActiveGameWithFullHands()
    const afterChoice = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    // p2 undoes p1's still-secret pick, same GamePage.tsx handleUndo flow as
    // the issue #498 test above — this is what leaves the masked CHOOSE_CARD
    // sitting mid-array in p2's own client.actionHistory, immediately
    // followed by a real, unmasked UNDO_ACTION.
    const undone = requireOk(applyUndoAction(genesis, afterChoice, 'p2'))

    const asP2 = redactStateForPlayer(undone, 'p2')
    const client = toClientGameState(asP2)
    expect(client.actionHistory.map((e) => e.action.type)).toEqual(['CHOOSE_CARD', 'UNDO_ACTION'])

    // Before the fix, buildGameLog tried to applyActionWithSteps() the
    // masked CHOOSE_CARD's `cardId: null` payload directly, that failed,
    // and the narration loop's defensive bail silently dropped every event
    // from there on — including the UNDO_ACTION's own line — leaving p2
    // with an empty log for a round that visibly had activity in it.
    const log = buildGameLog(genesis, client.actionHistory)
    expect(log.map((e) => e.message)).toContain(`${PLAYER_PLACEHOLDER} undid the last action`)
  })

  it('keeps narrating real entries that follow a masked-and-undone pick, not just the UNDO_ACTION itself', () => {
    const genesis = makeActiveGameWithFullHands()
    const afterChoice = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const undone = requireOk(applyUndoAction(genesis, afterChoice, 'p2'))
    // p2 now picks for real — an ordinary action dispatched after the
    // masked-and-folded-away entry, which must narrate normally too.
    const rechosen = requireOk(applyAction(undone, { type: 'CHOOSE_CARD', playerId: 'p2', cardId: cardIdFor('p2', 'city') }))

    const asP2 = redactStateForPlayer(rechosen, 'p2')
    const client = toClientGameState(asP2)

    const log = buildGameLog(genesis, client.actionHistory)
    expect(log.map((e) => e.message)).toContain(`${PLAYER_PLACEHOLDER} undid the last action`)
    expect(log.some((e) => e.message.includes('chose to play'))).toBe(true)
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

  it("synthesizes a \"chose a card\" line for a still-pending player whose CHOOSE_CARD entry never reached the log at all (issue #497)", () => {
    // Simulates the hiddenInformationEnabled read path: get-game-state's
    // unredactedPrefix cuts the raw actionHistory *before* p1's still-secret
    // CHOOSE_CARD, so a redacted client's own actionHistory never contains
    // it and buildGameLog never derives an event for it — unlike the
    // client-trusted path (the test above), where the real event always
    // exists and only needs its message swapped.
    const genesis = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    expect(state.roundPhase).toBe('selectCards')
    expect(state.pendingPlayerIds).toEqual(['p2'])
    const log = buildGameLog(genesis, []) // p1's CHOOSE_CARD entry never reached this client

    const asP2 = redactGameLog(log, state, 'p2')
    const synthesized = asP2.find((e) => e.playerId === 'p1')!
    expect(synthesized.message).toBe(`${PLAYER_PLACEHOLDER} chose a card`)

    // The acting player still sees nothing synthesized about themself — this
    // gap is specific to *other* players' picks, and p1's own client always
    // gets its own real actionHistory entry back unmasked (redactStateForPlayer).
    const asP1 = redactGameLog(log, state, 'p1')
    expect(asP1.find((e) => e.playerId === 'p1')).toBeUndefined()
  })

  it('tags a synthesized "chose a card" line as admin mode when the game currently has it on (issue #536)', () => {
    const genesis = makeActiveGameWithFullHands()
    const withAdminOn = requireOk(applyAction(genesis, { type: 'SET_ADMIN_MODE', playerId: 'p1', enabled: true }))
    const state = requireOk(applyAction(withAdminOn, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    expect(state.pendingPlayerIds).toEqual(['p2'])
    const log = buildGameLog(genesis, []) // p1's CHOOSE_CARD entry never reached this client

    const asP2 = redactGameLog(log, state, 'p2')
    const synthesized = asP2.find((e) => e.playerId === 'p1')!
    expect(synthesized.message).toBe(`${PLAYER_PLACEHOLDER} chose a card`)
    expect(synthesized.adminMode).toBe(true)
  })

  it('does not duplicate a synthesized line once the real (redacted-message) event is already present', () => {
    const genesis = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const log = buildGameLog(genesis, state.actionHistory)

    const asP2 = redactGameLog(log, state, 'p2')
    expect(asP2.filter((e) => e.playerId === 'p1' && e.message.includes('chose'))).toHaveLength(1)
  })

  it('never synthesizes a line for a player still pending, or for the viewer themself', () => {
    const genesis = makeActiveGameWithFullHands()
    const state = requireOk(applyAction(genesis, { type: 'CHOOSE_CARD', playerId: 'p1', cardId: cardIdFor('p1', 'city') }))
    const log = buildGameLog(genesis, [])

    const asP1 = redactGameLog(log, state, 'p1')
    expect(asP1.some((e) => e.playerId === 'p2')).toBe(false) // p2 is still pending
    expect(asP1.some((e) => e.playerId === 'p1')).toBe(false) // p1 is the viewer
  })
})

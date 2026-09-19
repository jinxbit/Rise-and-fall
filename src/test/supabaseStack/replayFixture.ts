// Replays a whole game's logged action history against the stack, submitting
// each entry the way production submits that kind of entry: a substantive
// action to apply-action, an UNDO_ACTION/REDO_ACTION marker to
// undo-action/redo-action (those move a pointer, they aren't a step forward —
// see UndoAction's doc comment in src/engine/actions.ts), each as the
// signed-in user who holds the seat that made it.
//
// Shared by ./…/__tests__/productionGames.test.ts, which points it at real
// exported games, and by ./…/__tests__/supabaseStack.test.ts, which points it
// at a game it just played — so the replay path itself stays covered in CI
// even before any production export is checked in.

import { applyActionWithSteps } from '../../engine/applyAction.ts'
import type { GameState } from '../../engine/types.ts'
import type { ProductionGameFixture } from '../fixtures/productionGames/loadFixtures.ts'
import { normalizeStateForComparison } from '../fixtures/productionGames/loadFixtures.ts'
import type { EnforcedCallResult, ProductionStack } from './index.ts'

/**
 * The whole surface a replay needs, so the same routine can drive the
 * in-process stack (./index.ts) and a real deployed Supabase project
 * (../productionSmoke/liveProject.ts) without either knowing about the
 * other. ProductionStack satisfies it; a live project satisfies only the
 * enforced trio, since replaying a client-trusted game against production
 * would mean writing `game_state` from a script, which is exactly the thing
 * the enforced path exists to stop.
 */
export interface ReplayTarget {
  applyAction: ProductionStack['applyAction']
  undoAction: ProductionStack['undoAction']
  redoAction: ProductionStack['redoAction']
  applyActionClientTrusted?: ProductionStack['applyActionClientTrusted']
  undoActionClientTrusted?: ProductionStack['undoActionClientTrusted']
  redoActionClientTrusted?: ProductionStack['redoActionClientTrusted']
}

export type LoggedEntry = GameState['actionHistory'][number]

export function submitLoggedEntry(stack: ReplayTarget, fixture: ProductionGameFixture, entry: LoggedEntry): Promise<EnforcedCallResult> {
  // UNDO_ACTION/REDO_ACTION/SET_ADMIN_MODE carry a nullable, narration-only
  // playerId (see their doc comments in src/engine/actions.ts) — a null one
  // means nobody in particular was "acting", so the room owner stands in,
  // which is also the only caller SET_ADMIN_MODE would have accepted.
  const playerId = entry.action.playerId
  const userId = playerId === null ? fixture.game.created_by : fixture.userIdForPlayer(playerId)
  const gameId = fixture.game.id

  // Which of the app's two write paths this game actually ran on — the same
  // branch GamePage.tsx's submitAction/handleUndo/handleRedo take. Replaying a
  // client-trusted game through the Edge Functions would be testing it against
  // rules it was never played under; replaying an enforced one directly would
  // skip the only thing worth testing about it.
  if (!fixture.game.settings.ruleEnforcementEnabled) {
    if (!stack.applyActionClientTrusted || !stack.undoActionClientTrusted || !stack.redoActionClientTrusted) {
      throw new Error(
        `[${fixture.name}] was played client-trusted, and this replay target only supports the rule-enforced write path. ` +
          `Replay it against the in-process stack, or give the fixture a sidecar leaving enforcement on.`,
      )
    }
    if (entry.action.type === 'UNDO_ACTION') return stack.undoActionClientTrusted(userId, gameId, playerId, fixture.genesis, fixture.content)
    if (entry.action.type === 'REDO_ACTION') return stack.redoActionClientTrusted(userId, gameId, playerId, fixture.genesis, fixture.content)
    return stack.applyActionClientTrusted(userId, gameId, entry.action, fixture.content)
  }

  if (entry.action.type === 'UNDO_ACTION') return stack.undoAction(userId, gameId)
  if (entry.action.type === 'REDO_ACTION') return stack.redoAction(userId, gameId)
  return stack.applyAction(userId, gameId, entry.action)
}

export interface ReplayOutcome {
  /** The `game_state.version` the row is on once the whole history has been submitted. */
  version: number
  /**
   * Indices into the fixture's raw history that had nothing left to submit —
   * see `isStaleForcedFollowUp` below, and `undoTargetsFoldedEntry` for the
   * UNDO_ACTION/REDO_ACTION markers that revert one of those.
   */
  foldedEntryIndices: number[]
}

/**
 * Is this logged entry something today's engine has already done, as part of
 * the preceding entry's own cascade?
 *
 * Since the §4.2/§4.3 fold-in, a forced single-option follow-up (a tile tier
 * with one legal arrangement left, a one-card hand's pick) no longer gets its
 * own actionHistory entry — applyAction folds it into whatever triggered it.
 * A game played before that change has standalone entries for those, and its
 * own reconstruction paths (replayActions, gameLog, turnReview) already skip
 * them: applyAction's `isStaleForcedFollowUp` branch. A *live* submission
 * deliberately does not, so that a player resubmitting a stale action still
 * gets a real rejection — which means a replay driving the live path has to
 * make the same distinction the reconstruction paths make.
 *
 * Asked of the engine rather than reimplemented: dispatched as a trusted
 * replay, a stale follow-up is the one case that succeeds with no steps.
 */
function isStaleForcedFollowUp(state: GameState, entry: LoggedEntry, fixture: ProductionGameFixture): boolean {
  if (entry.action.type === 'UNDO_ACTION' || entry.action.type === 'REDO_ACTION') return false
  const { content } = fixture
  const result = applyActionWithSteps(
    state,
    entry.action,
    content.unitContent,
    content.achievementContent,
    content.boardGenerationContent,
    content.taleContent,
    true,
  )
  return result.ok && result.steps.length === 0
}

/**
 * Is this UNDO_ACTION/REDO_ACTION marker one that moves the pointer across an
 * entry this replay already folded away?
 *
 * The forward half of the §4.2/§4.3 fold-in has an undo-side half. A game
 * played before the fold-in logged a forced follow-up as its own entry, so
 * walking back over it took its own Undo: production needed two, one for the
 * follow-up and one for the action that forced it. Today those are a single
 * entry, and `isStaleForcedFollowUp` above drops the follow-up from the
 * replay — which leaves the second of production's two Undos with nothing of
 * its own left to revert. Submitted anyway, it walks back over the *preceding*
 * real action instead, silently rewinding a move the game never took back:
 * every later action then resolves against a state production never had, and
 * the replay fails somewhere downstream with a rejection that looks like a
 * rules regression and isn't (`three-player-red-wins-with-undos`, whose
 * Undo at raw entry 178 reverts a folded CHOOSE_CARD, first hit this — the
 * replay died 21 actions later on an unrelated-looking RESOLVE_UNIT_ACTION).
 *
 * So an Undo whose target was folded is itself folded, and likewise a Redo
 * that would step back onto one: the entry it belongs to already carries the
 * follow-up, so the single remaining Undo reverts both at once, exactly as it
 * would in a game played today. `pointer` is walkHistory's, before this
 * marker moves it; a marker that would run past either end of the walk is
 * folded too, since production's own pointer clamps there (`Math.max`/
 * `Math.min` in walkHistory) and the live path would reject it outright.
 */
function undoTargetsFoldedEntry(entry: LoggedEntry, substantiveWasFolded: boolean[], pointer: number): boolean {
  if (entry.action.type === 'UNDO_ACTION') return pointer === 0 || substantiveWasFolded[pointer - 1]
  return pointer >= substantiveWasFolded.length || substantiveWasFolded[pointer]
}

/**
 * Submits every entry in order, failing with the action's position and the
 * server's own message the moment one is rejected — which is the useful half
 * of a failure here: "action 143/210, RESOLVE_UNIT_ACTION by seat-2, 400: ..."
 * localizes a rules or enforcement regression to one move of one real game.
 */
export async function replayFixtureThroughStack(stack: ReplayTarget, fixture: ProductionGameFixture): Promise<ReplayOutcome> {
  const history = fixture.finalState.actionHistory
  const foldedEntryIndices: number[] = []
  let state = fixture.genesis
  let version = 0

  // Mirrors walkHistory's pointer (src/engine/historyFold.ts) over the raw
  // history, remembering for each substantive entry whether this replay
  // folded it — which is what `undoTargetsFoldedEntry` needs to tell a real
  // undo from one that reverts an entry today's engine never logged.
  const substantiveWasFolded: boolean[] = []
  let pointer = 0

  for (const [index, entry] of history.entries()) {
    let folded: boolean
    if (entry.action.type === 'UNDO_ACTION' || entry.action.type === 'REDO_ACTION') {
      folded = undoTargetsFoldedEntry(entry, substantiveWasFolded, pointer)
      if (entry.action.type === 'UNDO_ACTION') pointer = Math.max(0, pointer - 1)
      else pointer = Math.min(substantiveWasFolded.length, pointer + 1)
    } else if (entry.action.type === 'SET_ADMIN_MODE') {
      // Never joins the pointer walk — see walkHistory's doc comment.
      folded = isStaleForcedFollowUp(state, entry, fixture)
    } else {
      folded = isStaleForcedFollowUp(state, entry, fixture)
      substantiveWasFolded.length = pointer // drops the un-redone tail, exactly as walkHistory does
      substantiveWasFolded.push(folded)
      pointer += 1
    }
    if (folded) {
      foldedEntryIndices.push(index)
      continue
    }
    const result = await submitLoggedEntry(stack, fixture, entry)
    if (!result.ok) {
      throw new Error(
        `[${fixture.name}] action ${index + 1}/${history.length} (${entry.action.type} by ${entry.action.playerId}) was rejected with ${result.status}: ${result.error}`,
      )
    }
    version += 1
    if (result.version !== version) {
      throw new Error(`[${fixture.name}] action ${index + 1}/${history.length} left game_state at version ${result.version}, expected ${version}.`)
    }
    state = result.state
  }
  return { version, foldedEntryIndices }
}

/**
 * The exported state as the replay should have reproduced it: identical in
 * every respect except that the entries `replayFixtureThroughStack` had
 * nothing to submit for are gone from the log. Each one is a no-op against
 * today's engine by construction (that is what made it skippable), so
 * dropping it changes the log and nothing else about the game.
 */
export function expectedFinalState(fixture: ProductionGameFixture, outcome: ReplayOutcome): GameState {
  if (outcome.foldedEntryIndices.length === 0) return fixture.finalState
  const folded = new Set(outcome.foldedEntryIndices)
  return { ...fixture.finalState, actionHistory: fixture.finalState.actionHistory.filter((_, index) => !folded.has(index)) }
}

/**
 * Two states compared as *games*, not as bytes — normalizeStateForComparison's
 * timestamp and absent-optional handling, plus one thing only a replay through
 * the server hits.
 *
 * An UNDO_ACTION/REDO_ACTION entry's `playerId` is narration only: the server
 * stamps it from whoever called, and in a hotseat game several seats share one
 * auth user, so a replay can legitimately attribute a marker to a different
 * seat than production did (see UndoAction's doc comment). Everything else,
 * including every substantive entry and its order, has to match exactly.
 */
export function normalizeForComparison(state: GameState): GameState {
  return normalizeStateForComparison({
    ...state,
    actionHistory: state.actionHistory.map((entry) =>
      entry.action.type === 'UNDO_ACTION' || entry.action.type === 'REDO_ACTION'
        ? { ...entry, action: { ...entry.action, playerId: '(caller)' } }
        : entry,
    ),
  })
}

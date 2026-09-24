// Pins the contract the cold-open path depends on (todo.md #146): a rendered
// view can always be turned back into a clean base, including — especially —
// when an in-flight overlay has been laid over it.
//
// This exists because the absence of it let a real regression through. #648
// made GamePage cache the *base* rather than the rendered view, but the base
// only came from a response that had a replay context, and on a cold open the
// mount fetch runs before `players` loads, so there was none. The cache then
// never populated at all and the first move of every session fell back to the
// old protocol — with every test still green.
import { describe, expect, it } from 'vitest'
import { applyAction } from '../applyAction'
import { resolveHistory } from '../historyFold'
import { replayToBase } from '../replay'
import { redactStateForPlayer, toClientGameState } from '../redaction'
import { applyInFlightOverlay, buildInFlightOverlay, needsInFlightOverlay } from '../inFlightOverlay'
import { loadProductionGameFixtures } from '../../test/fixtures/productionGames/loadFixtures'
import type { GameState } from '../types'

describe('replayToBase', () => {
  it('rebuilds a base that the overlay puts back to exactly the view it came from', async () => {
    const fixtures = await loadProductionGameFixtures()
    let overlaidCases = 0

    for (const fixture of fixtures) {
      const c = fixture.content
      const content = [c.unitContent, c.achievementContent, c.boardGenerationContent, c.taleContent] as const

      const states: GameState[] = [fixture.genesis]
      let current = fixture.genesis
      for (const entry of resolveHistory(fixture.finalState.actionHistory).effective) {
        const result = applyAction(current, entry.action, ...content, true)
        if (!result.ok) throw new Error(result.error)
        current = result.state
        states.push(current)
      }

      const seat = fixture.finalState.players[0].id
      // Sample rather than sweep: the exhaustive per-state check lives in
      // inFlightOverlay.test.ts; this one is about the rebuild round trip.
      for (let i = 1; i < states.length; i += 19) {
        const view = toClientGameState(redactStateForPlayer(states[i], seat))
        const base = replayToBase(fixture.genesis, view, ...content)

        // The log survives verbatim — the server's timestamps, not the replay's.
        expect(base.actionHistory).toEqual(view.actionHistory)

        const overlay = needsInFlightOverlay(states[i], view) ? buildInFlightOverlay(view) : undefined
        if (overlay) overlaidCases++
        expect(applyInFlightOverlay(base, overlay)).toEqual(view)
      }
    }

    // If this never saw a contaminated view, the assertion above proved the
    // easy half only — the whole point is that a view carrying an overlay
    // still rebuilds to a clean base.
    expect(overlaidCases).toBeGreaterThan(0)
  }, 60000)
})

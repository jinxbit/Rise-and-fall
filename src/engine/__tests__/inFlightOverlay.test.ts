// The measurement ../inFlightOverlay.ts's field list came from, kept as a test
// so the list cannot quietly rot. Every state of every recorded game, from
// every seat (including a non-seated reader), rebuilds the viewer's state from
// the actions they are allowed to see and checks that the overlay closes the
// gap to their redacted view exactly.
//
// A failure here means a rules change moved a field the overlay doesn't carry.
// That is not a correctness bug in production — the client's hash simply would
// not match and it would fetch in full — but it throws the bandwidth win away
// silently, which is the kind of regression nothing else would notice.
//
// This also exercises `extendReplay`'s undo handling on real games: it walks
// each seat's prefix forward the same way the client does, so if the
// incremental path were wrong about folding, these assertions would catch it.
import { describe, expect, it } from 'vitest'
import { extendReplay, replayActions } from '../replay'
import { resolveHistory } from '../historyFold'
import { applyAction } from '../applyAction'
import { redactStateForPlayer, toClientGameState } from '../redaction'
import { applyInFlightOverlay, buildInFlightOverlay, IN_FLIGHT_OVERLAY_FIELDS, needsInFlightOverlay } from '../inFlightOverlay'
import { loadProductionGameFixtures } from '../../test/fixtures/productionGames/loadFixtures'
import type { GameState } from '../types'

function withoutHistory(state: GameState): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...state }
  delete copy.actionHistory
  return copy
}

describe('in-flight overlay', () => {
  it('lists distinct fields and leaves the expensive ones out', () => {
    expect([...IN_FLIGHT_OVERLAY_FIELDS].sort()).toEqual([...new Set(IN_FLIGHT_OVERLAY_FIELDS)].sort())
    expect(IN_FLIGHT_OVERLAY_FIELDS).not.toContain('board')
    expect(IN_FLIGHT_OVERLAY_FIELDS).not.toContain('cards')
    expect(IN_FLIGHT_OVERLAY_FIELDS).not.toContain('actionHistory')
  })

  it('replaying the safe prefix plus the overlay reproduces every seat’s view, in every recorded game', async () => {
    const fixtures = await loadProductionGameFixtures()
    expect(fixtures.length).toBeGreaterThan(0)

    for (const fixture of fixtures) {
      const c = fixture.content
      const content = [c.unitContent, c.achievementContent, c.boardGenerationContent, c.taleContent] as const

      const states: GameState[] = [fixture.genesis]
      let current = fixture.genesis
      for (const entry of resolveHistory(fixture.finalState.actionHistory).effective) {
        const result = applyAction(current, entry.action, ...content, true)
        if (!result.ok) throw new Error(`fixture replay failed: ${result.error}`)
        current = result.state
        states.push(current)
      }

      const seats: (string | null)[] = [...fixture.finalState.players.map((p) => p.id), null]
      let comparisons = 0
      let overlaysSent = 0
      let rebuilds = 0

      for (const seat of seats) {
        // The client's own loop: a running base at the viewer's safe prefix,
        // advanced by whatever new entries that viewer became allowed to see.
        let base = fixture.genesis
        for (let i = 1; i < states.length; i++) {
          const view = toClientGameState(redactStateForPlayer(states[i], seat))
          if (view.actionHistory.length < base.actionHistory.length) {
            // The safe prefix is NOT monotonic. With HIDDEN_INFORMATION_PLAN.md
            // §5.3's reveal high-water mark dropped (see redactStateForPlayer's
            // doc comment), masking derives strictly from the *current*
            // roundPhase/pendingPlayerIds, so a new phase can re-mask entries
            // this viewer had already been shown and the prefix moves backwards.
            // In production that is a full fetch: get-game-state only serves a
            // delta while `sinceActionIndex <= safePrefixLength`. Here, rebuild
            // from genesis, which is the same state the client would be handed.
            rebuilds++
            base = { ...replayActions(fixture.genesis, view.actionHistory, ...content), actionHistory: view.actionHistory }
          } else {
            base = extendReplay(fixture.genesis, base, view.actionHistory.slice(base.actionHistory.length), ...content)
          }

          const overlay = needsInFlightOverlay(states[i], view) ? buildInFlightOverlay(view) : undefined
          if (overlay) overlaysSent++
          comparisons++

          // The whole protocol in one assertion: the actions a viewer may see,
          // plus the overlay, equal what the server would have sent them.
          expect(withoutHistory(applyInFlightOverlay(base, overlay))).toEqual(withoutHistory(view))
          expect(base.actionHistory).toEqual(view.actionHistory)
        }
      }

      expect(comparisons).toBeGreaterThan(0)
      // A shrinking prefix costs a full fetch, so it had better be rare.
      expect(rebuilds).toBeLessThan(comparisons / 4)
      // Guards the "omit it when nothing is in flight" half. If this ever
      // reached 100% the overlay would ride on every read and the win with it.
      expect(overlaysSent).toBeLessThan(comparisons / 2)
    }
  }, 60000)
})

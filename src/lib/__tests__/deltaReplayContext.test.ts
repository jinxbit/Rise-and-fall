// Pins the claim the cold-open fix rests on (todo.md #147): a cached GameState
// carries everything needed to rebuild genesis, so the replay context can be
// reconstructed without waiting for `listPlayers`.
//
// The real assertion is the first one — genesis rebuilt from the state must
// equal genesis built from the players table. If `buildGenesisState` ever
// starts reading a column that only exists on a PlayerRow, this fails rather
// than silently producing a genesis that replays to the wrong state and turns
// every cold open into a hash mismatch.
import { describe, expect, it } from 'vitest'
import { buildDeltaReplayContextFromState } from '../deltaReplayContext'
import { buildGenesisState } from '../gameGenesis'
import { loadProductionGameFixtures } from '../../test/fixtures/productionGames/loadFixtures'

describe('buildDeltaReplayContextFromState', () => {
  it('rebuilds the same genesis the players table would have produced', async () => {
    const fixtures = await loadProductionGameFixtures()
    expect(fixtures.length).toBeGreaterThan(0)

    for (const fixture of fixtures) {
      const fromTable = buildGenesisState(fixture.game, fixture.players)
      // The cached state a cold open would actually have on disk.
      const context = buildDeltaReplayContextFromState(fixture.game, fixture.finalState)
      expect(context, `${fixture.name}: expected a context`).not.toBeNull()
      expect(context!.genesis).toEqual(fromTable)
    }
  }, 60000)

  it('resolves the same content bundles the running page resolves', async () => {
    const [fixture] = await loadProductionGameFixtures()
    const context = buildDeltaReplayContextFromState(fixture.game, fixture.finalState)!
    // resolveGameContent is what the stack and the fixtures use; GamePage
    // resolves the same four bundles from the state's own player count and
    // gameLength. A mismatch here means a replay would diverge from the
    // server's for content reasons rather than rules reasons.
    expect(context.unitContent).toEqual(fixture.content.unitContent)
    expect(context.achievementContent).toEqual(fixture.content.achievementContent)
    expect(context.boardGenerationContent).toEqual(fixture.content.boardGenerationContent)
    expect(context.taleContent).toEqual(fixture.content.taleContent)
  }, 60000)

  it('returns null rather than throwing for a state with no players', async () => {
    const [fixture] = await loadProductionGameFixtures()
    expect(buildDeltaReplayContextFromState(fixture.game, { ...fixture.finalState, players: [] })).toBeNull()
  })
})

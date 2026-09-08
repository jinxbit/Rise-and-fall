// Rewrites a production game fixture onto a freshly created room.
//
// A fixture's action history names the *original* room's `players.id` uuids,
// and card ids embed them (`cardIdFor` -> `card_<playerId>_<kind>`, see
// src/engine/cards.ts). A new room's player rows get new uuids from
// `gen_random_uuid()`, so the history has to be rewritten before it can be
// submitted anywhere but the room it came from. Unit ids need no remapping —
// they come from `nextSequenceId` (src/engine/idSequence.ts), which is a
// counter carried in GameState, not a function of who owns the unit.
//
// Done as a substitution over the serialized JSON rather than a structural
// walk, precisely because the ids appear *inside* other strings: a walk would
// have to know every field that embeds one, and would silently miss the next
// one someone adds.

import type { GameState } from '../../engine/types.ts'
import type { GameSettings } from '../../lib/dbTypes.ts'
import type { ProductionGameFixture } from '../fixtures/productionGames/loadFixtures.ts'

export interface RoomIdentity {
  gameId: string
  /** New player row id per original player id, in the fixture's seat order. */
  playerIdByOriginalId: Record<string, string>
  /** New auth user id per original player id. */
  userIdByOriginalPlayerId: Record<string, string>
}

/** Every old -> new substitution this remapping performs, longest key first so no id is a prefix of another mid-replace. */
function substitutions(fixture: ProductionGameFixture, identity: RoomIdentity): [string, string][] {
  const pairs: [string, string][] = [[fixture.finalState.gameId, identity.gameId]]
  for (const player of fixture.finalState.players) {
    const newPlayerId = identity.playerIdByOriginalId[player.id]
    if (!newPlayerId) throw new Error(`No new seat mapped for original player ${player.id} of fixture "${fixture.name}".`)
    pairs.push([player.id, newPlayerId])
    if (player.authUserId) pairs.push([player.authUserId, identity.userIdByOriginalPlayerId[player.id]])
  }
  return pairs.sort(([left], [right]) => right.length - left.length)
}

function remapValue<T>(value: T, pairs: [string, string][]): T {
  let text = JSON.stringify(value)
  for (const [from, to] of pairs) {
    if (from === to) continue
    text = text.split(from).join(to)
  }
  return JSON.parse(text) as T
}

export interface RemappedFixture {
  /** The fixture's own name, for failure messages. */
  name: string
  /** The action history to submit, with every id pointing at the new room. */
  history: GameState['actionHistory']
  /** The state the replay should end on, remapped the same way. */
  expectedFinalState: GameState
  /** `games.settings` the new room must be given for `buildGenesisState` to reproduce this game's genesis. */
  settings: GameSettings
  /** Expected final total VP per *new* player id, when the fixture's sidecar declared one. */
  expectedScoreByPlayerId?: Record<string, number>
  /** Expected winner(s) as new player ids, when the sidecar declared them. */
  expectedWinnerPlayerIds?: string[]
  /** Which new signed-in user submits a given new seat's actions. */
  userIdForPlayer(playerId: string): string
}

/**
 * `fixture`, expressed in terms of the room described by `identity`.
 *
 * `settings` keeps whatever the fixture inferred (a recovered preset board, a
 * "build alone" builder and turn order) with its ids remapped, and forces
 * `ruleEnforcementEnabled` on: a game replayed against a live project goes
 * through the deployed Edge Functions or it isn't testing the deployment.
 */
export function remapFixtureToRoom(fixture: ProductionGameFixture, identity: RoomIdentity): RemappedFixture {
  const pairs = substitutions(fixture, identity)
  const userIdByPlayerId = new Map(
    fixture.finalState.players.map((player) => [identity.playerIdByOriginalId[player.id], identity.userIdByOriginalPlayerId[player.id]]),
  )

  return {
    name: fixture.name,
    history: remapValue(fixture.finalState.actionHistory, pairs),
    expectedFinalState: remapValue(fixture.finalState, pairs),
    settings: { ...remapValue(fixture.game.settings, pairs), ruleEnforcementEnabled: true },
    expectedScoreByPlayerId: fixture.expected.finalScoreByPlayerId && remapValue(fixture.expected.finalScoreByPlayerId, pairs),
    expectedWinnerPlayerIds: fixture.expected.winnerPlayerIds && remapValue(fixture.expected.winnerPlayerIds, pairs),
    userIdForPlayer(playerId) {
      const userId = userIdByPlayerId.get(playerId)
      if (!userId) throw new Error(`Fixture "${fixture.name}" has no seat for player ${playerId} in the remapped room.`)
      return userId
    },
  }
}

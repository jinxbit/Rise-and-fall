// Picks a legal next action for a game in any state, using the real content
// bundles the server resolves.
//
// This exists so the stack has something to exercise when no production game
// export is checked in (see src/test/fixtures/productionGames/README.md) —
// the harness self-test drives a whole game through the real Edge Functions
// with it, from board setup to the end of a round. It is *not* a substitute
// for a real game: it always takes the first legal option it finds, so it
// covers the plumbing (authorization, concurrency, persistence) rather than
// interesting play. Real exported games are what cover the rules.

import { applyAction } from '../../engine/applyAction.ts'
import type { Action } from '../../engine/actions.ts'
import { currentTilePlacerId, currentUnitPlacerId } from '../../engine/boardSetup.ts'
import { coordKey, type Coordinate, type GameState } from '../../engine/types.ts'
import { resolveGameContent } from '../../../supabase/functions/_shared/gameEnforcement.ts'

export type GameContent = ReturnType<typeof resolveGameContent>

export { resolveGameContent }

/** Every hex adjacent to an existing tile, plus the tiles themselves — the only anchors a legal placement can use. */
function candidateAnchors(state: GameState): Coordinate[] {
  const neighbors = [
    { q: 1, r: 0 },
    { q: -1, r: 0 },
    { q: 0, r: 1 },
    { q: 0, r: -1 },
    { q: 1, r: -1 },
    { q: -1, r: 1 },
  ]
  const seen = new Map<string, Coordinate>()
  for (const tile of Object.values(state.board.tiles)) {
    seen.set(coordKey(tile.coord), tile.coord)
    for (const offset of neighbors) {
      const coord = { q: tile.coord.q + offset.q, r: tile.coord.r + offset.r }
      seen.set(coordKey(coord), coord)
    }
  }
  return [...seen.values()]
}

function isLegal(state: GameState, action: Action, content: GameContent): boolean {
  return applyAction(state, action, content.unitContent, content.achievementContent, content.boardGenerationContent, content.taleContent).ok
}

/**
 * The first legal action available in `state`, or null when the game is over
 * (or wedged — which a caller should treat as a failure, not a stopping
 * point, since a real game always has a legal move).
 */
export function nextLegalAction(state: GameState, content: GameContent): Action | null {
  if (state.status === 'boardSetup') {
    const tilePlacerId = currentTilePlacerId(state)
    if (tilePlacerId) {
      for (const anchor of candidateAnchors(state)) {
        for (let rotationSteps = 0; rotationSteps < 6; rotationSteps++) {
          const action: Action = { type: 'PLACE_TILE', playerId: tilePlacerId, anchor, rotationSteps }
          if (isLegal(state, action, content)) return action
        }
      }
      return null
    }
    const unitPlacerId = currentUnitPlacerId(state)
    if (unitPlacerId) {
      const unitKind = state.boardSetup?.unitsRemainingByPlayerId[unitPlacerId]?.[0]
      if (!unitKind) return null
      for (const tile of Object.values(state.board.tiles)) {
        const action: Action = { type: 'PLACE_UNIT', playerId: unitPlacerId, unitKind, coord: tile.coord }
        if (isLegal(state, action, content)) return action
      }
    }
    return null
  }

  if (state.status !== 'active') return null

  switch (state.roundPhase) {
    case 'selectCards':
    case 'decline': {
      const playerId = state.pendingPlayerIds[0]
      if (!playerId) return null
      const player = state.players.find((candidate) => candidate.id === playerId)
      if (!player) return null
      const cardIds = state.roundPhase === 'selectCards' ? player.handCardIds : [...player.handCardIds, ...player.discardCardIds]
      for (const cardId of cardIds) {
        const action: Action =
          state.roundPhase === 'selectCards' ? { type: 'CHOOSE_CARD', playerId, cardId } : { type: 'MOVE_TO_DECLINE', playerId, cardId }
        if (isLegal(state, action, content)) return action
      }
      return null
    }
    case 'actions':
    case 'purchase': {
      const playerId = state.activePlayerId
      if (!playerId) return null
      const action: Action = state.roundPhase === 'actions' ? { type: 'PASS_ACTIONS', playerId } : { type: 'PASS_PURCHASE', playerId }
      return isLegal(state, action, content) ? action : null
    }
  }
}

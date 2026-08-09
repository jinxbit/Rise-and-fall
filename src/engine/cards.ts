import { appendLog } from './log'
import type { Card, CardZone, GameState, Player } from './types'

/**
 * The six unit kinds, mirroring the ids in src/content/units.json. Kept as a
 * local constant rather than importing the JSON — the engine stays pure
 * data-in/data-out until content wiring is tackled (see content/README.md).
 */
export const UNIT_KINDS = ['city', 'temple', 'nomad', 'merchant', 'mountaineer', 'ship'] as const
export type UnitKind = (typeof UNIT_KINDS)[number]

export function cardIdFor(playerId: string, kind: string): string {
  return `card_${playerId}_${kind}`
}

/**
 * Builds the six cards for a player, one per unit kind. All start in supply
 * — a player has no units on the board yet, so rule 5 applies from the
 * outset. `syncCardZonesWithBoard` moves the relevant ones to hand once
 * starting units are placed.
 */
export function createPlayerCards(playerId: string): Card[] {
  return UNIT_KINDS.map((kind) => ({
    id: cardIdFor(playerId, kind),
    ownerId: playerId,
    kind,
    name: kind,
    description: '',
    effectId: kind,
  }))
}

function zoneIds(player: Player, zone: CardZone): string[] | null {
  switch (zone) {
    case 'hand':
      return player.handCardIds
    case 'discard':
      return player.discardCardIds
    case 'supply':
      return player.supplyCardIds
    case 'decline':
      return player.declineCardIds
    case 'currentlyPlayed':
      return null
  }
}

export function findCardZone(player: Player, cardId: string): CardZone | undefined {
  if (player.currentlyPlayedCardId === cardId) return 'currentlyPlayed'
  if (player.handCardIds.includes(cardId)) return 'hand'
  if (player.discardCardIds.includes(cardId)) return 'discard'
  if (player.supplyCardIds.includes(cardId)) return 'supply'
  if (player.declineCardIds.includes(cardId)) return 'decline'
  return undefined
}

function removeFromZone(player: Player, cardId: string, zone: CardZone): Player {
  if (zone === 'currentlyPlayed') {
    return { ...player, currentlyPlayedCardId: null }
  }
  const ids = zoneIds(player, zone)
  if (!ids) return player
  const field =
    zone === 'hand' ? 'handCardIds' : zone === 'discard' ? 'discardCardIds' : zone === 'supply' ? 'supplyCardIds' : 'declineCardIds'
  return { ...player, [field]: ids.filter((id) => id !== cardId) }
}

function addToZone(player: Player, cardId: string, zone: CardZone): Player {
  if (zone === 'currentlyPlayed') {
    return { ...player, currentlyPlayedCardId: cardId }
  }
  const field =
    zone === 'hand' ? 'handCardIds' : zone === 'discard' ? 'discardCardIds' : zone === 'supply' ? 'supplyCardIds' : 'declineCardIds'
  const ids = zoneIds(player, zone) ?? []
  return { ...player, [field]: [...ids, cardId] }
}

/** Moves a card from whichever zone it's currently in to `toZone`. A no-op if it's already there. */
export function moveCard(player: Player, cardId: string, toZone: CardZone): Player {
  const fromZone = findCardZone(player, cardId)
  if (fromZone === toZone) return player
  const removed = fromZone ? removeFromZone(player, cardId, fromZone) : player
  return addToZone(removed, cardId, toZone)
}

/**
 * Implements rules 5 & 6: a card sits in supply whenever its owner has no
 * unit of that kind on the board, and moves to hand the moment they get
 * their first one. Only actively moves cards between `supply` and `hand` —
 * `decline` is exempt (rule 7, only leaves once bought), and `discard`/
 * `currentlyPlayed` are left alone too: a card there is mid-round-cycle
 * (played this round, or resolving right now) regardless of whether its
 * owner currently has a unit of that kind, and only the round-end recycle
 * (`finishRound` in ./round.ts) or the next play should move it. Call this
 * after anything that changes `state.units`.
 */
export function syncCardZonesWithBoard(state: GameState): GameState {
  const messages: string[] = []

  const players = state.players.map((player) => {
    let nextPlayer = player
    for (const kind of UNIT_KINDS) {
      const id = cardIdFor(player.id, kind)
      if (!state.cards[id]) continue

      const zone = findCardZone(nextPlayer, id)
      if (zone === 'decline' || zone === 'discard' || zone === 'currentlyPlayed') continue

      const hasUnitOnBoard = state.units.some((u) => u.ownerId === player.id && u.kind === kind)

      if (!hasUnitOnBoard && zone !== 'supply') {
        nextPlayer = moveCard(nextPlayer, id, 'supply')
        messages.push(`${player.displayName}'s ${kind} card returned to supply (no units left on the board)`)
      } else if (hasUnitOnBoard && zone === 'supply') {
        nextPlayer = moveCard(nextPlayer, id, 'hand')
        messages.push(`${player.displayName}'s ${kind} card entered their hand (first unit placed)`)
      }
    }
    return nextPlayer
  })

  let nextState: GameState = { ...state, players }
  for (const message of messages) {
    nextState = { ...nextState, log: appendLog(nextState, null, message) }
  }
  return nextState
}

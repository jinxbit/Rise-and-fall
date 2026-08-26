import type { Card, CardZone, GameState, Player } from './types'

/**
 * The six unit kinds, mirroring the ids in src/content/units.json. Kept as a
 * local constant rather than importing the JSON — the engine stays pure
 * data-in/data-out until content wiring is tackled (see content/README.md).
 */
export const UNIT_KINDS = ['city', 'temple', 'nomad', 'merchant', 'mountaineer', 'ship'] as const
export type UnitKind = (typeof UNIT_KINDS)[number]

/**
 * Canonical order for *presenting* cards to a player — hand, decline, and
 * buy-back selection panels. Card ids accumulate in a zone in whatever
 * order units happened to appear on the board (see syncCardZonesWithBoard),
 * so listing them by raw insertion order shows the same six kinds in a
 * different position every time. Sorting by this fixed list instead keeps
 * each kind in the same place across plays. Deliberately separate from
 * UNIT_KINDS, which mirrors content/units.json's order and drives internal
 * zone bookkeeping rather than display.
 */
export const CARD_DISPLAY_ORDER: readonly string[] = ['city', 'nomad', 'ship', 'mountaineer', 'merchant', 'temple']

/** Sorts card ids by CARD_DISPLAY_ORDER so selection UI stays stable regardless of the order cards entered the zone. Unrecognized kinds sort last. */
export function sortCardIdsForDisplay(cardIds: string[], cards: Record<string, Card>): string[] {
  const rank = (id: string) => {
    const index = CARD_DISPLAY_ORDER.indexOf(cards[id]?.kind ?? '')
    return index === -1 ? CARD_DISPLAY_ORDER.length : index
  }
  return [...cardIds].sort((a, b) => rank(a) - rank(b))
}

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
 *
 * `companionKindsByCardKind` (UnitContent.companionKindsByCardKind — e.g.
 * `{ city: ['capital'] }`, `{ temple: ['cathedral'] }`) counts a companion
 * unit as one of its card kind for this purpose too: e.g. a player with a
 * Capital and no plain Cities still keeps their City card in hand rather
 * than losing it back to supply, since the Capital "counts as a normal
 * City" per the Tale rule text. Defaults to empty for callers with no Tale
 * content (or none active).
 */
export function syncCardZonesWithBoard(
  state: GameState,
  companionKindsByCardKind: Record<string, string[]> = {},
): GameState {
  const players = state.players.map((player) => {
    let nextPlayer = player
    for (const kind of UNIT_KINDS) {
      const id = cardIdFor(player.id, kind)
      if (!state.cards[id]) continue

      const zone = findCardZone(nextPlayer, id)
      if (zone === 'decline' || zone === 'discard' || zone === 'currentlyPlayed') continue

      const equivalentKinds = [kind, ...(companionKindsByCardKind[kind] ?? [])]
      const hasUnitOnBoard = state.units.some((u) => u.ownerId === player.id && equivalentKinds.includes(u.kind))

      if (!hasUnitOnBoard && zone !== 'supply') {
        nextPlayer = moveCard(nextPlayer, id, 'supply')
      } else if (hasUnitOnBoard && zone === 'supply') {
        nextPlayer = moveCard(nextPlayer, id, 'hand')
      }
    }
    return nextPlayer
  })

  return { ...state, players }
}

/**
 * Round-end companion to syncCardZonesWithBoard, for the `discard` zone
 * that function deliberately leaves alone (see its doc comment). A player
 * usually plays only one of their six cards a round, leaving the other
 * five in hand — so a played card whose kind loses its last unit mid-round
 * (e.g. Transform [last] Ship into Merchant) sits correctly untouched in
 * `discard` for the rest of that round, but must not be left there
 * indefinitely: rule 5 still says it belongs in `supply`, not `discard`,
 * once nothing backs it. Previously this correction only ever ran as a
 * side effect of `finishRound`'s rule 10/11 recycle (dumping `discard`
 * into an emptied `hand`, then re-syncing) — which meant an unbacked
 * discarded card sat there, wrongly, until its owner happened to empty
 * their *entire* hand through play, which could take several more rounds.
 * Call this at every round end instead, before that recycle step, so the
 * correction isn't gated on it.
 */
export function moveUnbackedDiscardCardsToSupply(
  state: GameState,
  companionKindsByCardKind: Record<string, string[]> = {},
): GameState {
  const players = state.players.map((player) => {
    let nextPlayer = player
    for (const cardId of player.discardCardIds) {
      const card = state.cards[cardId]
      if (!card) continue

      const equivalentKinds = [card.kind, ...(companionKindsByCardKind[card.kind] ?? [])]
      const hasUnitOnBoard = state.units.some((u) => u.ownerId === player.id && equivalentKinds.includes(u.kind))
      if (!hasUnitOnBoard) {
        nextPlayer = moveCard(nextPlayer, cardId, 'supply')
      }
    }
    return nextPlayer
  })

  return { ...state, players }
}

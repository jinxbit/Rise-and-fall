import { useEffect, useState } from 'react'
import { isActionAvailableForUnit, legalConvertTargets, legalCreateTargets, legalTransformTargets } from '../engine/actionTargeting'
import { UNIT_KINDS } from '../engine/cards'
import { legalMoveDestinations } from '../engine/movement'
import { calculatePurchaseCost } from '../engine/purchaseCost'
import type { TurnReview, UnitReviewEvent } from '../engine/turnReview'
import { calculateVPBreakdown } from '../engine/victoryPoints'
import type { VPBreakdown } from '../engine/victoryPoints'
import type { AchievementContent } from '../engine/achievementContent'
import { listAchievements } from '../content/resolveContent'
import type { Card, Coordinate, GameEvent, GameState, Player, Resources, RoundPhase, Unit } from '../engine/types'
import type { UnitAction, UnitContent } from '../engine/unitContent'
import type { PlayerRow } from '../lib/dbTypes'
import type { GhostCell, HistoryArrow, HistoryHaloType, UnitMarker } from './HexBoard'
import { HexBoard } from './HexBoard'
import { UnitIcon } from './UnitIcon'

const ACHIEVEMENTS = listAchievements()

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function playerName(players: PlayerRow[], playerId: string | null): string {
  if (!playerId) return 'nobody'
  return players.find((p) => p.id === playerId)?.display_name ?? playerId
}

function actionNeedsTargeting(effect: UnitAction['effect']): boolean {
  if (effect.actionType === 'create' || effect.actionType === 'convert' || effect.actionType === 'move') return true
  if (effect.actionType === 'transform') return effect.targetHex.location === 'adj'
  return false
}

/**
 * Every one of the player's own units that may act this turn once `card`
 * is played: units of the card's own kind, plus any Tale "companion piece"
 * kind (e.g. Port for Ship — see UnitContent.companionKindsByCardKind)
 * that isn't currently ineligible for having been built this very turn
 * (GameState.unitsCreatedThisTurn — every companion piece the rulebook
 * defines "cannot be activated on the turn it is constructed"). More than
 * one of these can share a single hex (a Ship docked at its own Port), so
 * callers that key UI off "the unit at this hex" need to handle more than
 * one match — see menuUnits below.
 */
function eligibleActingUnits(state: GameState, unitContent: UnitContent, playerId: string, card: Card): Unit[] {
  const companionKinds = unitContent.companionKindsByCardKind[card.kind] ?? []
  return state.units.filter((u) => {
    if (u.ownerId !== playerId) return false
    if (u.kind === card.kind) return true
    if (!companionKinds.includes(u.kind)) return false
    return !state.unitsCreatedThisTurn.includes(u.id)
  })
}

/**
 * `idle`: nothing selected. `menu`: a hex was clicked — every acting unit
 * there (usually one, but a Ship and its own Port can share a hex) shows
 * its action options as a single radial menu, grouped by unit (see
 * HexBoard's ActionMenu doc comment). `targeting`: an action needing a
 * target hex was picked from that menu, for a specific unit — the next
 * legal-hex click on the board resolves it immediately (see onResolveUnit
 * in RoundView below — there's no local staging/submit step; each pick is
 * its own RESOLVE_UNIT_ACTION dispatch, applied right away).
 */
type ActionUiMode = { kind: 'idle' } | { kind: 'menu'; coord: Coordinate } | { kind: 'targeting'; unitId: string; actionId: string }

function PhaseBanner({ state }: { state: GameState }) {
  const phaseLabel: Record<RoundPhase, string> = {
    selectCards: 'Select cards',
    actions: 'Resolve actions',
    decline: 'Decline',
    purchase: 'Purchase',
  }
  return (
    <p className="text-sm text-neutral-400">
      Round {state.turn} — <span className="font-medium text-neutral-200">{phaseLabel[state.roundPhase]}</span>
    </p>
  )
}

/** How much of each resource is left in the shared bank for players to draw from — see GameState.resourceBank. */
function BankResources({ state }: { state: GameState }) {
  return (
    <p className="text-sm text-neutral-400" title="Resources remaining in the shared bank">
      Bank:{' '}
      <span className="font-medium text-neutral-200">
        {state.resourceBank.gold} gold, {state.resourceBank.wood} wood, {state.resourceBank.stone} stone
      </span>
    </p>
  )
}

interface UnitHistorySummary {
  halos: HistoryHaloType[]
  resourceDelta: Partial<Resources>
  moves: HistoryArrow[]
}

/**
 * Groups a TurnReview's flat event list by unit, for HexBoard's overlay
 * props: a 'moved' event becomes an arrow (not a halo); every other event
 * type contributes a halo (deduped — a unit that produced twice still gets
 * one red ring, not two) and, if it carries one, folds its resourceDelta
 * into a single running total per unit (so two produce events in the same
 * window show one combined label, e.g. "+4 Wood" rather than two tags).
 */
function summarizeUnitHistory(events: UnitReviewEvent[]): Map<string, UnitHistorySummary> {
  const byUnit = new Map<string, UnitHistorySummary>()
  for (const event of events) {
    let entry = byUnit.get(event.unitId)
    if (!entry) {
      entry = { halos: [], resourceDelta: {}, moves: [] }
      byUnit.set(event.unitId, entry)
    }
    if (event.type === 'moved') {
      if (event.from && event.to) entry.moves.push({ from: event.from, to: event.to })
      continue
    }
    if ((event.type === 'created' || event.type === 'converted' || event.type === 'produced' || event.type === 'income') && !entry.halos.includes(event.type)) {
      entry.halos.push(event.type)
    }
    if (event.resourceDelta) {
      for (const key of ['gold', 'wood', 'stone'] as const) {
        const amount = event.resourceDelta[key]
        if (amount) entry.resourceDelta[key] = (entry.resourceDelta[key] ?? 0) + amount
      }
    }
  }
  return byUnit
}

const RESOURCE_LABELS: [keyof Resources, string][] = [
  ['gold', 'Gold'],
  ['wood', 'Wood'],
  ['stone', 'Stone'],
]

function formatResourceDelta(delta: Partial<Resources>): string {
  return RESOURCE_LABELS.map(([key, label]) => {
    const amount = delta[key]
    return amount ? `${amount > 0 ? '+' : ''}${amount} ${label}` : null
  })
    .filter((s): s is string => s !== null)
    .join(', ')
}

/** A resource total's change since the reviewed window began, e.g. " (+5)" — blank if it didn't change (or there's nothing to compare against). */
function deltaSuffix(amount: number | undefined): string {
  if (!amount) return ''
  return ` (${amount > 0 ? '+' : ''}${amount})`
}

/** The unit kind each of a set of card ids corresponds to, one entry per card (so a zone with two Cities lists 'city' twice). */
function kindsInZone(cardIds: string[], cards: Record<string, Card>): string[] {
  return cardIds.map((id) => cards[id]?.kind).filter((kind): kind is string => Boolean(kind))
}

/** One small icon per unit kind in `kinds` — the compact, at-a-glance stand-in for what used to be a comma-separated list of kind names. */
function KindIconRow({ kinds, emptyLabel = 'none' }: { kinds: string[]; emptyLabel?: string }) {
  if (kinds.length === 0) return <span className="text-neutral-500">{emptyLabel}</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {kinds.map((kind, i) => (
        <UnitIcon key={i} kind={kind} title={capitalize(kind)} className="h-4 w-4 shrink-0 text-neutral-300" />
      ))}
    </span>
  )
}

/** A unit kind's icon paired with a count, e.g. remaining supply or on-board totals — the icon stands in for the kind name entirely. */
function UnitCountBadge({ kind, count }: { kind: string; count: number }) {
  return (
    <span className="inline-flex items-center gap-1" title={capitalize(kind)}>
      <UnitIcon kind={kind} className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
      <span>{count}</span>
    </span>
  )
}

const VP_BREAKDOWN_LABELS: [keyof Omit<VPBreakdown, 'total'>, string][] = [
  ['achievements', 'Achievements'],
  ['boardCount', 'Board count'],
  ['terrainControl', 'Terrain control'],
  ['gold', 'Gold'],
]

/**
 * The detail view behind clicking a player's chip in PlayersStrip: their
 * full VP breakdown (not just the total shown on the chip), every card zone
 * (hand/currently-played/discard/decline/supply) broken down by unit kind,
 * on-board unit counts per kind, and full resources.
 */
function PlayerDetailPanel({ state, player, breakdown }: { state: GameState; player: Player; breakdown: VPBreakdown | undefined }) {
  const unitCountsByKind = new Map<string, number>()
  for (const unit of state.units) {
    if (unit.ownerId !== player.id) continue
    unitCountsByKind.set(unit.kind, (unitCountsByKind.get(unit.kind) ?? 0) + 1)
  }
  const unitCounts = [...unitCountsByKind.entries()].map(([kind, count]) => ({ kind, count }))
  const currentlyPlayed = player.currentlyPlayedCardId ? kindsInZone([player.currentlyPlayedCardId], state.cards) : []

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
      <div>
        <p className="mb-1 font-medium text-neutral-200">VP breakdown — {breakdown?.total ?? 0} total</p>
        <p>{VP_BREAKDOWN_LABELS.map(([key, label]) => `${label} ${breakdown?.[key] ?? 0}`).join(', ')}</p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium text-neutral-200">Cards</p>
        <p className="flex items-center gap-1.5">
          Hand: <KindIconRow kinds={kindsInZone(player.handCardIds, state.cards)} />
        </p>
        <p className="flex items-center gap-1.5">
          Currently played: <KindIconRow kinds={currentlyPlayed} />
        </p>
        <p className="flex items-center gap-1.5">
          Discard: <KindIconRow kinds={kindsInZone(player.discardCardIds, state.cards)} />
        </p>
        <p className="flex items-center gap-1.5">
          Decline: <KindIconRow kinds={kindsInZone(player.declineCardIds, state.cards)} />
        </p>
        <p className="flex items-center gap-1.5">
          Supply: <KindIconRow kinds={kindsInZone(player.supplyCardIds, state.cards)} />
        </p>
      </div>
      <div>
        <p className="mb-1 font-medium text-neutral-200">Units on board</p>
        {unitCounts.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {unitCounts.map(({ kind, count }) => (
              <UnitCountBadge key={kind} kind={kind} count={count} />
            ))}
          </p>
        ) : (
          <p className="text-neutral-500">none</p>
        )}
      </div>
      <div>
        <p className="mb-1 font-medium text-neutral-200">Resources</p>
        <p>
          Gold {player.resources.gold}, Wood {player.resources.wood}, Stone {player.resources.stone}
        </p>
      </div>
    </div>
  )
}

function PlayersStrip({
  state,
  players,
  myPlayerId,
  unitContent,
  achievementContent,
  resourceDeltaByPlayerId,
}: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  unitContent: UnitContent
  achievementContent: AchievementContent
  /** From TurnReview, only while the history review is toggled on — see RoundView's showHistory. */
  resourceDeltaByPlayerId?: Record<string, Resources> | null
}) {
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)
  const breakdownByPlayerId = calculateVPBreakdown(state, achievementContent)
  const expandedPlayer = expandedPlayerId ? state.players.find((p) => p.id === expandedPlayerId) : null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 text-xs text-neutral-400">
        {state.players.map((player) => {
          const row = players.find((p) => p.id === player.id)
          const handKinds = kindsInZone(player.handCardIds, state.cards)
          const discardKinds = kindsInZone(player.discardCardIds, state.cards)
          const declineKinds = kindsInZone(player.declineCardIds, state.cards)
          const chosenCardId = state.chosenCardIdByPlayerId[player.id]
          const chosenKind = chosenCardId ? state.cards[chosenCardId]?.kind : undefined
          const remainingByKind = UNIT_KINDS.flatMap((kind) => {
            const cap = unitContent.unitSupplyCaps[kind]
            if (cap === undefined) return []
            const onBoard = state.units.filter((u) => u.ownerId === player.id && u.kind === kind).length
            return [{ kind, count: Math.max(0, cap - onBoard) }]
          })
          const delta = resourceDeltaByPlayerId?.[player.id]
          const isExpanded = expandedPlayerId === player.id
          return (
            <button
              type="button"
              key={player.id}
              onClick={() => setExpandedPlayerId((prev) => (prev === player.id ? null : player.id))}
              aria-expanded={isExpanded}
              title="Click for full VP breakdown, cards, unit counts, and resources."
              className={`flex w-full flex-col gap-1 rounded-md border bg-transparent px-2 py-1.5 text-left hover:border-neutral-600 ${
                isExpanded ? 'border-indigo-400' : player.id === myPlayerId ? 'border-indigo-600' : 'border-neutral-800'
              } ${player.eliminated ? 'opacity-40' : ''}`}
            >
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row?.color ?? '#a3a3a3' }} />
                <span className="text-neutral-200">{row?.display_name ?? player.id}</span>
                {state.turnOrder[0] === player.id && (
                  <span title="Start player — rotates to the next player each round" className="text-amber-400">
                    ★
                  </span>
                )}
                {player.eliminated && <span>(eliminated)</span>}
                <span className="ml-auto font-medium text-neutral-200">Score {breakdownByPlayerId[player.id]?.total ?? 0}</span>
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>
                  Gold {player.resources.gold}
                  {delta && <span className="text-emerald-400">{deltaSuffix(delta.gold)}</span>}
                </span>
                <span>
                  Wood {player.resources.wood}
                  {delta && <span className="text-emerald-400">{deltaSuffix(delta.wood)}</span>}
                </span>
                <span>
                  Stone {player.resources.stone}
                  {delta && <span className="text-emerald-400">{deltaSuffix(delta.stone)}</span>}
                </span>
              </span>
              {state.roundPhase === 'actions' && chosenKind && (
                <span className="flex items-center gap-1.5 text-indigo-400" title={`Playing ${capitalize(chosenKind)} this turn`}>
                  <span>Playing</span>
                  <UnitIcon kind={chosenKind} className="h-4 w-4 shrink-0" />
                </span>
              )}
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-1.5">
                  <span>Hand</span>
                  <KindIconRow kinds={handKinds} emptyLabel="empty" />
                </span>
                <span className="flex items-center gap-1.5">
                  <span>Discard</span>
                  <KindIconRow kinds={discardKinds} emptyLabel="empty" />
                </span>
                <span className="flex items-center gap-1.5">
                  <span>Decline</span>
                  <KindIconRow kinds={declineKinds} emptyLabel="empty" />
                </span>
              </span>
              {remainingByKind.length > 0 && (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {remainingByKind.map(({ kind, count }) => (
                    <UnitCountBadge key={kind} kind={kind} count={count} />
                  ))}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {expandedPlayer && <PlayerDetailPanel state={state} player={expandedPlayer} breakdown={breakdownByPlayerId[expandedPlayer.id]} />}
    </div>
  )
}

/**
 * The gold price to buy a card back from decline rises as achievements are
 * claimed (see calculatePurchaseCost) — `current` is that price right now,
 * `upcoming` the remaining steps of achievementContent.purchaseCostTable
 * still ahead, in order.
 */
function purchasePriceLadder(achievementsClaimed: number, costTable: number[]): { current: number; upcoming: number[] } {
  const currentIndex = achievementsClaimed <= 0 ? -1 : Math.min(achievementsClaimed, costTable.length) - 1
  return { current: calculatePurchaseCost(achievementsClaimed, costTable), upcoming: costTable.slice(currentIndex + 1) }
}

/**
 * Every achievement in the game (not just claimed ones), plus the current
 * gold price to buy a card back from decline — grouped together since both
 * move in lockstep with the same number (achievements claimed so far, see
 * calculatePurchaseCost), not because they're otherwise related.
 */
function AchievementsPanel({ state, players, achievementContent }: { state: GameState; players: PlayerRow[]; achievementContent: AchievementContent }) {
  const achievementsClaimed = Object.keys(state.claimedByAchievementId).length
  const { current: buybackPrice, upcoming } = purchasePriceLadder(achievementsClaimed, achievementContent.purchaseCostTable)

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 p-3 text-xs">
      <p className="text-neutral-400">
        Buy back from decline: <span className="font-medium text-amber-400">{buybackPrice} gold</span>
        {upcoming.length > 0 && <span className="text-neutral-500"> — next: {upcoming.join(' → ')} gold</span>}
      </p>
      <div className="flex flex-wrap gap-2">
        {ACHIEVEMENTS.map((achievement) => {
          const claimedBy = state.claimedByAchievementId[achievement.id] ?? null
          return (
            <span
              key={achievement.id}
              title={achievement.description}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${
                claimedBy ? 'border-amber-700/50 bg-amber-500/10 text-amber-400' : 'border-neutral-800 text-neutral-500'
              }`}
            >
              <UnitIcon kind={achievement.unitId} className="h-3.5 w-3.5 shrink-0" />
              <span>
                {achievement.name} ({achievement.victoryPoints} VP) — {claimedBy ? playerName(players, claimedBy) : 'unclaimed'}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

function LogPanel({ gameLog }: { gameLog: GameEvent[] }) {
  const recent = [...gameLog].slice(-8).reverse()
  if (recent.length === 0) return null
  return (
    <div className="flex flex-col gap-1 rounded-md border border-neutral-800 p-3 text-xs text-neutral-500">
      {recent.map((entry) => (
        <p key={entry.id}>{entry.message}</p>
      ))}
    </div>
  )
}

function SelectCardsPanel(props: { state: GameState; players: PlayerRow[]; myPlayerId: string | null; onChooseCard: (cardId: string) => void }) {
  const { state, players, myPlayerId, onChooseCard } = props
  if (!myPlayerId) return null

  if (!state.pendingPlayerIds.includes(myPlayerId)) {
    return <p className="text-sm text-neutral-300">Waiting for: {state.pendingPlayerIds.map((id) => playerName(players, id)).join(', ') || '…'}</p>
  }

  const me = state.players.find((p) => p.id === myPlayerId)
  if (!me) return null

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium text-indigo-400">Your turn — choose a card to play.</p>
      <div className="flex flex-wrap gap-2">
        {me.handCardIds.map((cardId) => {
          const card = state.cards[cardId]
          return (
            <button
              key={cardId}
              onClick={() => onChooseCard(cardId)}
              className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500"
            >
              {card ? capitalize(card.kind) : cardId}
            </button>
          )
        })}
        {me.handCardIds.length === 0 && <p className="text-neutral-500">No cards in hand.</p>}
      </div>
    </div>
  )
}

function ActionsPanel(props: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  unitContent: UnitContent
  onPassActions: () => void
}) {
  const { state, players, myPlayerId, unitContent, onPassActions } = props
  const activePlayerId = state.pendingPlayerIds[0] ?? null
  const isMyTurn = activePlayerId !== null && activePlayerId === myPlayerId

  if (!isMyTurn) {
    return <p className="text-sm text-neutral-300">Waiting for {playerName(players, activePlayerId)} to resolve their action.</p>
  }

  const cardId = myPlayerId ? state.chosenCardIdByPlayerId[myPlayerId] : null
  const card = cardId ? state.cards[cardId] : null
  if (!card || !myPlayerId) return <p className="text-red-400">No chosen card found for this player.</p>

  const actingUnits = eligibleActingUnits(state, unitContent, myPlayerId, card)
  const remaining = actingUnits.filter((u) => !state.resolvedUnitIdsThisTurn.includes(u.id))

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium text-indigo-400">
        Your turn — playing {capitalize(card.kind)}. Click a highlighted unit on the board to choose its action — it
        resolves immediately. {remaining.length} of {actingUnits.length} unit{actingUnits.length === 1 ? '' : 's'} still need
        {remaining.length === 1 ? 's' : ''} one (a unit left alone does nothing this round).
      </p>

      {actingUnits.length === 0 && <p className="text-neutral-500">No units of this kind to act.</p>}

      <div className="flex gap-2">
        <button onClick={onPassActions} className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500">
          {remaining.length > 0 ? `Pass (leave ${remaining.length} idle)` : 'Pass / end turn'}
        </button>
      </div>
    </div>
  )
}

function DeclinePanel(props: { state: GameState; players: PlayerRow[]; myPlayerId: string | null; onMoveToDecline: (cardId: string) => void }) {
  const { state, players, myPlayerId, onMoveToDecline } = props
  if (!myPlayerId) return null

  const owed = state.pendingPlayerIds.filter((id) => id === myPlayerId).length
  if (owed === 0) {
    const stillPending = [...new Set(state.pendingPlayerIds)]
    return <p className="text-sm text-neutral-300">Waiting for: {stillPending.map((id) => playerName(players, id)).join(', ') || '…'}</p>
  }

  const me = state.players.find((p) => p.id === myPlayerId)
  if (!me) return null
  const candidates = [...me.handCardIds, ...me.discardCardIds]

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium text-indigo-400">
        Move {owed} card{owed > 1 ? 's' : ''} to decline.
      </p>
      <div className="flex flex-wrap gap-2">
        {candidates.map((cardId) => {
          const card = state.cards[cardId]
          return (
            <button
              key={cardId}
              onClick={() => onMoveToDecline(cardId)}
              className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500"
            >
              {card ? capitalize(card.kind) : cardId}
            </button>
          )
        })}
        {candidates.length === 0 && <p className="text-neutral-500">Nothing left to decline.</p>}
      </div>
    </div>
  )
}

function PurchasePanel(props: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  achievementContent: AchievementContent
  onPurchaseCard: (cardId: string) => void
  onPassPurchase: () => void
}) {
  const { state, players, myPlayerId, achievementContent, onPurchaseCard, onPassPurchase } = props
  const activePlayerId = state.pendingPlayerIds[0] ?? null
  if (activePlayerId !== myPlayerId) {
    return <p className="text-sm text-neutral-300">Waiting for {playerName(players, activePlayerId)} to buy or pass.</p>
  }

  const me = state.players.find((p) => p.id === myPlayerId)
  if (!me) return null
  const achievementsClaimed = Object.keys(state.claimedByAchievementId).length
  const { current: cost, upcoming } = purchasePriceLadder(achievementsClaimed, achievementContent.purchaseCostTable)

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium text-indigo-400">
        Your turn — buy a card back from decline for <span className="text-amber-400">{cost}</span> gold (you have{' '}
        {me.resources.gold}), or pass.
        {upcoming.length > 0 && (
          <span className="block text-xs font-normal text-neutral-500">Price rises to {upcoming.join(' → ')} gold as more achievements are claimed.</span>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {me.declineCardIds.map((cardId) => {
          const card = state.cards[cardId]
          return (
            <button
              key={cardId}
              disabled={me.resources.gold < cost}
              onClick={() => onPurchaseCard(cardId)}
              className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 disabled:opacity-40"
            >
              {card ? capitalize(card.kind) : cardId}
            </button>
          )
        })}
        <button onClick={onPassPurchase} className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500">
          Pass
        </button>
      </div>
      {me.declineCardIds.length === 0 && <p className="text-neutral-500">Nothing in decline to buy back.</p>}
    </div>
  )
}

export function RoundView(props: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  unitContent: UnitContent
  achievementContent: AchievementContent
  /**
   * "What happened since I last acted" (see engine/turnReview.ts) —
   * GamePage.tsx computes this from the full actionHistory, since it needs
   * genesis + content to replay. Null while it hasn't loaded yet, or if
   * there's nothing to review (e.g. the very start of the game).
   */
  turnReview: TurnReview | null
  showHistory: boolean
  onToggleHistory: () => void
  /** The running narration log — derived from actionHistory, see engine/gameLog.ts's buildGameLog. */
  gameLog: GameEvent[]
  onChooseCard: (cardId: string) => void
  onResolveUnit: (unitId: string, actionId: string, target?: Coordinate) => void
  onPassActions: () => void
  onMoveToDecline: (cardId: string) => void
  onPurchaseCard: (cardId: string) => void
  onPassPurchase: () => void
}) {
  const { state, players, myPlayerId, unitContent, achievementContent, turnReview, showHistory } = props
  const [mode, setMode] = useState<ActionUiMode>({ kind: 'idle' })
  /** Hides the full player roster + achievements sidebar so the board can grow into the freed space — see the "Expand board" toggle below. */
  const [sidebarHidden, setSidebarHidden] = useState(false)

  const turnKey = `${state.turn}:${state.roundPhase}:${state.pendingPlayerIds[0] ?? ''}`
  useEffect(() => {
    setMode({ kind: 'idle' })
  }, [turnKey])

  const isMyActionTurn = state.roundPhase === 'actions' && state.pendingPlayerIds[0] === myPlayerId
  const myChosenCardId = myPlayerId ? state.chosenCardIdByPlayerId[myPlayerId] : null
  const myCard = myChosenCardId ? state.cards[myChosenCardId] : null
  const myActingUnits = isMyActionTurn && myCard && myPlayerId ? eligibleActingUnits(state, unitContent, myPlayerId, myCard) : []
  const availableUnits = myActingUnits.filter((u) => !state.resolvedUnitIdsThisTurn.includes(u.id))

  // Normally exactly one unit (or none), but a hex can hold more than one
  // of the player's own acting units at once — e.g. a Ship docked at its
  // own Port (The Ports Tale) — so the menu covers every acting unit at
  // the clicked hex, each contributing its own kind's actions (see
  // HexBoard's ActionMenu doc comment for how those get grouped visually).
  const menuCoord = mode.kind === 'menu' ? mode.coord : null
  const menuUnits = menuCoord ? availableUnits.filter((u) => u.coord.q === menuCoord.q && u.coord.r === menuCoord.r) : []
  const targetingUnitId = mode.kind === 'targeting' ? mode.unitId : null
  const targetingActionId = mode.kind === 'targeting' ? mode.actionId : null
  const targetingUnit = targetingUnitId ? (myActingUnits.find((u) => u.id === targetingUnitId) ?? null) : null
  const targetingAction = targetingUnit && targetingActionId ? (unitContent.actionsByKind[targetingUnit.kind] ?? []).find((a) => a.id === targetingActionId) : null

  let legalTargets: Coordinate[] = []
  if (targetingUnit && targetingAction && myPlayerId) {
    const effect = targetingAction.effect
    if (effect.actionType === 'create') {
      legalTargets = legalCreateTargets(state, myPlayerId, targetingUnit, effect, unitContent)
    } else if (effect.actionType === 'transform' && effect.targetHex.location === 'adj') {
      legalTargets = legalTransformTargets(state, myPlayerId, targetingUnit, effect, unitContent)
    } else if (effect.actionType === 'convert') {
      legalTargets = legalConvertTargets(state, myPlayerId, targetingUnit, effect, unitContent)
    } else if (effect.actionType === 'move') {
      legalTargets = legalMoveDestinations(state, targetingUnit, targetingUnit.movement, unitContent.terrainLevels)
    }
  }

  function selectAction(unitId: string, actionId: string) {
    if (!myPlayerId) return
    const unit = menuUnits.find((u) => u.id === unitId)
    if (!unit) return
    const action = (unitContent.actionsByKind[unit.kind] ?? []).find((a) => a.id === actionId)
    if (!action) return
    if (!isActionAvailableForUnit(state, myPlayerId, unit, action, unitContent)) return
    if (actionNeedsTargeting(action.effect)) {
      setMode({ kind: 'targeting', unitId: unit.id, actionId })
    } else {
      props.onResolveUnit(unit.id, actionId)
      setMode({ kind: 'idle' })
    }
  }

  function handleBoardClick(coord: Coordinate) {
    if (targetingUnit && targetingAction && legalTargets.some((c) => c.q === coord.q && c.r === coord.r)) {
      props.onResolveUnit(targetingUnit.id, targetingAction.id, coord)
      setMode({ kind: 'idle' })
      return
    }
    const clickedUnits = availableUnits.filter((u) => u.coord.q === coord.q && u.coord.r === coord.r)
    if (clickedUnits.length > 0) {
      setMode((prev) => (prev.kind === 'menu' && prev.coord.q === coord.q && prev.coord.r === coord.r ? { kind: 'idle' } : { kind: 'menu', coord }))
      return
    }
    setMode({ kind: 'idle' })
  }

  const availableUnitIds = new Set(availableUnits.map((u) => u.id))
  const historyByUnit = showHistory && turnReview ? summarizeUnitHistory(turnReview.events) : null
  const units: UnitMarker[] = state.units.map((u) => {
    const history = historyByUnit?.get(u.id)
    return {
      coord: u.coord,
      color: players.find((p) => p.id === u.ownerId)?.color ?? '#a3a3a3',
      kind: u.kind,
      highlighted: isMyActionTurn && availableUnitIds.has(u.id),
      historyHalos: history?.halos,
      historyLabel: history && Object.keys(history.resourceDelta).length > 0 ? formatResourceDelta(history.resourceDelta) : undefined,
    }
  })
  const historyArrows: HistoryArrow[] = historyByUnit ? [...historyByUnit.values()].flatMap((h) => h.moves) : []

  const ghostCells: GhostCell[] = legalTargets.map((coord) => ({ coord, legal: true }))
  const actionMenu =
    menuCoord && menuUnits.length > 0 && myPlayerId
      ? {
          coord: menuCoord,
          options: menuUnits.flatMap((unit) =>
            (unitContent.actionsByKind[unit.kind] ?? []).map((a) => ({
              unitId: unit.id,
              unitKind: capitalize(unit.kind),
              id: a.id,
              label: a.name,
              disabled: !isActionAvailableForUnit(state, myPlayerId, unit, a, unitContent),
            })),
          ),
          onSelect: selectAction,
        }
      : undefined

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <PhaseBanner state={state} />
          <BankResources state={state} />
        </div>
        <div className="flex items-center gap-2">
          {showHistory && turnReview && turnReview.events.length === 0 && (
            <span className="text-xs text-neutral-500">Nothing since your last turn.</span>
          )}
          <button
            type="button"
            onClick={props.onToggleHistory}
            disabled={!turnReview}
            title="Review what happened on the board since your last turn — movement, new units, resources gathered, income, trades, and conversions."
            className="rounded-md border border-neutral-700 px-3 py-1 text-xs hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {showHistory ? 'Hide history' : 'Show history'}
          </button>
        </div>
      </div>
      {state.roundPhase === 'selectCards' && (
        <SelectCardsPanel state={state} players={players} myPlayerId={myPlayerId} onChooseCard={props.onChooseCard} />
      )}
      {state.roundPhase === 'actions' && (
        <ActionsPanel state={state} players={players} myPlayerId={myPlayerId} unitContent={unitContent} onPassActions={props.onPassActions} />
      )}
      {state.roundPhase === 'decline' && (
        <DeclinePanel state={state} players={players} myPlayerId={myPlayerId} onMoveToDecline={props.onMoveToDecline} />
      )}
      {state.roundPhase === 'purchase' && (
        <PurchasePanel
          state={state}
          players={players}
          myPlayerId={myPlayerId}
          achievementContent={achievementContent}
          onPurchaseCard={props.onPurchaseCard}
          onPassPurchase={props.onPassPurchase}
        />
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="relative min-w-0 flex-1">
          <HexBoard
            board={state.board}
            units={units}
            arrows={historyArrows}
            ghostCells={ghostCells}
            actionMenu={actionMenu}
            interactive={isMyActionTurn}
            onHexClick={isMyActionTurn ? handleBoardClick : undefined}
            expanded={sidebarHidden}
          />
          {/* Overlaid on the board's own corner rather than a separate row above it — a standard collapse/expand chevron, flipping direction with sidebarHidden. */}
          <button
            type="button"
            onClick={() => setSidebarHidden((v) => !v)}
            aria-label={sidebarHidden ? 'Collapse board' : 'Expand board'}
            title={
              sidebarHidden
                ? 'Bring back the full player roster and achievements panel beside the board.'
                : 'Hide the full player roster and achievements panel so the board can expand into that space.'
            }
            className="absolute right-2 top-2 z-10 rounded-full border border-neutral-700 bg-neutral-900/80 p-1.5 hover:border-neutral-500"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {sidebarHidden ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
            </svg>
          </button>
        </div>
        {/* Sits beside the board (not below it) so the full roster and achievements stay in view without scrolling past the map — see PlayersStrip/AchievementsPanel's icon-based, per-player-card layout, built for this narrower column. Hideable (see the chevron button overlaid on the board's corner) so the board can grow into this space instead. */}
        {!sidebarHidden && (
          <div className="flex w-full flex-col gap-4 lg:w-72 lg:shrink-0 xl:w-80">
            <PlayersStrip
              state={state}
              players={players}
              myPlayerId={myPlayerId}
              unitContent={unitContent}
              achievementContent={achievementContent}
              resourceDeltaByPlayerId={showHistory ? turnReview?.resourceDeltaByPlayerId : null}
            />
            <AchievementsPanel state={state} players={players} achievementContent={achievementContent} />
          </div>
        )}
      </div>

      <LogPanel gameLog={props.gameLog} />
    </div>
  )
}

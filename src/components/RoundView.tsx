import { Fragment, useEffect, useRef, useState } from 'react'
import {
  boostedStateForSupport,
  computeActionOutcomePreview,
  computeActionShortfall,
  findSupportCandidates,
  isActionAvailableForUnit,
  isActionSupportable,
  legalConvertTargets,
  legalCreateTargets,
  legalTransformTargets,
  neededSupportCandidates,
} from '../engine/actionTargeting'
import { sortCardIdsForDisplay, UNIT_KINDS } from '../engine/cards'
import { legalMoveDestinations } from '../engine/movement'
import { calculatePurchaseCost } from '../engine/purchaseCost'
import type { TurnReview, UnitReviewEvent } from '../engine/turnReview'
import { calculateVPBreakdown } from '../engine/victoryPoints'
import type { VPBreakdown } from '../engine/victoryPoints'
import type { AchievementContent } from '../engine/achievementContent'
import type { TaleContent } from '../engine/taleContent'
import { listAchievements } from '../content/resolveContent'
import type { Card, Coordinate, GameEvent, GameState, Player, Resources, RoundPhase, Unit } from '../engine/types'
import type { UnitAction, UnitContent } from '../engine/unitContent'
import type { PlayerRow } from '../lib/dbTypes'
import type { GhostCell, HistoryArrow, HistoryHaloType, UnitMarker } from './HexBoard'
import { HexBoard } from './HexBoard'
import { ResourceIcon } from './ResourceIcon'
import { RESOURCE_COLOR_CLASS } from './resourceIcons'
import { UnitIcon } from './UnitIcon'

const RESOURCE_ORDER: (keyof Resources)[] = ['gold', 'wood', 'stone']

const ACHIEVEMENTS = listAchievements()

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function playerName(players: PlayerRow[], playerId: string | null): string {
  if (!playerId) return 'nobody'
  return players.find((p) => p.id === playerId)?.display_name ?? playerId
}

/** Whether `unit` still has an activation left this turn — usually just "hasn't acted yet," but a Tale companion may act more than once (e.g. The Capital Tale's Capital: unitContent.activationsPerTurnByKind.capital === 2) — see applyResolveUnitAction's matching cap check (engine/applyAction.ts). */
function hasRemainingActivation(state: GameState, unitContent: UnitContent, unit: Unit): boolean {
  const cap = unitContent.activationsPerTurnByKind[unit.kind] ?? 1
  return state.resolvedUnitIdsThisTurn.filter((id) => id === unit.id).length < cap
}

function actionNeedsTargeting(effect: UnitAction['effect']): boolean {
  if (effect.actionType === 'create' || effect.actionType === 'convert' || effect.actionType === 'move') return true
  if (effect.actionType === 'transform') return effect.targetHex.location === 'adj'
  return false
}

/** Every legal target hex for `action`, against whatever `state` is passed — shared by RoundView's normal legal-target preview and, for a supported action, its "would this target still be legal once support units produced" confirm check (same query, just against a boosted hypothetical state — see boostedStateForSupport). Empty for a no-target action (see actionNeedsTargeting). */
function computeLegalTargets(state: GameState, playerId: string, unit: Unit, action: UnitAction, unitContent: UnitContent): Coordinate[] {
  const effect = action.effect
  if (effect.actionType === 'create') return legalCreateTargets(state, playerId, unit, effect, unitContent)
  if (effect.actionType === 'transform' && effect.targetHex.location === 'adj') return legalTransformTargets(state, playerId, unit, effect, unitContent)
  if (effect.actionType === 'convert') return legalConvertTargets(state, playerId, unit, effect, unitContent)
  if (effect.actionType === 'move') return legalMoveDestinations(state, unit, unit.movement, unitContent.terrainLevels)
  return []
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
 * its own RESOLVE_UNIT_ACTION dispatch, applied right away), UNLESS the
 * action was only reachable by support (see `supporting` below), in which
 * case picking a target moves to that mode instead of resolving.
 * `supporting`: the player picked an action they can't currently afford,
 * chose (or skipped, for a no-target action) a target, and is now clicking
 * idle same-kind units highlighted on the map to cover the shortfall (issue
 * #147's "supporting actions" QoL request) — only units whose own
 * production would still help close the remaining gap are highlighted (see
 * neededSupportCandidates), and each click resolves immediately once the
 * cumulative selection covers the cost, same as every other action; no
 * separate confirm step. Clicking anywhere that isn't a currently-needed
 * candidate cancels the whole thing, same as every other in-progress action
 * pick.
 */
type ActionUiMode =
  | { kind: 'idle' }
  | { kind: 'menu'; coord: Coordinate }
  | { kind: 'targeting'; unitId: string; actionId: string }
  | { kind: 'supporting'; unitId: string; actionId: string; target?: Coordinate; selectedSupportUnitIds: string[] }

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
    <p className="flex items-center gap-2 text-sm text-neutral-400" title="Resources remaining in the shared bank">
      Bank:
      {RESOURCE_ORDER.map((key) => (
        <span key={key} className={`flex items-center gap-1 font-medium ${RESOURCE_COLOR_CLASS[key]}`} title={capitalize(key)}>
          <ResourceIcon resource={key} className="h-4 w-4 shrink-0" />
          {state.resourceBank[key]}
        </span>
      ))}
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

/**
 * The icon+colour rendering of a resource outcome (see resourceIcons.ts's
 * RESOURCE_ICONS/RESOURCE_COLOR_CLASS) — one badge per affected resource,
 * e.g. a gold coin icon in gold next to "+1", a plank icon in brown next to
 * "+2". Mirrors HexBoard's per-unit ActionMenuOption.outcome rendering so a
 * bulk-action button's aggregated outcome reads the same way as the radial
 * menu's per-unit preview it's replacing (see the trigger comment on issue
 * #61: "describe the outcome using iconography and colors").
 */
function ResourceOutcomeBadges({ outcome, className = '' }: { outcome: Partial<Resources>; className?: string }) {
  const entries = RESOURCE_ORDER.filter((key) => outcome[key])
  if (entries.length === 0) return null
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {entries.map((key) => {
        const amount = outcome[key]!
        const label = RESOURCE_LABELS.find(([k]) => k === key)![1]
        return (
          <span key={key} className={`inline-flex items-center gap-0.5 font-bold ${RESOURCE_COLOR_CLASS[key]}`}>
            <ResourceIcon resource={key} title={label} className="h-3.5 w-3.5 shrink-0" />
            {amount > 0 ? '+' : ''}
            {amount}
          </span>
        )
      })}
    </span>
  )
}

/** A resource total's change since the reviewed window began, e.g. " (+5)" — blank if it didn't change (or there's nothing to compare against). */
function deltaSuffix(amount: number | undefined): string {
  if (!amount) return ''
  return ` (${amount > 0 ? '+' : ''}${amount})`
}

/** The unit kind each of a set of card ids corresponds to, in display order, one entry per card (so a zone with two Cities lists 'city' twice). */
function kindsInZone(cardIds: string[], cards: Record<string, Card>): string[] {
  return sortCardIdsForDisplay(cardIds, cards)
    .map((id) => cards[id]?.kind)
    .filter((kind): kind is string => Boolean(kind))
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
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {RESOURCE_ORDER.map((key) => (
            <span key={key} className={`flex items-center gap-1 font-medium ${RESOURCE_COLOR_CLASS[key]}`} title={capitalize(key)}>
              <ResourceIcon resource={key} className="h-3.5 w-3.5 shrink-0" />
              {player.resources[key]}
            </span>
          ))}
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
  taleContent,
  resourceDeltaByPlayerId,
}: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  unitContent: UnitContent
  achievementContent: AchievementContent
  taleContent: TaleContent
  /** From TurnReview, only while the history review is toggled on — see RoundView's showHistory. */
  resourceDeltaByPlayerId?: Record<string, Resources> | null
}) {
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null)
  const breakdownByPlayerId = calculateVPBreakdown(state, achievementContent, taleContent)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 text-xs text-neutral-400">
        {state.players.map((player) => {
          const row = players.find((p) => p.id === player.id)
          const chosenCardId = state.chosenCardIdByPlayerId[player.id]
          // The chosen card's kind (and its "Playing" indicator) is only
          // revealed once the actions phase begins for that player's turn.
          // During selectCards it's still a secret simultaneous pick, so
          // don't show it as "Playing" or drop it from the hand display.
          const chosenKind = state.roundPhase === 'actions' && chosenCardId ? state.cards[chosenCardId]?.kind : undefined
          // Chosen-but-not-yet-resolved card stays in handCardIds until the
          // player's turn finishes (finishActionsTurn moves it hand ->
          // currentlyPlayed -> discard). Once the actions phase reveals it
          // as "Playing", hide it from the hand display to avoid showing it
          // as both "Playing" and still in hand.
          const handKinds = kindsInZone(
            state.roundPhase === 'actions' ? player.handCardIds.filter((id) => id !== chosenCardId) : player.handCardIds,
            state.cards,
          )
          const discardKinds = kindsInZone(player.discardCardIds, state.cards)
          const declineKinds = kindsInZone(player.declineCardIds, state.cards)
          const remainingByKind = UNIT_KINDS.flatMap((kind) => {
            const cap = unitContent.unitSupplyCaps[kind]
            if (cap === undefined) return []
            const onBoard = state.units.filter((u) => u.ownerId === player.id && u.kind === kind).length
            return [{ kind, count: Math.max(0, cap - onBoard) }]
          })
          const delta = resourceDeltaByPlayerId?.[player.id]
          const isExpanded = expandedPlayerId === player.id
          return (
            <Fragment key={player.id}>
              <button
                type="button"
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
                  {RESOURCE_ORDER.map((key) => (
                    <span key={key} className={`flex items-center gap-1 font-medium ${RESOURCE_COLOR_CLASS[key]}`} title={capitalize(key)}>
                      <ResourceIcon resource={key} className="h-3.5 w-3.5 shrink-0" />
                      {player.resources[key]}
                      {delta && <span className="text-emerald-400">{deltaSuffix(delta[key])}</span>}
                    </span>
                  ))}
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
              {isExpanded && <PlayerDetailPanel state={state} player={player} breakdown={breakdownByPlayerId[player.id]} />}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The gold price to buy a card back from decline rises as achievements are
 * claimed (see calculatePurchaseCost) — `current` is that price right now,
 * `upcoming` the remaining steps of achievementContent.purchaseCostTable
 * still ahead, in order, capped at `gameLength` steps: the game ends once
 * that many achievements are claimed in total, so a price past that point
 * is never actually reached. `isCurrentFinal` flags whether `current`
 * itself is the price for the gameLength-th achievement — the last
 * purchase phase before the game ends; otherwise (when `upcoming` is
 * non-empty) that same price is always `upcoming`'s last entry, by
 * construction of the cap above.
 */
function purchasePriceLadder(
  achievementsClaimed: number,
  costTable: number[],
  gameLength: number,
): { current: number; upcoming: number[]; isCurrentFinal: boolean } {
  const currentIndex = achievementsClaimed <= 0 ? -1 : Math.min(achievementsClaimed, costTable.length) - 1
  const cappedLength = Number.isFinite(gameLength) ? Math.min(gameLength, costTable.length) : costTable.length
  return {
    current: calculatePurchaseCost(achievementsClaimed, costTable),
    upcoming: costTable.slice(currentIndex + 1, cappedLength),
    isCurrentFinal: achievementsClaimed > 0 && currentIndex + 1 >= cappedLength,
  }
}

/**
 * Every achievement in the game (not just claimed ones), plus the current
 * gold price to buy a card back from decline — grouped together since both
 * move in lockstep with the same number (achievements claimed so far, see
 * calculatePurchaseCost), not because they're otherwise related.
 */
function AchievementsPanel({
  state,
  players,
  achievementContent,
  taleContent,
}: {
  state: GameState
  players: PlayerRow[]
  achievementContent: AchievementContent
  taleContent: TaleContent
}) {
  const achievementsClaimed = Object.keys(state.claimedByAchievementId).length
  const { current: buybackPrice, upcoming, isCurrentFinal } = purchasePriceLadder(
    achievementsClaimed,
    achievementContent.purchaseCostTable,
    achievementContent.gameLength,
  )
  const gameLength = achievementContent.gameLength

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 p-3 text-xs">
      {Number.isFinite(gameLength) && (
        <p className="text-neutral-500">
          {achievementsClaimed} of {gameLength} achievements claimed
        </p>
      )}
      <p className="text-neutral-400">
        Buy back from decline:{' '}
        <span className={`font-medium ${isCurrentFinal ? 'text-red-400' : 'text-amber-400'}`}>
          {buybackPrice} gold{isCurrentFinal && ' (last round)'}
        </span>
        {upcoming.length > 0 && (
          <span className="text-neutral-500">
            {' '}
            — next:{' '}
            {upcoming.map((price, i) => (
              <span key={i} className={i === upcoming.length - 1 ? 'font-medium text-red-400' : undefined}>
                {i > 0 && ' → '}
                {price}
              </span>
            ))}{' '}
            gold (last round: {upcoming[upcoming.length - 1]})
          </span>
        )}
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
        {/* A Tale-contributed real Trophy (e.g. The Capital) — claimed
            permanently through the exact same pipeline as a base achievement
            above (see TaleExtraAchievement's doc comment), just sourced from
            taleContent instead of the static achievements.json list. */}
        {taleContent.extraAchievements.map((achievement) => {
          const claimedBy = state.claimedByAchievementId[achievement.id] ?? null
          return (
            <span
              key={achievement.id}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${
                claimedBy ? 'border-amber-700/50 bg-amber-500/10 text-amber-400' : 'border-neutral-800 text-neutral-500'
              }`}
            >
              <UnitIcon kind={achievement.unitKind} className="h-3.5 w-3.5 shrink-0" />
              <span>
                {capitalize(achievement.unitKind)} ({achievement.victoryPoints} VP) — {claimedBy ? playerName(players, claimedBy) : 'unclaimed'}
              </span>
            </span>
          )
        })}
      </div>
      {taleContent.controllableStructures.length > 0 && (
        <>
          {/* Not real achievements — Tale-contributed bonuses that don't correspond to any content/achievements.json entry, and (unlike a real achievement) whoever holds one can change over the course of the game — see TaleControllableStructure's doc comment. Kept in its own section so it's never confused with a permanent claim. */}
          <p className="mt-1 text-neutral-500">Tale bonuses (claimable)</p>
          <div className="flex flex-wrap gap-2">
            {taleContent.controllableStructures.map((structure) => {
              const controller = state.units.find((u) => u.kind === structure.kind)
              return (
                <span
                  key={structure.kind}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 ${
                    controller ? 'border-amber-700/50 bg-amber-500/10 text-amber-400' : 'border-neutral-800 text-neutral-500'
                  }`}
                >
                  <UnitIcon kind={structure.kind} className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {structure.name} ({structure.victoryPoints} VP) — {controller ? playerName(players, controller.ownerId) : 'unclaimed'}
                  </span>
                </span>
              )
            })}
          </div>
        </>
      )}
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
  const me = myPlayerId ? state.players.find((p) => p.id === myPlayerId) : undefined
  const isPending = !!myPlayerId && state.pendingPlayerIds.includes(myPlayerId)
  const handCardIds = me ? sortCardIdsForDisplay(me.handCardIds, state.cards) : []
  const onlyCardId = isPending && handCardIds.length === 1 ? handCardIds[0] : null

  // A hand with only one card isn't really a choice, so play it
  // automatically instead of making the player click it. autoChosenRef
  // guards against re-submitting: onChooseCard is a fresh function identity
  // on every parent render, so a plain effect dependency would refire on
  // every re-render between submitting and the resulting state update
  // clearing `isPending`.
  const autoChosenRef = useRef<string | null>(null)
  useEffect(() => {
    if (onlyCardId && autoChosenRef.current !== onlyCardId) {
      autoChosenRef.current = onlyCardId
      onChooseCard(onlyCardId)
    }
  }, [onlyCardId, onChooseCard])

  if (!myPlayerId) return null

  if (!isPending) {
    return <p className="text-sm text-neutral-300">Waiting for: {state.pendingPlayerIds.map((id) => playerName(players, id)).join(', ') || '…'}</p>
  }

  if (!me) return null
  if (onlyCardId) return null // auto-chosen above; nothing to render while the submission is in flight

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium text-indigo-400">Your turn — choose a card to play.</p>
      <div className="flex flex-wrap gap-2">
        {handCardIds.map((cardId) => {
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
        {handCardIds.length === 0 && <p className="text-neutral-500">No cards in hand.</p>}
      </div>
    </div>
  )
}

interface BulkActionGroup {
  kind: string
  actionId: string
  label: string
  unitIds: string[]
  /** Sum of computeActionOutcomePreview across every unit in the group — e.g. two idle Forest Nomads' Produce Resource combine into `{ wood: 2 }`. */
  outcome: Partial<Resources>
}

/**
 * Every no-target action (see actionNeedsTargeting) at least one of
 * `remaining`'s units can currently take, grouped by unit kind + action id
 * — e.g. every idle Nomad/Mountaineer's Produce Resource, or every idle
 * Ship/Merchant/City/Temple's trade/income action (issue #61). Drives the
 * "act on everyone at once" buttons in ActionsPanel below, so a player
 * doesn't have to click through each unit individually on the board for an
 * action that never needed a target hex in the first place. Each group's
 * `outcome` is the aggregated resource preview across its units (see
 * computeActionOutcomePreview), shown on the button alongside the count.
 *
 * Self-targeted transforms (e.g. Nomad/Mountaineer's Transform to City or
 * Temple) are excluded even though they need no target: they permanently
 * destroy the acting unit and turn it into a different, immobile kind, so
 * batching every remaining unit into one irreversible click would be far
 * too easy to trigger by accident (issue #201) — unlike Produce Resource or
 * a trade action, which the player would happily repeat unit-by-unit anyway.
 */
function computeBulkActionGroups(state: GameState, unitContent: UnitContent, playerId: string, remaining: Unit[]): BulkActionGroup[] {
  const groups = new Map<string, BulkActionGroup>()
  for (const unit of remaining) {
    for (const action of unitContent.actionsByKind[unit.kind] ?? []) {
      if (actionNeedsTargeting(action.effect)) continue
      if (action.effect.actionType === 'transform' && action.effect.destroySelf) continue
      if (!isActionAvailableForUnit(state, playerId, unit, action, unitContent)) continue
      const key = `${unit.kind}:${action.id}`
      let group = groups.get(key)
      if (!group) {
        group = { kind: unit.kind, actionId: action.id, label: action.name, unitIds: [], outcome: {} }
        groups.set(key, group)
      }
      group.unitIds.push(unit.id)
      const unitOutcome = computeActionOutcomePreview(state, playerId, unit, action)
      if (unitOutcome) {
        for (const resourceKey of RESOURCE_ORDER) {
          const amount = unitOutcome[resourceKey]
          if (amount) group.outcome[resourceKey] = (group.outcome[resourceKey] ?? 0) + amount
        }
      }
    }
  }
  return [...groups.values()]
}

function ActionsPanel(props: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  unitContent: UnitContent
  onPassActions: () => void
  onResolveBulkAction: (unitIds: string[], actionId: string) => void
}) {
  const { state, players, myPlayerId, unitContent, onPassActions, onResolveBulkAction } = props
  const activePlayerId = state.pendingPlayerIds[0] ?? null
  const isMyTurn = activePlayerId !== null && activePlayerId === myPlayerId

  if (!isMyTurn) {
    return <p className="text-sm text-neutral-300">Waiting for {playerName(players, activePlayerId)} to resolve their action.</p>
  }

  const cardId = myPlayerId ? state.chosenCardIdByPlayerId[myPlayerId] : null
  const card = cardId ? state.cards[cardId] : null
  if (!card || !myPlayerId) return <p className="text-red-400">No chosen card found for this player.</p>

  const actingUnits = eligibleActingUnits(state, unitContent, myPlayerId, card)
  const remaining = actingUnits.filter((u) => hasRemainingActivation(state, unitContent, u))
  const bulkGroups = computeBulkActionGroups(state, unitContent, myPlayerId, remaining)

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium text-indigo-400">
        Your turn — playing {capitalize(card.kind)}. Click a highlighted unit on the board to choose its action — it
        resolves immediately. {remaining.length} of {actingUnits.length} unit{actingUnits.length === 1 ? '' : 's'} still need
        {remaining.length === 1 ? 's' : ''} one (a unit left alone does nothing this round).
      </p>

      {actingUnits.length === 0 && <p className="text-neutral-500">No units of this kind to act.</p>}

      {bulkGroups.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {bulkGroups.map((group) => (
            <button
              key={`${group.kind}:${group.actionId}`}
              onClick={() => onResolveBulkAction(group.unitIds, group.actionId)}
              title={`Apply "${group.label}" to every remaining ${capitalize(group.kind)} that can currently take it, without picking each one individually on the board.`}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500"
            >
              <span>
                {group.label} — all ({group.unitIds.length})
              </span>
              <ResourceOutcomeBadges outcome={group.outcome} />
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onPassActions} className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500">
          {remaining.length > 0 ? `Pass (leave ${remaining.length} idle)` : 'Pass / end turn'}
        </button>
      </div>
    </div>
  )
}

/**
 * Shown while the player is picking which idle same-kind units cover the
 * shortfall for an action they can't currently afford (issue #147) — see
 * ActionUiMode's `supporting` variant. No buttons here: the pickable units
 * are highlighted directly on the map (HexBoard's UnitMarker.supportCandidate),
 * and clicking one resolves immediately once the selection covers the cost —
 * this is just the status line explaining what's happening and how to back
 * out. `neededCandidateCount` is the currently-highlighted set (see
 * neededSupportCandidates), which shrinks as the player covers each
 * resource, so "no one left to help" only ever reflects what's still short.
 */
function SupportHint({ actingUnitKind, actionLabel, neededCandidateCount }: { actingUnitKind: string; actionLabel: string; neededCandidateCount: number }) {
  return (
    <p className="text-sm font-medium text-amber-400">
      Not enough resources for {capitalize(actingUnitKind)}&rsquo;s &ldquo;{actionLabel}&rdquo; — click a highlighted idle {capitalize(actingUnitKind)}
      {actingUnitKind.endsWith('s') ? '' : 's'} on the map to help cover it. Click elsewhere to cancel.
      {neededCandidateCount === 0 && <span className="block font-normal text-neutral-500">No idle units are available to help.</span>}
    </p>
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
  const candidates = sortCardIdsForDisplay([...me.handCardIds, ...me.discardCardIds], state.cards)

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
              className="rounded-md border border-red-700 px-3 py-1 hover:border-red-500"
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
  const { current: cost, upcoming } = purchasePriceLadder(achievementsClaimed, achievementContent.purchaseCostTable, achievementContent.gameLength)
  const declineCardIds = sortCardIdsForDisplay(me.declineCardIds, state.cards)

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
        {declineCardIds.map((cardId) => {
          const card = state.cards[cardId]
          return (
            <button
              key={cardId}
              disabled={me.resources.gold < cost}
              onClick={() => onPurchaseCard(cardId)}
              className="rounded-md border border-amber-500 px-3 py-1 hover:border-amber-300 disabled:opacity-40"
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
  /** Drives the achievements panel's "Tale bonuses" section and its contribution to each player's live score (see calculateVPBreakdown) — EMPTY_TALE_CONTENT for a game with no Tales active. */
  taleContent: TaleContent
  /**
   * What happened during the single turn currently shown by GamePage's
   * "Show history" bar (issue #261) — see engine/turnReview.ts's
   * `buildTurnReview`. GamePage computes this fresh for whichever turn its
   * bar is currently positioned on (it owns the Prev/Next/slider controls
   * and the underlying historical-replay cache), diffing the real,
   * previously-replayed board state from just before that turn against just
   * after it — so the halos/arrows below always match the historical board
   * actually shown in `state` (not the live board). Null while "Show
   * history" isn't active, or while GamePage's own "Review history"
   * (action-by-action) mode is active instead.
   */
  turnReview: TurnReview | null
  /**
   * True while GamePage is showing a replayed historical state instead of
   * the live game — either via "Review history" (action-by-action) or "Show
   * history" (turn-by-turn, with `turnReview` set). Hides every panel that
   * would otherwise let the (non-existent, in review) `myPlayerId` act.
   */
  showHistory: boolean
  /** The running narration log — derived from actionHistory, see engine/gameLog.ts's buildGameLog. */
  gameLog: GameEvent[]
  onChooseCard: (cardId: string) => void
  onResolveUnit: (unitId: string, actionId: string, target?: Coordinate) => void
  /** Resolves the same no-target action (see actionNeedsTargeting) for every listed unit id in one submission — see ActionsPanel's bulk-action buttons (issue #61). */
  onResolveBulkAction: (unitIds: string[], actionId: string) => void
  /**
   * Resolves a "supporting actions" pick (issue #147): the chosen idle
   * same-kind units' resource-gathering actions, in order, immediately
   * followed by the primary unit's action — one RESOLVE_UNIT_ACTION
   * submission, so the support units' resources are already banked by the
   * time the primary action's cost is checked (see UnitActionAssignment's
   * doc comment, ../engine/actions.ts).
   */
  onResolveSupportedAction: (supportAssignments: { unitId: string; actionId: string }[], primary: { unitId: string; actionId: string; target?: Coordinate }) => void
  onPassActions: () => void
  onMoveToDecline: (cardId: string) => void
  onPurchaseCard: (cardId: string) => void
  onPassPurchase: () => void
}) {
  const { state, players, myPlayerId, unitContent, achievementContent, taleContent, turnReview, showHistory } = props
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
  const availableUnits = myActingUnits.filter((u) => hasRemainingActivation(state, unitContent, u))

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
  // Whether the picked action is affordable right this instant — when it
  // isn't (but isActionSupportable said yes), legal targets are previewed
  // against a hypothetical boosted state (see boostedStateForSupport) so the
  // player can still pick where the action will land; the real resolve only
  // happens once support units are chosen and confirmed (see the
  // 'supporting' branch of handleBoardClick below).
  const targetingActionAvailableNow = !!(targetingUnit && targetingAction && myPlayerId && isActionAvailableForUnit(state, myPlayerId, targetingUnit, targetingAction, unitContent))
  const targetingSupportCandidates =
    targetingUnit && targetingAction && myPlayerId && !targetingActionAvailableNow ? findSupportCandidates(state, myPlayerId, targetingUnit, unitContent) : []

  let legalTargets: Coordinate[] = []
  if (targetingUnit && targetingAction && myPlayerId) {
    const legalTargetsState = targetingActionAvailableNow ? state : boostedStateForSupport(state, myPlayerId, targetingSupportCandidates)
    legalTargets = computeLegalTargets(legalTargetsState, myPlayerId, targetingUnit, targetingAction, unitContent)
  }

  // 'supporting' mode's acting unit/action/candidates — recomputed fresh
  // against the real (not-yet-boosted) `state`, since nothing has actually
  // been submitted yet at this point (see ActionUiMode's doc comment).
  const supportingUnitId = mode.kind === 'supporting' ? mode.unitId : null
  const supportingActionId = mode.kind === 'supporting' ? mode.actionId : null
  const supportingTarget = mode.kind === 'supporting' ? mode.target : undefined
  const supportingSelectedIds = mode.kind === 'supporting' ? mode.selectedSupportUnitIds : []
  const supportingUnit = supportingUnitId ? (myActingUnits.find((u) => u.id === supportingUnitId) ?? null) : null
  const supportingAction = supportingUnit && supportingActionId ? (unitContent.actionsByKind[supportingUnit.kind] ?? []).find((a) => a.id === supportingActionId) : null
  const supportingCandidates = supportingUnit && myPlayerId ? findSupportCandidates(state, myPlayerId, supportingUnit, unitContent) : []
  const supportingSelectedCandidates = supportingCandidates.filter((c) => supportingSelectedIds.includes(c.unit.id))
  const supportingNeededCandidates =
    supportingUnit && supportingAction && myPlayerId
      ? neededSupportCandidates(state, myPlayerId, supportingUnit, supportingAction, supportingCandidates, supportingSelectedCandidates)
      : []

  function selectAction(unitId: string, actionId: string) {
    if (!myPlayerId) return
    const unit = menuUnits.find((u) => u.id === unitId)
    if (!unit) return
    const action = (unitContent.actionsByKind[unit.kind] ?? []).find((a) => a.id === actionId)
    if (!action) return
    const availableNow = isActionAvailableForUnit(state, myPlayerId, unit, action, unitContent)
    if (!availableNow && !isActionSupportable(state, myPlayerId, unit, action, unitContent)) return
    if (actionNeedsTargeting(action.effect)) {
      setMode({ kind: 'targeting', unitId: unit.id, actionId })
    } else if (availableNow) {
      props.onResolveUnit(unit.id, actionId)
      setMode({ kind: 'idle' })
    } else {
      // No target to pick — go straight to choosing support units.
      setMode({ kind: 'supporting', unitId: unit.id, actionId, selectedSupportUnitIds: [] })
    }
  }

  function handleBoardClick(coord: Coordinate) {
    if (mode.kind === 'supporting') {
      if (!supportingUnit || !supportingAction || !myPlayerId) {
        setMode({ kind: 'idle' })
        return
      }
      // Clicking a unit already picked this pick is a no-op — it has
      // nothing further to contribute, but shouldn't cancel the pick either.
      if (supportingSelectedCandidates.some((c) => c.unit.coord.q === coord.q && c.unit.coord.r === coord.r)) return
      const candidate = supportingNeededCandidates.find((c) => c.unit.coord.q === coord.q && c.unit.coord.r === coord.r)
      if (!candidate) {
        setMode({ kind: 'idle' })
        return
      }
      const nextSelected = [...supportingSelectedCandidates, candidate]
      const boosted = boostedStateForSupport(state, myPlayerId, nextSelected)
      const actionReady =
        isActionAvailableForUnit(boosted, myPlayerId, supportingUnit, supportingAction, unitContent) &&
        (!actionNeedsTargeting(supportingAction.effect) ||
          (!!supportingTarget &&
            computeLegalTargets(boosted, myPlayerId, supportingUnit, supportingAction, unitContent).some((c) => c.q === supportingTarget!.q && c.r === supportingTarget!.r)))
      if (actionReady) {
        props.onResolveSupportedAction(
          nextSelected.map((c) => ({ unitId: c.unit.id, actionId: c.action.id })),
          { unitId: supportingUnit.id, actionId: supportingAction.id, target: supportingTarget },
        )
        setMode({ kind: 'idle' })
      } else {
        setMode({ kind: 'supporting', unitId: supportingUnit.id, actionId: supportingAction.id, target: supportingTarget, selectedSupportUnitIds: [...supportingSelectedIds, candidate.unit.id] })
      }
      return
    }
    if (targetingUnit && targetingAction && legalTargets.some((c) => c.q === coord.q && c.r === coord.r)) {
      if (targetingActionAvailableNow) {
        props.onResolveUnit(targetingUnit.id, targetingAction.id, coord)
        setMode({ kind: 'idle' })
      } else {
        setMode({ kind: 'supporting', unitId: targetingUnit.id, actionId: targetingAction.id, target: coord, selectedSupportUnitIds: [] })
      }
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
  // Highlighted candidates are only ones still needed to close the
  // remaining shortfall (see neededSupportCandidates) — an already-selected
  // unit stays highlighted too (solid, via supportSelected) as feedback for
  // what's already been picked, even though it's no longer "needed".
  const supportCandidateUnitIds = new Set([...supportingNeededCandidates.map((c) => c.unit.id), ...supportingSelectedIds])
  const historyByUnit = showHistory && turnReview ? summarizeUnitHistory(turnReview.events) : null
  const units: UnitMarker[] = state.units.map((u) => {
    const history = historyByUnit?.get(u.id)
    return {
      coord: u.coord,
      color: players.find((p) => p.id === u.ownerId)?.color ?? '#a3a3a3',
      kind: u.kind,
      // In 'supporting' mode, the yellow "could act this turn" ring is
      // unrelated to the current pick — only the teal supportCandidate ring
      // below should show, so units outside the support pool don't look
      // pickable too (see issue #150).
      highlighted: !showHistory && isMyActionTurn && mode.kind !== 'supporting' && availableUnitIds.has(u.id),
      supportCandidate: !showHistory && mode.kind === 'supporting' && supportCandidateUnitIds.has(u.id),
      supportSelected: !showHistory && mode.kind === 'supporting' && supportingSelectedIds.includes(u.id),
      historyHalos: history?.halos,
      historyLabel: history && Object.keys(history.resourceDelta).length > 0 ? formatResourceDelta(history.resourceDelta) : undefined,
      connectedNeighborCoords: u.connectedNeighborCoords,
    }
  })
  const historyArrows: HistoryArrow[] = historyByUnit ? [...historyByUnit.values()].flatMap((h) => h.moves) : []

  const ghostCells: GhostCell[] =
    mode.kind === 'supporting' && supportingTarget ? [{ coord: supportingTarget, legal: true }] : legalTargets.map((coord) => ({ coord, legal: true }))
  const actionMenu =
    menuCoord && menuUnits.length > 0 && myPlayerId
      ? {
          coord: menuCoord,
          options: menuUnits.flatMap((unit) =>
            (unitContent.actionsByKind[unit.kind] ?? []).map((a) => {
              const availableNow = isActionAvailableForUnit(state, myPlayerId, unit, a, unitContent)
              const supportable = !availableNow && isActionSupportable(state, myPlayerId, unit, a, unitContent)
              return {
                unitId: unit.id,
                unitKind: capitalize(unit.kind),
                id: a.id,
                label: a.name,
                description: a.description,
                outcome: computeActionOutcomePreview(state, myPlayerId, unit, a),
                disabled: !availableNow && !supportable,
                supportable,
                shortfall: supportable ? computeActionShortfall(state, myPlayerId, unit, a) : undefined,
              }
            }),
          ),
          onSelect: selectAction,
        }
      : undefined

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <PhaseBanner state={state} />
        <BankResources state={state} />
      </div>
      {/* Turn status panels ("Waiting for X…") re-render as other players act in real time; their
          height changes shift everything below them. Hidden while reviewing history so that view
          stays still instead of jumping around underneath the player. */}
      {!showHistory && state.roundPhase === 'selectCards' && (
        <SelectCardsPanel state={state} players={players} myPlayerId={myPlayerId} onChooseCard={props.onChooseCard} />
      )}
      {!showHistory && state.roundPhase === 'actions' && mode.kind === 'supporting' && supportingUnit && supportingAction && (
        <SupportHint actingUnitKind={supportingUnit.kind} actionLabel={supportingAction.name} neededCandidateCount={supportingNeededCandidates.length} />
      )}
      {!showHistory && state.roundPhase === 'actions' && mode.kind !== 'supporting' && (
        <ActionsPanel
          state={state}
          players={players}
          myPlayerId={myPlayerId}
          unitContent={unitContent}
          onPassActions={props.onPassActions}
          onResolveBulkAction={props.onResolveBulkAction}
        />
      )}
      {!showHistory && state.roundPhase === 'decline' && (
        <DeclinePanel state={state} players={players} myPlayerId={myPlayerId} onMoveToDecline={props.onMoveToDecline} />
      )}
      {!showHistory && state.roundPhase === 'purchase' && (
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
              taleContent={taleContent}
              resourceDeltaByPlayerId={showHistory ? turnReview?.resourceDeltaByPlayerId : null}
            />
            <AchievementsPanel state={state} players={players} achievementContent={achievementContent} taleContent={taleContent} />
          </div>
        )}
      </div>

      <LogPanel gameLog={props.gameLog} />
    </div>
  )
}

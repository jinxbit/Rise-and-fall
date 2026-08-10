import { useEffect, useState } from 'react'
import { isActionAvailableForUnit, legalConvertTargets, legalCreateTargets, legalTransformTargets } from '../engine/actionTargeting'
import { UNIT_KINDS } from '../engine/cards'
import { legalMoveDestinations } from '../engine/movement'
import { calculatePurchaseCost } from '../engine/purchaseCost'
import { calculateTerrainControlVP } from '../engine/scoring'
import { calculateAchievementVP, calculateBoardCountVP, sumVP } from '../engine/victoryPoints'
import type { AchievementContent } from '../engine/achievementContent'
import { listAchievements } from '../content/resolveContent'
import type { Coordinate, GameState, RoundPhase } from '../engine/types'
import type { UnitAction, UnitContent } from '../engine/unitContent'
import type { PlayerRow } from '../lib/dbTypes'
import type { GhostCell, UnitMarker } from './HexBoard'
import { HexBoard } from './HexBoard'

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
 * `idle`: nothing selected. `menu`: a unit was clicked — its action
 * options are showing as a radial menu around it on the board. `targeting`:
 * an action needing a target hex was picked from that menu — the next
 * legal-hex click on the board resolves it immediately (see onResolveUnit
 * in RoundView below — there's no local staging/submit step; each pick is
 * its own RESOLVE_UNIT_ACTION dispatch, applied right away).
 */
type ActionUiMode = { kind: 'idle' } | { kind: 'menu'; unitId: string } | { kind: 'targeting'; unitId: string; actionId: string }

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

/** Current total VP for every player, from the same three sources (achievements, board count, terrain control) finishRound uses for the end-of-game score — computed live from the current state rather than only once at game end. */
function currentScoreByPlayerId(state: GameState, achievementContent: AchievementContent): Record<string, number> {
  return sumVP(
    calculateAchievementVP(state.claimedByAchievementId, achievementContent.achievementVictoryPoints),
    calculateBoardCountVP(state.units, achievementContent.unitBoardCountVP),
    calculateTerrainControlVP(state.board, state.units, achievementContent.terrainVictoryPoints, achievementContent.terrainScoresAs),
  )
}

function PlayersStrip({
  state,
  players,
  myPlayerId,
  unitContent,
  achievementContent,
}: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  unitContent: UnitContent
  achievementContent: AchievementContent
}) {
  const scoreByPlayerId = currentScoreByPlayerId(state, achievementContent)

  return (
    <div className="flex flex-wrap gap-2 text-xs text-neutral-400">
      {state.players.map((player) => {
        const row = players.find((p) => p.id === player.id)
        const handKinds = player.handCardIds.map((cardId) => state.cards[cardId]?.kind).filter((kind): kind is string => Boolean(kind))
        const remainingByKind = UNIT_KINDS.map((kind) => {
          const cap = unitContent.unitSupplyCaps[kind]
          if (cap === undefined) return null
          const onBoard = state.units.filter((u) => u.ownerId === player.id && u.kind === kind).length
          return `${capitalize(kind)} ${Math.max(0, cap - onBoard)}`
        }).filter((entry): entry is string => entry !== null)
        return (
          <div
            key={player.id}
            className={`flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 ${
              player.id === myPlayerId ? 'border-indigo-600' : 'border-neutral-800'
            } ${player.eliminated ? 'opacity-40' : ''}`}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: row?.color ?? '#a3a3a3' }} />
            <span className="text-neutral-200">{row?.display_name ?? player.id}</span>
            {player.eliminated && <span>(eliminated)</span>}
            <span className="font-medium text-neutral-200">Score {scoreByPlayerId[player.id] ?? 0}</span>
            <span>Gold {player.resources.gold}</span>
            <span>Wood {player.resources.wood}</span>
            <span>Stone {player.resources.stone}</span>
            <span>Hand: {handKinds.length > 0 ? handKinds.map(capitalize).join(', ') : 'empty'}</span>
            <span>Decline {player.declineCardIds.length}</span>
            {remainingByKind.length > 0 && <span>Remaining: {remainingByKind.join(', ')}</span>}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Every achievement in the game (not just claimed ones), plus the current
 * gold price to buy a card back from decline — grouped together since both
 * move in lockstep with the same number (achievements claimed so far, see
 * calculatePurchaseCost), not because they're otherwise related.
 */
function AchievementsPanel({ state, players, achievementContent }: { state: GameState; players: PlayerRow[]; achievementContent: AchievementContent }) {
  const achievementsClaimed = Object.keys(state.claimedByAchievementId).length
  const buybackPrice = calculatePurchaseCost(achievementsClaimed, achievementContent.purchaseCostTable)

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 p-3 text-xs">
      <p className="text-neutral-400">
        Buy back from decline: <span className="font-medium text-neutral-200">{buybackPrice} gold</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {ACHIEVEMENTS.map((achievement) => {
          const claimedBy = state.claimedByAchievementId[achievement.id] ?? null
          return (
            <span
              key={achievement.id}
              title={achievement.description}
              className={`rounded-md border px-2 py-1 ${
                claimedBy ? 'border-amber-700/50 bg-amber-500/10 text-amber-400' : 'border-neutral-800 text-neutral-500'
              }`}
            >
              {achievement.name} ({achievement.victoryPoints} VP) — {claimedBy ? playerName(players, claimedBy) : 'unclaimed'}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function LogPanel({ state }: { state: GameState }) {
  const recent = [...state.log].slice(-8).reverse()
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
  onPassActions: () => void
}) {
  const { state, players, myPlayerId, onPassActions } = props
  const activePlayerId = state.pendingPlayerIds[0] ?? null
  const isMyTurn = activePlayerId !== null && activePlayerId === myPlayerId

  if (!isMyTurn) {
    return <p className="text-sm text-neutral-300">Waiting for {playerName(players, activePlayerId)} to resolve their action.</p>
  }

  const cardId = myPlayerId ? state.chosenCardIdByPlayerId[myPlayerId] : null
  const card = cardId ? state.cards[cardId] : null
  if (!card) return <p className="text-red-400">No chosen card found for this player.</p>

  const actingUnits = state.units.filter((u) => u.ownerId === myPlayerId && u.kind === card.kind)
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
  const cost = calculatePurchaseCost(achievementsClaimed, achievementContent.purchaseCostTable)

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium text-indigo-400">
        Your turn — buy a card back from decline for {cost} gold (you have {me.resources.gold}), or pass.
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
  onChooseCard: (cardId: string) => void
  onResolveUnit: (unitId: string, actionId: string, target?: Coordinate) => void
  onPassActions: () => void
  onMoveToDecline: (cardId: string) => void
  onPurchaseCard: (cardId: string) => void
  onPassPurchase: () => void
}) {
  const { state, players, myPlayerId, unitContent, achievementContent } = props
  const [mode, setMode] = useState<ActionUiMode>({ kind: 'idle' })

  const turnKey = `${state.turn}:${state.roundPhase}:${state.pendingPlayerIds[0] ?? ''}`
  useEffect(() => {
    setMode({ kind: 'idle' })
  }, [turnKey])

  const isMyActionTurn = state.roundPhase === 'actions' && state.pendingPlayerIds[0] === myPlayerId
  const myChosenCardId = myPlayerId ? state.chosenCardIdByPlayerId[myPlayerId] : null
  const myCard = myChosenCardId ? state.cards[myChosenCardId] : null
  const myActingUnits =
    isMyActionTurn && myCard && myPlayerId ? state.units.filter((u) => u.ownerId === myPlayerId && u.kind === myCard.kind) : []
  const actionsForKind = myCard ? (unitContent.actionsByKind[myCard.kind] ?? []) : []
  const availableUnits = myActingUnits.filter((u) => !state.resolvedUnitIdsThisTurn.includes(u.id))

  const menuUnitId = mode.kind === 'menu' ? mode.unitId : null
  const menuUnit = menuUnitId ? (myActingUnits.find((u) => u.id === menuUnitId) ?? null) : null
  const targetingUnitId = mode.kind === 'targeting' ? mode.unitId : null
  const targetingActionId = mode.kind === 'targeting' ? mode.actionId : null
  const targetingUnit = targetingUnitId ? (myActingUnits.find((u) => u.id === targetingUnitId) ?? null) : null
  const targetingAction = targetingActionId ? (actionsForKind.find((a) => a.id === targetingActionId) ?? null) : null

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

  function selectAction(actionId: string) {
    if (!menuUnit || !myPlayerId) return
    const action = actionsForKind.find((a) => a.id === actionId)
    if (!action) return
    if (!isActionAvailableForUnit(state, myPlayerId, menuUnit, action, unitContent)) return
    if (actionNeedsTargeting(action.effect)) {
      setMode({ kind: 'targeting', unitId: menuUnit.id, actionId })
    } else {
      props.onResolveUnit(menuUnit.id, actionId)
      setMode({ kind: 'idle' })
    }
  }

  function handleBoardClick(coord: Coordinate) {
    if (targetingUnit && targetingAction && legalTargets.some((c) => c.q === coord.q && c.r === coord.r)) {
      props.onResolveUnit(targetingUnit.id, targetingAction.id, coord)
      setMode({ kind: 'idle' })
      return
    }
    const clickedUnit = availableUnits.find((u) => u.coord.q === coord.q && u.coord.r === coord.r)
    if (clickedUnit) {
      setMode((prev) => (prev.kind === 'menu' && prev.unitId === clickedUnit.id ? { kind: 'idle' } : { kind: 'menu', unitId: clickedUnit.id }))
      return
    }
    setMode({ kind: 'idle' })
  }

  const availableUnitIds = new Set(availableUnits.map((u) => u.id))
  const units: UnitMarker[] = state.units.map((u) => ({
    coord: u.coord,
    color: players.find((p) => p.id === u.ownerId)?.color ?? '#a3a3a3',
    kind: u.kind,
    highlighted: isMyActionTurn && availableUnitIds.has(u.id),
  }))

  const ghostCells: GhostCell[] = legalTargets.map((coord) => ({ coord, legal: true }))
  const actionMenu =
    menuUnit && myPlayerId
      ? {
          coord: menuUnit.coord,
          options: actionsForKind.map((a) => ({
            id: a.id,
            label: a.name,
            disabled: !isActionAvailableForUnit(state, myPlayerId, menuUnit, a, unitContent),
          })),
          onSelect: selectAction,
        }
      : undefined

  return (
    <div className="flex flex-col gap-4">
      <PhaseBanner state={state} />
      <PlayersStrip state={state} players={players} myPlayerId={myPlayerId} unitContent={unitContent} achievementContent={achievementContent} />

      {state.roundPhase === 'selectCards' && (
        <SelectCardsPanel state={state} players={players} myPlayerId={myPlayerId} onChooseCard={props.onChooseCard} />
      )}
      {state.roundPhase === 'actions' && (
        <ActionsPanel state={state} players={players} myPlayerId={myPlayerId} onPassActions={props.onPassActions} />
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

      <HexBoard
        board={state.board}
        units={units}
        ghostCells={ghostCells}
        actionMenu={actionMenu}
        interactive={isMyActionTurn}
        onHexClick={isMyActionTurn ? handleBoardClick : undefined}
      />

      <LogPanel state={state} />
      <AchievementsPanel state={state} players={players} achievementContent={achievementContent} />
    </div>
  )
}

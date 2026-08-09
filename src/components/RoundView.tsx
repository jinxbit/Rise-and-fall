import { useEffect, useState } from 'react'
import type { UnitActionAssignment } from '../engine/actions'
import { legalConvertTargets, legalCreateTargets, legalTransformTargets } from '../engine/actionTargeting'
import { legalMoveDestinations } from '../engine/movement'
import { calculatePurchaseCost } from '../engine/purchaseCost'
import type { AchievementContent } from '../engine/achievementContent'
import type { Coordinate, GameState, RoundPhase } from '../engine/types'
import type { UnitAction, UnitContent } from '../engine/unitContent'
import type { PlayerRow } from '../lib/dbTypes'
import type { GhostCell, UnitMarker } from './HexBoard'
import { HexBoard } from './HexBoard'

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function prettifyId(id: string): string {
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
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
 * legal-hex click on the board completes the assignment.
 */
type ActionUiMode = { kind: 'idle' } | { kind: 'menu'; unitId: string } | { kind: 'targeting'; unitId: string; actionId: string }

interface ActionsUiState {
  /** Ordered, already-confirmed per-unit assignments — resolution order matches this order exactly (see applyResolveUnitAction in ../engine/applyAction.ts). */
  assignments: UnitActionAssignment[]
  mode: ActionUiMode
}

const EMPTY_ACTIONS_UI: ActionsUiState = { assignments: [], mode: { kind: 'idle' } }

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

function PlayersStrip({ state, players, myPlayerId }: { state: GameState; players: PlayerRow[]; myPlayerId: string | null }) {
  return (
    <div className="flex flex-wrap gap-2 text-xs text-neutral-400">
      {state.players.map((player) => {
        const row = players.find((p) => p.id === player.id)
        return (
          <div
            key={player.id}
            className={`flex items-center gap-2 rounded-md border px-2 py-1 ${
              player.id === myPlayerId ? 'border-indigo-600' : 'border-neutral-800'
            } ${player.eliminated ? 'opacity-40' : ''}`}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: row?.color ?? '#a3a3a3' }} />
            <span className="text-neutral-200">{row?.display_name ?? player.id}</span>
            {player.eliminated && <span>(eliminated)</span>}
            <span>Gold {player.resources.gold}</span>
            <span>Wood {player.resources.wood}</span>
            <span>Stone {player.resources.stone}</span>
            <span>Hand {player.handCardIds.length}</span>
            <span>Decline {player.declineCardIds.length}</span>
          </div>
        )
      })}
    </div>
  )
}

function AchievementsStrip({ state, players }: { state: GameState; players: PlayerRow[] }) {
  const claimed = Object.entries(state.claimedByAchievementId)
  if (claimed.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 text-xs text-amber-400">
      {claimed.map(([achievementId, playerId]) => (
        <span key={achievementId} className="rounded-md border border-amber-700/50 bg-amber-500/10 px-2 py-1">
          {prettifyId(achievementId)} → {playerName(players, playerId)}
        </span>
      ))}
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
  unitContent: UnitContent
  assignments: UnitActionAssignment[]
  onUndo: () => void
  onResolve: () => void
}) {
  const { state, players, myPlayerId, unitContent, assignments, onUndo, onResolve } = props
  const activePlayerId = state.pendingPlayerIds[0] ?? null
  const isMyTurn = activePlayerId !== null && activePlayerId === myPlayerId

  if (!isMyTurn) {
    return <p className="text-sm text-neutral-300">Waiting for {playerName(players, activePlayerId)} to resolve their action.</p>
  }

  const cardId = myPlayerId ? state.chosenCardIdByPlayerId[myPlayerId] : null
  const card = cardId ? state.cards[cardId] : null
  if (!card) return <p className="text-red-400">No chosen card found for this player.</p>

  const actingUnits = state.units.filter((u) => u.ownerId === myPlayerId && u.kind === card.kind)
  const actions = unitContent.actionsByKind[card.kind] ?? []
  const remaining = actingUnits.filter((u) => !assignments.some((a) => a.unitId === u.id))

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium text-indigo-400">
        Your turn — playing {capitalize(card.kind)}. Click a highlighted unit on the board to choose its action; a
        unit left alone does nothing this round.
      </p>

      {actingUnits.length === 0 && <p className="text-neutral-500">No units of this kind to act.</p>}
      {actingUnits.length > 0 && remaining.length === 0 && (
        <p className="text-neutral-500">Every unit has an action assigned.</p>
      )}

      {assignments.length > 0 && (
        <ol className="flex flex-col gap-1 text-xs text-neutral-400">
          <span className="text-neutral-500">Resolves in this order:</span>
          {assignments.map((a, i) => {
            const unit = state.units.find((u) => u.id === a.unitId)
            const action = actions.find((x) => x.id === a.actionId)
            return (
              <li key={`${a.unitId}-${i}`}>
                {i + 1}. {unit ? `${capitalize(unit.kind)} at (${unit.coord.q},${unit.coord.r})` : a.unitId} →{' '}
                <span className="text-neutral-200">{action?.name ?? a.actionId}</span>
                {a.target && (
                  <span>
                    {' '}
                    → target ({a.target.q},{a.target.r})
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}

      <div className="flex gap-2">
        <button
          disabled={assignments.length === 0}
          onClick={onUndo}
          className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 disabled:opacity-40"
        >
          Undo last
        </button>
        <button onClick={onResolve} className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500">
          Resolve actions
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
  onResolveUnitAction: (unitActions: UnitActionAssignment[]) => void
  onMoveToDecline: (cardId: string) => void
  onPurchaseCard: (cardId: string) => void
  onPassPurchase: () => void
}) {
  const { state, players, myPlayerId, unitContent, achievementContent } = props
  const [ui, setUi] = useState<ActionsUiState>(EMPTY_ACTIONS_UI)

  const turnKey = `${state.turn}:${state.roundPhase}:${state.pendingPlayerIds[0] ?? ''}`
  useEffect(() => {
    setUi(EMPTY_ACTIONS_UI)
  }, [turnKey])

  const isMyActionTurn = state.roundPhase === 'actions' && state.pendingPlayerIds[0] === myPlayerId
  const myChosenCardId = myPlayerId ? state.chosenCardIdByPlayerId[myPlayerId] : null
  const myCard = myChosenCardId ? state.cards[myChosenCardId] : null
  const myActingUnits =
    isMyActionTurn && myCard && myPlayerId ? state.units.filter((u) => u.ownerId === myPlayerId && u.kind === myCard.kind) : []
  const actionsForKind = myCard ? (unitContent.actionsByKind[myCard.kind] ?? []) : []
  const availableUnits = myActingUnits.filter((u) => !ui.assignments.some((a) => a.unitId === u.id))

  const menuUnitId = ui.mode.kind === 'menu' ? ui.mode.unitId : null
  const menuUnit = menuUnitId ? (myActingUnits.find((u) => u.id === menuUnitId) ?? null) : null
  const targetingUnitId = ui.mode.kind === 'targeting' ? ui.mode.unitId : null
  const targetingActionId = ui.mode.kind === 'targeting' ? ui.mode.actionId : null
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
    if (!menuUnit) return
    const action = actionsForKind.find((a) => a.id === actionId)
    if (!action) return
    if (actionNeedsTargeting(action.effect)) {
      setUi((prev) => ({ ...prev, mode: { kind: 'targeting', unitId: menuUnit.id, actionId } }))
    } else {
      setUi((prev) => ({ assignments: [...prev.assignments, { unitId: menuUnit.id, actionId }], mode: { kind: 'idle' } }))
    }
  }

  function handleBoardClick(coord: Coordinate) {
    if (targetingUnit && targetingAction && legalTargets.some((c) => c.q === coord.q && c.r === coord.r)) {
      setUi((prev) => ({
        assignments: [...prev.assignments, { unitId: targetingUnit.id, actionId: targetingAction.id, target: coord }],
        mode: { kind: 'idle' },
      }))
      return
    }
    const clickedUnit = availableUnits.find((u) => u.coord.q === coord.q && u.coord.r === coord.r)
    if (clickedUnit) {
      setUi((prev) => {
        if (prev.mode.kind === 'menu' && prev.mode.unitId === clickedUnit.id) return { ...prev, mode: { kind: 'idle' } }
        return { ...prev, mode: { kind: 'menu', unitId: clickedUnit.id } }
      })
      return
    }
    setUi((prev) => ({ ...prev, mode: { kind: 'idle' } }))
  }

  function undoLast() {
    setUi((prev) => ({ ...prev, assignments: prev.assignments.slice(0, -1) }))
  }

  const availableUnitIds = new Set(availableUnits.map((u) => u.id))
  const units: UnitMarker[] = state.units.map((u) => ({
    coord: u.coord,
    color: players.find((p) => p.id === u.ownerId)?.color ?? '#a3a3a3',
    label: u.kind.slice(0, 1).toUpperCase(),
    highlighted: isMyActionTurn && availableUnitIds.has(u.id),
  }))

  const ghostCells: GhostCell[] = legalTargets.map((coord) => ({ coord, legal: true }))
  const actionMenu = menuUnit
    ? {
        coord: menuUnit.coord,
        options: actionsForKind.map((a) => ({ id: a.id, label: a.name.slice(0, 2).toUpperCase(), title: a.name })),
        onSelect: selectAction,
      }
    : undefined

  return (
    <div className="flex flex-col gap-4">
      <PhaseBanner state={state} />
      <PlayersStrip state={state} players={players} myPlayerId={myPlayerId} />
      <AchievementsStrip state={state} players={players} />

      {state.roundPhase === 'selectCards' && (
        <SelectCardsPanel state={state} players={players} myPlayerId={myPlayerId} onChooseCard={props.onChooseCard} />
      )}
      {state.roundPhase === 'actions' && (
        <ActionsPanel
          state={state}
          players={players}
          myPlayerId={myPlayerId}
          unitContent={unitContent}
          assignments={ui.assignments}
          onUndo={undoLast}
          onResolve={() => props.onResolveUnitAction(ui.assignments)}
        />
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
    </div>
  )
}

import { useEffect, useState } from 'react'
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

interface ActionTargetingState {
  actionId: string | null
  targetsByUnitId: Record<string, Coordinate>
  activeUnitId: string | null
}

const EMPTY_TARGETING: ActionTargetingState = { actionId: null, targetsByUnitId: {}, activeUnitId: null }

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
  targeting: ActionTargetingState
  setTargeting: (updater: (t: ActionTargetingState) => ActionTargetingState) => void
  onResolveUnitAction: (actionId: string, targets: Record<string, Coordinate>) => void
}) {
  const { state, players, myPlayerId, unitContent, targeting, setTargeting, onResolveUnitAction } = props
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
  const chosenAction = actions.find((a) => a.id === targeting.actionId) ?? null
  const targetingRequired = chosenAction ? actionNeedsTargeting(chosenAction.effect) : false

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium text-indigo-400">Your turn — playing {capitalize(card.kind)}.</p>

      {!chosenAction && (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <button
              key={action.id}
              title={action.description}
              onClick={() => setTargeting(() => ({ actionId: action.id, targetsByUnitId: {}, activeUnitId: null }))}
              className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500"
            >
              {action.name}
            </button>
          ))}
          {actions.length === 0 && <p className="text-neutral-500">This unit kind has no actions.</p>}
        </div>
      )}

      {chosenAction && (
        <div className="flex flex-col gap-2">
          <p>
            Resolving <span className="font-medium">{chosenAction.name}</span> for every {capitalize(card.kind)} you
            control ({actingUnits.length}).
          </p>

          {targetingRequired && (
            <ul className="flex flex-col gap-1">
              {actingUnits.map((unit) => {
                const target = targeting.targetsByUnitId[unit.id]
                return (
                  <li key={unit.id} className="flex items-center gap-2">
                    <span className="text-neutral-400">
                      {capitalize(unit.kind)} at ({unit.coord.q},{unit.coord.r}):
                    </span>
                    {target ? (
                      <span className="text-emerald-400">
                        target ({target.q},{target.r})
                      </span>
                    ) : (
                      <span className="text-neutral-500">no target</span>
                    )}
                    <button
                      onClick={() => setTargeting((t) => ({ ...t, activeUnitId: unit.id }))}
                      className={`rounded-md border px-2 py-0.5 text-xs ${
                        targeting.activeUnitId === unit.id
                          ? 'border-indigo-500 text-indigo-300'
                          : 'border-neutral-700 hover:border-neutral-500'
                      }`}
                    >
                      {target ? 'Change target' : 'Pick target'}
                    </button>
                  </li>
                )
              })}
              {actingUnits.length === 0 && <li className="text-neutral-500">No units of this kind to act.</li>}
            </ul>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => onResolveUnitAction(chosenAction.id, targeting.targetsByUnitId)}
              className="rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500"
            >
              Resolve action
            </button>
            <button
              onClick={() => setTargeting(() => ({ actionId: null, targetsByUnitId: {}, activeUnitId: null }))}
              className="text-neutral-500 underline hover:text-neutral-300"
            >
              Choose a different action
            </button>
          </div>
        </div>
      )}
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
  onResolveUnitAction: (actionId: string, targets: Record<string, Coordinate>) => void
  onMoveToDecline: (cardId: string) => void
  onPurchaseCard: (cardId: string) => void
  onPassPurchase: () => void
}) {
  const { state, players, myPlayerId, unitContent, achievementContent } = props
  const [targeting, setTargeting] = useState<ActionTargetingState>(EMPTY_TARGETING)

  const turnKey = `${state.turn}:${state.roundPhase}:${state.pendingPlayerIds[0] ?? ''}`
  useEffect(() => {
    setTargeting(EMPTY_TARGETING)
  }, [turnKey])

  const isMyActionTurn = state.roundPhase === 'actions' && state.pendingPlayerIds[0] === myPlayerId
  const myChosenCardId = myPlayerId ? state.chosenCardIdByPlayerId[myPlayerId] : null
  const myCard = myChosenCardId ? state.cards[myChosenCardId] : null
  const myActingUnits =
    isMyActionTurn && myCard && myPlayerId ? state.units.filter((u) => u.ownerId === myPlayerId && u.kind === myCard.kind) : []
  const activeUnit = targeting.activeUnitId ? (myActingUnits.find((u) => u.id === targeting.activeUnitId) ?? null) : null
  const chosenAction =
    isMyActionTurn && myCard ? ((unitContent.actionsByKind[myCard.kind] ?? []).find((a) => a.id === targeting.actionId) ?? null) : null

  let legalTargets: Coordinate[] = []
  if (activeUnit && chosenAction && myPlayerId) {
    const effect = chosenAction.effect
    if (effect.actionType === 'create') {
      legalTargets = legalCreateTargets(state, myPlayerId, activeUnit, effect, unitContent)
    } else if (effect.actionType === 'transform' && effect.targetHex.location === 'adj') {
      legalTargets = legalTransformTargets(state, myPlayerId, activeUnit, effect, unitContent)
    } else if (effect.actionType === 'convert') {
      legalTargets = legalConvertTargets(state, myPlayerId, activeUnit, effect, unitContent)
    } else if (effect.actionType === 'move') {
      legalTargets = legalMoveDestinations(state, activeUnit, activeUnit.movement, unitContent.terrainLevels)
    }
  }

  const ghostCells: GhostCell[] = [
    ...legalTargets.map((coord) => ({ coord, legal: true })),
    ...Object.values(targeting.targetsByUnitId).map((coord) => ({ coord, legal: true })),
  ]

  function handleBoardClick(coord: Coordinate) {
    if (!activeUnit) return
    if (!legalTargets.some((c) => c.q === coord.q && c.r === coord.r)) return
    setTargeting((t) => ({ ...t, targetsByUnitId: { ...t.targetsByUnitId, [activeUnit.id]: coord }, activeUnitId: null }))
  }

  const units: UnitMarker[] = state.units.map((u) => ({
    coord: u.coord,
    color: players.find((p) => p.id === u.ownerId)?.color ?? '#a3a3a3',
    label: u.kind.slice(0, 1).toUpperCase(),
  }))

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
          targeting={targeting}
          setTargeting={setTargeting}
          onResolveUnitAction={props.onResolveUnitAction}
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

      <HexBoard board={state.board} units={units} ghostCells={ghostCells} interactive={!!activeUnit} onHexClick={handleBoardClick} />

      <LogPanel state={state} />
    </div>
  )
}

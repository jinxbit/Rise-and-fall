import { useEffect, useMemo, useState } from 'react'
import { getTile } from '../engine/board'
import { placedShapeCells, rotateShape, shapeCenterCell } from '../engine/boardGeneration'
import type { RoomCheckDiagnostics } from '../engine/boardGeneration'
import type { BoardGenerationContent } from '../engine/boardGenerationContent'
import { checkTilePlacementLegalityDetailed, currentTilePlacerId, currentUnitPlacerId, isLegalStartingUnitPlacement } from '../engine/boardSetup'
import type { Board, Coordinate, GameState } from '../engine/types'
import type { PlayerRow } from '../lib/dbTypes'
import type { GhostCell, PlacementControls } from './HexBoard'
import { HexBoard } from './HexBoard'

const STARTING_UNIT_LABELS: Record<string, string> = { city: 'City', nomad: 'Nomad', ship: 'Ship' }

function coordEquals(a: Coordinate | null, b: Coordinate): boolean {
  return a !== null && a.q === b.q && a.r === b.r
}

/** Untiled hexes within `pad` of the board's current bounding box — clickable placement targets that aren't tiles yet (e.g. where the next water tile could go). */
function paddedEmptyCoords(board: Board, pad: number): Coordinate[] {
  const tiles = Object.values(board.tiles)
  if (tiles.length === 0) return []
  const qs = tiles.map((t) => t.coord.q)
  const rs = tiles.map((t) => t.coord.r)
  const minQ = Math.min(...qs) - pad
  const maxQ = Math.max(...qs) + pad
  const minR = Math.min(...rs) - pad
  const maxR = Math.max(...rs) + pad

  const coords: Coordinate[] = []
  for (let q = minQ; q <= maxQ; q++) {
    for (let r = minR; r <= maxR; r++) {
      if (!getTile(board, { q, r })) coords.push({ q, r })
    }
  }
  return coords
}

function playerName(players: PlayerRow[], playerId: string | null): string {
  if (!playerId) return 'nobody'
  return players.find((p) => p.id === playerId)?.display_name ?? playerId
}

/**
 * Reports what the rule-4 "room for the rest of this tier" search (see
 * canPlaceRemainingTilesDetailed in ../engine/boardGeneration.ts) did for
 * the currently pending placement (the hex the player has clicked, before
 * they confirm it) — issue #191: this should update on every click, not
 * only once a tile is actually placed, so a slow or near-capped check is
 * visible while the player is still choosing where to put the tile.
 * `roomCheck === undefined` means no hex is currently selected; `null`
 * means the pending placement didn't reach the search at all (either it's
 * already illegal for some other reason, or it's the last tile of its
 * tier, so nothing remains to check room for).
 */
function RoomCheckPanel({ roomCheck }: { roomCheck: RoomCheckDiagnostics | null | undefined }) {
  if (roomCheck === undefined) return null

  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
      <p className="font-medium text-neutral-300">Rule-4 room check (current placement)</p>
      {roomCheck === null || !roomCheck.ran ? (
        <p className="mt-1">Not run — either the placement is already illegal for another reason, or it&apos;s the last tile of its tier, so there&apos;s nothing left to check room for.</p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>{roomCheck.budgetReached ? `Hit the ${roomCheck.stepBudget.toLocaleString()}-iteration cap` : `Finished before the ${roomCheck.stepBudget.toLocaleString()}-iteration cap`}</li>
          <li>{roomCheck.stepsUsed.toLocaleString()} iterations evaluated</li>
          <li>{roomCheck.elapsedMs < 1 ? '<1 ms' : `${Math.round(roomCheck.elapsedMs)} ms`} elapsed</li>
          <li>Result: {roomCheck.legal ? 'a legal placement of every remaining tile was found' : 'no legal placement of every remaining tile was found'}</li>
        </ul>
      )}
    </div>
  )
}

function TilePlacementPanel(props: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  boardGenerationContent: BoardGenerationContent
  onPlaceTile: (anchor: Coordinate, rotationSteps: number) => void
}) {
  const { state, players, myPlayerId, boardGenerationContent, onPlaceTile } = props
  const boardSetup = state.boardSetup!
  const tier = boardSetup.tileTierQueue[0]
  const tierContent = boardGenerationContent.tiers.find((t) => t.terrain === tier)
  const placerId = currentTilePlacerId(state)
  const isMyTurn = placerId !== null && placerId === myPlayerId

  // The hex the player actually clicked — kept separate from `anchor`
  // (the shape's cells[0] position, see placedShapeCells) so that clicking
  // a hex places the *center* of the tile there rather than its cells[0]
  // corner, which for an asymmetric shape can land a hex or more away from
  // where the player clicked.
  const [center, setCenter] = useState<Coordinate | null>(null)
  const [rotation, setRotation] = useState(0)

  // A new turn (mine or someone else's) starts fresh — clears any pending,
  // unconfirmed choice left over from before.
  useEffect(() => {
    setCenter(null)
    setRotation(0)
  }, [boardSetup.tilePlacerIndex, boardSetup.tileTierQueue.length])

  // Computed even when `tierContent` is missing (the early return just
  // below handles that) so every hook here — including the useMemo below —
  // still runs unconditionally, in the same order, on every render (rules
  // of hooks).
  const rotatedCenterOffset = tierContent ? rotateShape([shapeCenterCell(tierContent.shapeCells)], rotation)[0] : null
  const anchor = center && rotatedCenterOffset ? { q: center.q - rotatedCenterOffset.q, r: center.r - rotatedCenterOffset.r } : null

  // checkTilePlacementLegalityDetailed is the expensive part of this render (it can
  // run a bounded combinatorial backtracking search — see
  // canPlaceRemainingTiles/findDisjointCombos in ../engine/boardGeneration.ts
  // — over every legal placement of the board's current size), so it's
  // memoized on its actual inputs rather than recomputed on every render:
  // this component re-renders on every gameState update from Supabase
  // realtime (e.g. another player's placement, or even an unrelated parent
  // re-render like the top menu opening), not just when the player changes
  // their own pending anchor/rotation. Keyed on `state`/`boardGenerationContent`
  // by reference (both are only ever replaced, never mutated in place — see
  // GameState's own event-sourcing model) plus the anchor/rotation's actual
  // (primitive) values, since `anchor` itself is a fresh object every render.
  const legalityResult = useMemo(
    () => (anchor ? checkTilePlacementLegalityDetailed(state, anchor, rotation, boardGenerationContent) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, boardGenerationContent, anchor?.q, anchor?.r, rotation],
  )
  const legalityError = legalityResult?.error ?? null

  if (!tierContent) {
    return <p className="text-red-400">No board-generation content for tier &apos;{tier}&apos;.</p>
  }

  const placedCells = anchor ? placedShapeCells(tierContent.shapeCells, anchor, rotation) : []
  const legal = anchor !== null && legalityError === null
  const ghostCells: GhostCell[] = placedCells.map((coord) => ({ coord, legal }))
  const extraCoords = paddedEmptyCoords(state.board, 4)

  // Rendered right on the board, next to the hex the player clicked, rather
  // than in a static row above it — on a large or scrolled board a static
  // row can end up far from the tile actually being placed (issue #120).
  // Only supplied once the pending placement is legal, so Confirm is never
  // shown (not even disabled) for an illegal placement (issue #121) —
  // rotating still works by clicking the anchor hex again (see
  // rotateHintCoord below), so there's no dedicated Rotate control either.
  const placementControls: PlacementControls | null =
    isMyTurn && anchor && center && legal
      ? {
          coord: center,
          onConfirm: () => onPlaceTile(anchor, rotation),
        }
      : null

  function handleHexClick(coord: Coordinate) {
    if (!isMyTurn) return
    if (coordEquals(center, coord)) {
      setRotation((r) => (r + 1) % 6)
    } else {
      setCenter(coord)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-300">
        Placing <span className="font-medium capitalize">{tier}</span> tiles — {boardSetup.tilesRemainingInTier}{' '}
        left this tier.{' '}
        {isMyTurn ? (
          <span className="font-medium text-indigo-400">Your turn.</span>
        ) : (
          <span>Waiting for {playerName(players, placerId)}.</span>
        )}
      </p>

      {isMyTurn && (
        <>
          {/* This and the legality message below each get a *fixed* height
              (h-10 + line-clamp-2, not just a minimum) — the instruction text
              changes (and can wrap differently) the instant a hex is first
              clicked, and several of checkTilePlacementLegality's messages are
              long enough to wrap onto a second line. A min-height alone still
              let those cases grow this block taller and shove the board
              (rendered right after) down. The Confirm control itself renders
              on the board next to the anchor hex — see placementControls
              below — not in this block. */}
          <p className="line-clamp-2 h-10 text-sm text-neutral-400">
            {anchor ? 'Click the same hex again to turn it, click elsewhere to move it.' : 'Click a hex to choose where to place the tile.'}
          </p>
          <p className="line-clamp-2 h-10 text-sm text-red-400" title={anchor && legalityError ? legalityError : undefined}>
            {anchor ? legalityError : null}
          </p>
        </>
      )}

      <HexBoard
        board={state.board}
        extraCoords={extraCoords}
        ghostCells={ghostCells}
        selectedCoord={center}
        rotateHintCoord={isMyTurn ? center : null}
        placementControls={placementControls}
        interactive={isMyTurn}
        onHexClick={handleHexClick}
      />

      <RoomCheckPanel roomCheck={legalityResult?.roomCheck} />
    </div>
  )
}

function UnitPlacementPanel(props: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  onPlaceUnit: (unitKind: string, coord: Coordinate) => void
}) {
  const { state, players, myPlayerId, onPlaceUnit } = props
  const boardSetup = state.boardSetup!
  const placerId = currentUnitPlacerId(state)
  const isMyTurn = placerId !== null && placerId === myPlayerId
  const remaining = boardSetup.unitsRemainingByPlayerId[placerId ?? ''] ?? []

  const [selectedKind, setSelectedKind] = useState<string | null>(remaining[0] ?? null)

  useEffect(() => {
    setSelectedKind(remaining[0] ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardSetup.unitPlacerIndex])

  const units = state.units.map((u) => ({
    coord: u.coord,
    color: players.find((p) => p.id === u.ownerId)?.color ?? '#a3a3a3',
    kind: u.kind,
  }))

  const ghostCells: GhostCell[] = selectedKind
    ? Object.values(state.board.tiles)
        .filter((tile) => isLegalStartingUnitPlacement(state.board, state.units, selectedKind, tile.coord))
        .map((tile) => ({ coord: tile.coord, legal: true }))
    : []

  function handleHexClick(coord: Coordinate) {
    if (!isMyTurn || !selectedKind) return
    onPlaceUnit(selectedKind, coord)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-300">
        Placing starting units.{' '}
        {isMyTurn ? (
          <span className="font-medium text-indigo-400">Your turn.</span>
        ) : (
          <span>Waiting for {playerName(players, placerId)}.</span>
        )}
      </p>

      {isMyTurn && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-neutral-400">Place a:</span>
          {remaining.map((kind) => (
            <button
              key={kind}
              onClick={() => setSelectedKind(kind)}
              className={`rounded-md border px-3 py-1 ${
                selectedKind === kind ? 'border-indigo-500 bg-indigo-600/20 text-indigo-300' : 'border-neutral-700 hover:border-neutral-500'
              }`}
            >
              {STARTING_UNIT_LABELS[kind] ?? kind}
            </button>
          ))}
          <span className="text-neutral-500">then click a highlighted hex.</span>
        </div>
      )}

      <HexBoard
        board={state.board}
        ghostCells={ghostCells}
        clickableCoords={ghostCells.map((g) => g.coord)}
        units={units}
        interactive={isMyTurn}
        onHexClick={handleHexClick}
      />
    </div>
  )
}

export function BoardSetupView(props: {
  state: GameState
  players: PlayerRow[]
  myPlayerId: string | null
  boardGenerationContent: BoardGenerationContent
  onPlaceTile: (anchor: Coordinate, rotationSteps: number) => void
  onPlaceUnit: (unitKind: string, coord: Coordinate) => void
}) {
  const boardSetup = props.state.boardSetup
  if (!boardSetup) return null

  return boardSetup.tileTierQueue.length > 0 ? (
    <TilePlacementPanel
      state={props.state}
      players={props.players}
      myPlayerId={props.myPlayerId}
      boardGenerationContent={props.boardGenerationContent}
      onPlaceTile={props.onPlaceTile}
    />
  ) : (
    <UnitPlacementPanel state={props.state} players={props.players} myPlayerId={props.myPlayerId} onPlaceUnit={props.onPlaceUnit} />
  )
}

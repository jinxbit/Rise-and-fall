import { getTile, neighborCoords } from './board'
import { isCliffBetweenTerrains } from './cliffs'
import type { Coordinate, GameState, Unit, UnitMovement } from './types'
import { coordKey } from './types'

function unitsAt(state: GameState, coord: Coordinate): Unit[] {
  const key = coordKey(coord)
  return state.units.filter((u) => coordKey(u.coord) === key)
}

/** Whether a hex's occupants stop this unit from moving *through* it at all (passing through or landing on it). */
function blocksTransit(occupants: Unit[], ownerId: string, blockedByUnits: UnitMovement['blockedByUnits']): boolean {
  if (!blockedByUnits || blockedByUnits === 'none') return false
  if (blockedByUnits === 'all') return occupants.length > 0
  return occupants.some((u) => u.ownerId !== ownerId)
}

/**
 * Whether a move may *end* on this hex — independent of blocksTransit,
 * which only governs passing through. Two independent allow-lists:
 * canEndMoveOnUnitTypes permits landing on that kind regardless of owner
 * (e.g. Merchant on any City); canEndMoveOnAlliedUnitTypes only permits it
 * when the occupant is owned by the SAME player as the mover (e.g. The
 * Ports Tale: a Ship may land on its own Port, never an opponent's). Every
 * occupant must be covered by one list or the other for the hex to be
 * landable — this is also what naturally enforces "at most one Ship per
 * Port": a hex with [Port, alliedShip] already has a non-Port, non-allied
 * occupant (the Ship) that isn't itself in canEndMoveOnAlliedUnitTypes, so
 * a second Ship can't land there either.
 */
function canLandOn(
  occupants: Unit[],
  moverOwnerId: string,
  canEndMoveOnUnitTypes: string[] | undefined,
  canEndMoveOnAlliedUnitTypes: string[] | undefined,
): boolean {
  if (occupants.length === 0) return true
  const anyOwnerAllowed = new Set(canEndMoveOnUnitTypes ?? [])
  const alliedAllowed = new Set(canEndMoveOnAlliedUnitTypes ?? [])
  return occupants.every((u) => anyOwnerAllowed.has(u.kind) || (u.ownerId === moverOwnerId && alliedAllowed.has(u.kind)))
}

/**
 * All hexes a unit could legally move to in one MOVE_UNIT action: a
 * breadth-first search out from its current position, stepping only onto
 * terrain the unit is allowed on (`movement.terrains`), never across a
 * cliff edge unless `movement.canCrossCliffs`, and never through a hex
 * `movement.blockedByUnits` blocks. Stops at `movement.moveDistance` steps,
 * or — for `'unlimited'` (e.g. Ship) — simply once there's nowhere further
 * to legally go, which in practice means a unit restricted to a single
 * terrain type (like Ship's Water-only) can never leave its connected
 * region of that terrain, since every step must land on it too.
 *
 * Ending a move requires the destination to be empty, or occupied only by
 * kinds in `movement.canEndMoveOnUnitTypes` — that's independent of
 * `blockedByUnits`, which only governs passing *through* a hex, not
 * stopping on one; a hex can be legal to move through but not to land on.
 *
 * `terrainLevels` is content/terrain.json's `level` per terrain id (same
 * as the cliff checks in ./unitActions.ts), passed in explicitly per the
 * engine's content-agnostic convention.
 */
export function legalMoveDestinations(
  state: GameState,
  unit: Unit,
  movement: UnitMovement,
  terrainLevels: Record<string, number>,
): Coordinate[] {
  if (!movement.isMobile) return []

  const maxSteps = movement.moveDistance === undefined || movement.moveDistance === 'unlimited' ? Infinity : movement.moveDistance

  const visited = new Set([coordKey(unit.coord)])
  const destinations: Coordinate[] = []
  let frontier: Coordinate[] = [unit.coord]
  let steps = 0

  while (frontier.length > 0 && steps < maxSteps) {
    steps += 1
    const next: Coordinate[] = []

    for (const from of frontier) {
      const fromTile = getTile(state.board, from)
      if (!fromTile) continue

      for (const neighbor of neighborCoords(state.board, from)) {
        const key = coordKey(neighbor)
        if (visited.has(key)) continue

        const toTile = getTile(state.board, neighbor)
        if (!toTile || !movement.terrains.includes(toTile.terrain)) continue
        if (!movement.canCrossCliffs && isCliffBetweenTerrains(fromTile.terrain, toTile.terrain, terrainLevels)) continue

        const occupants = unitsAt(state, neighbor)
        if (blocksTransit(occupants, unit.ownerId, movement.blockedByUnits)) continue

        visited.add(key)
        next.push(neighbor)
        if (canLandOn(occupants, unit.ownerId, movement.canEndMoveOnUnitTypes, movement.canEndMoveOnAlliedUnitTypes)) {
          destinations.push(neighbor)
        }
      }
    }

    frontier = next
  }

  return destinations
}

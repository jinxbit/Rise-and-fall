import type { Resources } from './types'

/**
 * Moves `amount` of one resource from the shared bank into a player's
 * holding, respecting both limits from content/resources.json:
 *  - the bank can't go negative (can't hand out more than it has left)
 *  - the player's own cap (`playerCap`; pass null for Gold, which is
 *    uncapped per player)
 *
 * If `amount` would exceed either limit, only as much as fits is
 * transferred — the rules don't say a gain beyond the cap is lost, so the
 * untransferred remainder simply stays in the bank rather than vanishing.
 * Never goes negative in either direction.
 */
export function gainResource(
  resources: Resources,
  bank: Resources,
  resourceId: keyof Resources,
  amount: number,
  playerCap: number | null,
): { resources: Resources; bank: Resources } {
  const bankAvailable = bank[resourceId]
  const roomUnderCap = playerCap === null ? Infinity : Math.max(0, playerCap - resources[resourceId])
  const actualGain = Math.max(0, Math.min(amount, bankAvailable, roomUnderCap))

  return {
    resources: { ...resources, [resourceId]: resources[resourceId] + actualGain },
    bank: { ...bank, [resourceId]: bank[resourceId] - actualGain },
  }
}

/**
 * Moves `amount` of one resource from a player's holding back to the shared
 * bank (e.g. paying an action's cost). Returns null if the player doesn't
 * have that much to spend — callers should surface that as a validation
 * error rather than silently spending a partial amount.
 */
export function spendResource(
  resources: Resources,
  bank: Resources,
  resourceId: keyof Resources,
  amount: number,
): { resources: Resources; bank: Resources } | null {
  if (amount > resources[resourceId]) return null

  return {
    resources: { ...resources, [resourceId]: resources[resourceId] - amount },
    bank: { ...bank, [resourceId]: bank[resourceId] + amount },
  }
}

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
  const actualGain = actualGainAmount(resources, bank, resourceId, amount, playerCap)

  return {
    resources: { ...resources, [resourceId]: resources[resourceId] + actualGain },
    bank: { ...bank, [resourceId]: bank[resourceId] - actualGain },
  }
}

function actualGainAmount(resources: Resources, bank: Resources, resourceId: keyof Resources, amount: number, playerCap: number | null): number {
  const bankAvailable = bank[resourceId]
  const roomUnderCap = playerCap === null ? Infinity : Math.max(0, playerCap - resources[resourceId])
  return Math.max(0, Math.min(amount, bankAvailable, roomUnderCap))
}

/**
 * Whether gaining `amount` of `resourceId` would actually change anything —
 * false if `amount` isn't positive, the bank has none left to give, or the
 * player is already at their cap. Shared by gainResource's caller
 * (creditResource in ./unitActions.ts, so a fully-clamped credit is a
 * true no-op — same object reference back out — rather than a
 * value-identical-but-new one that would slip past the "did this action
 * actually do anything" check in applyResolveUnitAction) and by
 * isActionAvailableForUnit (./actionTargeting.ts, so the UI never offers
 * an income/produce/trade/trade-resource option that's guaranteed to
 * accomplish nothing, e.g. Produce Resource once a capped resource like
 * Wood or Stone is maxed out).
 */
export function wouldGainResource(resources: Resources, bank: Resources, resourceId: keyof Resources, amount: number, playerCap: number | null): boolean {
  return actualGainAmount(resources, bank, resourceId, amount, playerCap) > 0
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

/**
 * Renders how a player's resources actually changed between two snapshots
 * as a parenthesized log suffix, e.g. " (+3 gold)" or " (+1 wood, -5
 * gold)" — comparing actual before/after values (not an action's nominal
 * effect) so it reflects reality even when a gain was clamped by a
 * player/bank cap. Empty string if nothing changed (e.g. an Income action
 * with no qualifying adjacent units). Used by applyResolveUnitAction
 * (./applyAction.ts) so the log records what a resolved action actually
 * produced/cost, not just its name.
 */
export function describeResourceDelta(before: Resources, after: Resources): string {
  const parts: string[] = []
  for (const key of ['gold', 'wood', 'stone'] as const) {
    const delta = after[key] - before[key]
    if (delta !== 0) parts.push(`${delta > 0 ? '+' : ''}${delta} ${key}`)
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

/**
 * Unit markers are drawn with a short label instead of an icon — but every
 * kind's first letter alone isn't unique (Merchant and Mountaineer both
 * start with 'M'), which made the two indistinguishable on the board.
 * Explicit per-kind labels, falling back to the first letter for any kind
 * not listed (there shouldn't be one, but this keeps an unrecognized kind
 * visible instead of blank). Kept in its own module (not HexBoard.tsx,
 * which only exports components) so React Fast Refresh isn't disabled for
 * that file.
 */
const UNIT_KIND_LABEL: Record<string, string> = {
  city: 'C',
  temple: 'T',
  nomad: 'N',
  merchant: 'Mr',
  mountaineer: 'Mt',
  ship: 'S',
}

export function unitKindLabel(kind: string): string {
  return UNIT_KIND_LABEL[kind] ?? kind.slice(0, 1).toUpperCase()
}

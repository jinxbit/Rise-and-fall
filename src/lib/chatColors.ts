// Site-wide chat name coloring (issue #581, CHAT_PLAN.md §15). Unlike
// in-game chat (colored from the sender's actual PlayerRow.color), a
// site-wide sender has no seat or stored color at all, and the issue asks
// for the color to be "persistent" without adding one: hashing the display
// name deterministically gives every client the same color for the same
// name, with nothing to store or sync.

/** FNV-1a — a small, dependency-free string hash good enough for picking a hue, not for anything security-sensitive. */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Deterministic display-name -> color. Fixed saturation/lightness (only the
 * hue varies) so every generated color stays legible as chat text on the
 * dark `ChatPanel` background regardless of which name produced it.
 */
export function hashDisplayNameToColor(name: string): string {
  const hue = hashString(name) % 360
  return `hsl(${hue}, 70%, 70%)`
}

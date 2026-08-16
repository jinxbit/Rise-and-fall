const ADJECTIVES = [
  'Crimson',
  'Silent',
  'Frozen',
  'Golden',
  'Restless',
  'Ancient',
  'Roaring',
  'Shattered',
  'Hidden',
  'Stormy',
  'Iron',
  'Bold',
]

const NOUNS = [
  'Summit',
  'Throne',
  'Frontier',
  'Citadel',
  'Harbor',
  'Wilds',
  'Dominion',
  'Legion',
  'Outpost',
  'Reckoning',
  'Vanguard',
  'Skyline',
]

/** A friendly default room name, e.g. "Frozen Citadel". Falls back to today's date if word lists are unavailable. */
export function randomRoomName(): string {
  if (ADJECTIVES.length === 0 || NOUNS.length === 0) {
    return new Date().toLocaleDateString()
  }
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adjective} ${noun}`
}

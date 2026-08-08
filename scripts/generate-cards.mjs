// Generates standard poker-sized (2.5in x 3.5in @300dpi = 750x1050px) SVG
// playing cards, one per unit in src/content/units.json, plus a shared card
// back. Card content (name, movement, actions, costs) is read straight from
// the JSON so the art stays in sync as the ruleset is edited.
//
// Usage: node scripts/generate-cards.mjs [outDir]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { unitArtFor } from './unit-art.mjs'
import { resourceIcon, actionTypeIcon, terrainIcon, badgeIcon } from './icons.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const outDir = process.argv[2] ?? join(repoRoot, 'public/cards')
mkdirSync(outDir, { recursive: true })

const unitsJson = JSON.parse(readFileSync(join(repoRoot, 'src/content/units.json'), 'utf8'))

const CARD_W = 750
const CARD_H = 1050

const THEMES = {
  city: {
    frameFrom: '#8a5a12', frameTo: '#e0a83f',
    accent: '#8a5a12', accentDark: '#5f3d0c',
    artFrom: '#fbe9c9', artTo: '#f0b86e',
    stripe: '#f0e6d2',
  },
  temple: {
    frameFrom: '#5b0fb8', frameTo: '#aa3bff',
    accent: '#7e14ff', accentDark: '#4b0f8a',
    artFrom: '#efe4ff', artTo: '#c9a6ff',
    stripe: '#ece0fa',
  },
  nomad: {
    frameFrom: '#6b4420', frameTo: '#c98a3d',
    accent: '#8a5a2b', accentDark: '#5f3d1c',
    artFrom: '#f6e2b8', artTo: '#e3b673',
    stripe: '#efe2c4',
  },
  merchant: {
    frameFrom: '#0f6b5c', frameTo: '#35b596',
    accent: '#0f6b5c', accentDark: '#0a4a40',
    artFrom: '#d8f5ec', artTo: '#9fe0cc',
    stripe: '#dcf2ea',
  },
  mountaineer: {
    frameFrom: '#2c3e54', frameTo: '#6b84a3',
    accent: '#3f5670', accentDark: '#25384d',
    artFrom: '#eaf1f7', artTo: '#b9cbdc',
    stripe: '#e2e9f0',
  },
  ship: {
    frameFrom: '#0b3f6b', frameTo: '#3f9be0',
    accent: '#0b4f8a', accentDark: '#083a63',
    artFrom: '#d7ecff', artTo: '#8ecbf5',
    stripe: '#dcedfb',
  },
}

const TITLE_FONT = "Georgia, 'Times New Roman', serif"
const BODY_FONT = "'Trebuchet MS', 'Segoe UI', Verdana, sans-serif"

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function textWidth(str, fontSize, factor = 0.56) {
  return str.length * fontSize * factor
}

function wrapText(text, maxWidthPx, fontSizePx, factor = 0.54) {
  const maxChars = Math.max(10, Math.floor(maxWidthPx / (fontSizePx * factor)))
  const words = text.split(' ')
  const lines = []
  let cur = ''
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w
    if (test.length > maxChars && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = test
    }
  }
  if (cur) lines.push(cur)
  return lines
}

function synthesizeDescription(effect) {
  if (effect.actionType === 'transform') {
    const loc = effect.targetHex?.location === 'self' ? 'its own hex' : 'an adjacent hex'
    const terrains = effect.targetHex?.terrainType
    const terrainStr = terrains?.length ? ` (${terrains.join('/')} only)` : ''
    return `Transform into a ${effect.targetUnit} on ${loc}${terrainStr}.`
  }
  if (effect.actionType === 'trade' && effect.goldPerCity !== undefined) {
    return `Gain ${effect.goldPerCity} gold for each adjacent City.`
  }
  return ''
}

function describeAction(action) {
  return action.description?.trim() ? action.description.trim() : synthesizeDescription(action.effect)
}

const ACTION_ICON_KEY = {
  create: 'create',
  transform: 'transform',
  income: 'income',
  produce: 'produce',
  convert: 'convert',
  trade: 'trade',
  'trade-resource': 'trade',
}

function costPipsFor(action) {
  const cost = action.effect?.cost
  if (!cost) return []
  return ['gold', 'wood', 'stone']
    .filter((k) => (cost[k] ?? 0) > 0)
    .map((k) => ({ type: k, value: cost[k] }))
}

function renderCostPips(pips, rightX, centerY) {
  if (pips.length === 0) return ''
  const pipGap = 16
  const iconR = 9
  const parts = pips.map((p) => {
    const numStr = String(p.value)
    const numW = textWidth(numStr, 15, 0.58)
    return { ...p, width: iconR * 2 + 4 + numW }
  })
  const totalW = parts.reduce((a, p) => a + p.width, 0) + pipGap * (parts.length - 1)
  let x = rightX - totalW
  let out = ''
  for (const p of parts) {
    out += `<g transform="translate(${x + iconR},${centerY}) scale(0.9)">${resourceIcon[p.type]()}</g>`
    out += `<text x="${x + iconR * 2 + 6}" y="${centerY + 5}" font-family="${BODY_FONT}" font-size="15" font-weight="700" fill="#3a2f22">${p.value}</text>`
    x += parts.find((pp) => pp === p).width + pipGap
  }
  return out
}

function roundedTopRectPath(x, y, w, h, r) {
  return `M ${x + r},${y} H ${x + w - r} A ${r},${r} 0 0 1 ${x + w},${y + r} V ${y + h} H ${x} V ${y + r} A ${r},${r} 0 0 1 ${x + r},${y} Z`
}

function typeLineText(unit) {
  return unit.movement.isMobile ? 'UNIT  ·  MOBILE' : 'STRUCTURE  ·  STATIONARY'
}

const TERRAIN_ORDER = ['water', 'plain', 'forest', 'mountain', 'glacier']

function statsRow(unit, theme, x, y, w, h) {
  const cy = y + h / 2
  const chips = []
  if (unit.movement.isMobile) {
    if (unit.movement.moveDistance) {
      chips.push({ icon: badgeIcon.move(theme.accentDark), label: `Move ${unit.movement.moveDistance}` })
    }
    for (const t of TERRAIN_ORDER) {
      if (unit.movement.terrains?.includes(t)) {
        chips.push({ icon: terrainIcon[t](), label: t[0].toUpperCase() + t.slice(1) })
      }
    }
    if (unit.movement.canCrossCliffs) {
      chips.push({ icon: badgeIcon.cliff(theme.accentDark), label: 'Crosses Cliffs' })
    }
  } else {
    chips.push({ icon: badgeIcon.stationary(theme.accentDark), label: 'Cannot Move' })
  }

  const STATS_TIERS = [
    { fontSize: 15, iconSize: 24, gap: 22 },
    { fontSize: 14, iconSize: 22, gap: 16 },
    { fontSize: 13, iconSize: 20, gap: 12 },
    { fontSize: 11.5, iconSize: 18, gap: 8 },
    { fontSize: 10, iconSize: 16, gap: 6 },
  ]
  const availW = w - 32
  let picked = STATS_TIERS[STATS_TIERS.length - 1]
  let withLabels
  let totalW
  for (const tier of STATS_TIERS) {
    const wl = chips.map((c) => ({
      ...c,
      width: tier.iconSize + 6 + textWidth(c.label, tier.fontSize, 0.55),
    }))
    const tw = wl.reduce((a, c) => a + c.width, 0) + tier.gap * (wl.length - 1)
    if (tw <= availW) {
      picked = tier
      withLabels = wl
      totalW = tw
      break
    }
    withLabels = wl
    totalW = tw
  }
  const { fontSize, iconSize, gap: chipGap } = picked
  let cx = x + (w - totalW) / 2

  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#ffffff" fill-opacity="0.6" stroke="${theme.accent}" stroke-width="2"/>`
  for (const c of withLabels) {
    out += `<g transform="translate(${cx + iconSize / 2},${cy}) scale(${iconSize / 26})">${c.icon}</g>`
    out += `<text x="${cx + iconSize + 6}" y="${cy + 5}" font-family="${BODY_FONT}" font-size="${fontSize}" font-weight="600" fill="${theme.accentDark}">${esc(c.label)}</text>`
    cx += c.width + chipGap
  }
  return out
}

const FIT_TIERS = [
  { title: 23, desc: 18, titleGap: 6, descLineH: 22, gap: 16 },
  { title: 21, desc: 17, titleGap: 5, descLineH: 20, gap: 13 },
  { title: 20, desc: 16, titleGap: 5, descLineH: 19, gap: 11 },
  { title: 18, desc: 15, titleGap: 4, descLineH: 17, gap: 9 },
  { title: 17, desc: 14, titleGap: 4, descLineH: 16, gap: 7 },
]

function layoutActions(actions, contentW, availH) {
  const descW = contentW - 40
  for (const tier of FIT_TIERS) {
    let total = 0
    const withLines = actions.map((a) => {
      const lines = wrapText(a.desc, descW, tier.desc)
      total += tier.title + tier.titleGap + lines.length * tier.descLineH
      return { ...a, lines }
    })
    total += tier.gap * (actions.length - 1)
    if (total <= availH || tier === FIT_TIERS[FIT_TIERS.length - 1]) {
      return { tier, actions: withLines, total }
    }
  }
}

function rulesBox(unit, theme, x, y, w, h) {
  const contentX = x + 24
  const contentW = w - 48
  const availH = h - 40

  const actions = unit.actions.map((a) => ({
    id: a.id,
    name: a.name,
    desc: describeAction(a),
    iconKey: ACTION_ICON_KEY[a.effect?.actionType] ?? 'create',
    pips: costPipsFor(a),
  }))

  const { tier, actions: laidOut } = layoutActions(actions, contentW, availH)

  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#fffaf2" stroke="${theme.accent}" stroke-width="2.5"/>`

  let cy = y + 22
  laidOut.forEach((a, i) => {
    const iconCy = cy + tier.title / 2 - 2
    out += `<g transform="translate(${contentX + 14},${iconCy}) scale(1.05)">${actionTypeIcon[a.iconKey](theme.accent)}</g>`
    out += `<text x="${contentX + 38}" y="${cy + tier.title * 0.72}" font-family="${BODY_FONT}" font-size="${tier.title}" font-weight="700" fill="#2c2313">${esc(a.name)}</text>`
    if (a.pips.length) {
      out += renderCostPips(a.pips, contentX + contentW, iconCy)
    }
    let ly = cy + tier.title + tier.titleGap + tier.descLineH * 0.78
    for (const line of a.lines) {
      out += `<text x="${contentX + 38}" y="${ly}" font-family="${BODY_FONT}" font-size="${tier.desc}" fill="#5a4f3d">${esc(line)}</text>`
      ly += tier.descLineH
    }
    cy += tier.title + tier.titleGap + a.lines.length * tier.descLineH
    if (i < laidOut.length - 1) {
      cy += tier.gap / 2
      out += `<line x1="${contentX}" y1="${cy}" x2="${contentX + contentW}" y2="${cy}" stroke="${theme.accent}" stroke-opacity="0.22" stroke-width="1.5"/>`
      cy += tier.gap / 2
    }
  })

  return out
}

function buildCard(unit, index, total) {
  const theme = THEMES[unit.id]
  const x0 = 26
  const y0 = 26
  const IW = CARD_W - x0 * 2
  const IH = CARD_H - y0 * 2

  const titleH = 100
  const stripeH = 40
  const artY = y0 + titleH + stripeH + 14
  const artH = 336
  const artX = x0 + 22
  const artW = IW - 44

  const statsY = artY + artH + 14
  const statsH = 54

  const rulesY = statsY + statsH + 20
  const rulesX = x0 + 22
  const rulesW = IW - 44
  const footerH = 34
  const rulesH = y0 + IH - footerH - 10 - rulesY

  const artScale = Math.min((artW - 40) / 320, (artH - 40) / 320)
  const artCx = artX + artW / 2
  const artCy = artY + artH / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <defs>
    <linearGradient id="frame-${unit.id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${theme.frameFrom}"/>
      <stop offset="1" stop-color="${theme.frameTo}"/>
    </linearGradient>
    <linearGradient id="title-${unit.id}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${theme.frameFrom}"/>
      <stop offset="1" stop-color="${theme.frameTo}"/>
    </linearGradient>
    <linearGradient id="art-${unit.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${theme.artFrom}"/>
      <stop offset="1" stop-color="${theme.artTo}"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="42" fill="url(#frame-${unit.id})"/>
  <rect x="${x0}" y="${y0}" width="${IW}" height="${IH}" rx="30" fill="#faf6ee" stroke="${theme.accent}" stroke-width="2"/>

  <path d="${roundedTopRectPath(x0, y0, IW, titleH, 30)}" fill="url(#title-${unit.id})"/>
  <text x="${x0 + IW / 2}" y="${y0 + 66}" text-anchor="middle" font-family="${TITLE_FONT}" font-size="46" font-weight="700" fill="${theme.accentDark}" opacity="0.35">${esc(unit.name)}</text>
  <text x="${x0 + IW / 2}" y="${y0 + 63}" text-anchor="middle" font-family="${TITLE_FONT}" font-size="46" font-weight="700" fill="#fff8ea">${esc(unit.name)}</text>

  <rect x="${x0}" y="${y0 + titleH}" width="${IW}" height="${stripeH}" fill="${theme.stripe}"/>
  <text x="${x0 + IW / 2}" y="${y0 + titleH + 27}" text-anchor="middle" font-family="${BODY_FONT}" font-size="18" font-weight="700" letter-spacing="3" fill="${theme.accentDark}">${typeLineText(unit)}</text>

  <rect x="${artX}" y="${artY}" width="${artW}" height="${artH}" rx="18" fill="url(#art-${unit.id})" stroke="${theme.accent}" stroke-width="4"/>
  <g clip-path="url(#artclip-${unit.id})">
    <clipPath id="artclip-${unit.id}"><rect x="${artX + 2}" y="${artY + 2}" width="${artW - 4}" height="${artH - 4}" rx="16"/></clipPath>
    <g transform="translate(${artCx},${artCy}) scale(${artScale}) translate(-160,-160)">
      ${unitArtFor(unit.id)}
    </g>
  </g>

  ${statsRow(unit, theme, artX, statsY, artW, statsH)}

  ${rulesBox(unit, theme, rulesX, rulesY, rulesW, rulesH)}

  <line x1="${x0 + 40}" y1="${y0 + IH - footerH - 2}" x2="${x0 + IW - 40}" y2="${y0 + IH - footerH - 2}" stroke="${theme.accent}" stroke-opacity="0.3" stroke-width="1.5"/>
  <text x="${x0 + 22}" y="${y0 + IH - 12}" font-family="${BODY_FONT}" font-size="14" letter-spacing="2" fill="${theme.accentDark}" opacity="0.75">RISE &amp; FALL</text>
  <text x="${x0 + IW - 22}" y="${y0 + IH - 12}" text-anchor="end" font-family="${BODY_FONT}" font-size="14" letter-spacing="1" fill="${theme.accentDark}" opacity="0.75">${index} / ${total}</text>
</svg>
`
}

function buildCardBack() {
  const x0 = 26
  const y0 = 26
  const IW = CARD_W - x0 * 2
  const IH = CARD_H - y0 * 2
  const cx = CARD_W / 2
  const cy = CARD_H / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
  <defs>
    <linearGradient id="back-frame" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3d0f80"/>
      <stop offset="1" stop-color="#aa3bff"/>
    </linearGradient>
    <radialGradient id="back-field" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0" stop-color="#6a1fc9"/>
      <stop offset="1" stop-color="#2c0a5c"/>
    </radialGradient>
    <linearGradient id="back-emblem" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4e7ff"/>
      <stop offset="1" stop-color="#c9a0ff"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="42" fill="url(#back-frame)"/>
  <rect x="${x0}" y="${y0}" width="${IW}" height="${IH}" rx="30" fill="url(#back-field)" stroke="#f4e7ff" stroke-width="2"/>
  <rect x="${x0 + 20}" y="${y0 + 20}" width="${IW - 40}" height="${IH - 40}" rx="22" fill="none" stroke="#c9a0ff" stroke-width="2" stroke-opacity="0.6"/>
  <rect x="${x0 + 32}" y="${y0 + 32}" width="${IW - 64}" height="${IH - 64}" rx="16" fill="none" stroke="#c9a0ff" stroke-width="1.5" stroke-opacity="0.4"/>

  <g transform="translate(${cx},${cy - 40})">
    <polygon points="0,-92 78,-46 78,46 0,92 -78,46 -78,-46" fill="none" stroke="#f4e7ff" stroke-width="3" stroke-opacity="0.85"/>
    <polygon points="0,-64 54,-32 54,32 0,64 -54,32 -54,-32" fill="url(#back-emblem)" opacity="0.92"/>
    <polygon points="0,-38 32,-19 32,19 0,38 -32,19 -32,-19" fill="#6a1fc9"/>
    <circle cx="0" cy="0" r="10" fill="#f4e7ff"/>
  </g>

  <text x="${cx}" y="${cy + 130}" text-anchor="middle" font-family="${TITLE_FONT}" font-size="40" font-weight="700" letter-spacing="4" fill="#f4e7ff">RISE &amp; FALL</text>
  <text x="${cx}" y="${cy + 164}" text-anchor="middle" font-family="${BODY_FONT}" font-size="16" letter-spacing="6" fill="#c9a0ff">UNIT CARD</text>
</svg>
`
}

const units = unitsJson.units
units.forEach((unit, i) => {
  const svg = buildCard(unit, i + 1, units.length)
  writeFileSync(join(outDir, `${unit.id}.svg`), svg)
  console.log('wrote', join(outDir, `${unit.id}.svg`))
})
writeFileSync(join(outDir, 'card-back.svg'), buildCardBack())
console.log('wrote', join(outDir, 'card-back.svg'))

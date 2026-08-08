// Flat-vector illustrations for each unit, in a 320x320 box centered at (160,160).
// Pure SVG markup fragments (no <svg> wrapper) so they can be embedded in cards
// or rendered standalone for preview.

const peg = ({
  robeFill,
  robeTrim,
  hoodFill,
  skinFill = '#e3b78a',
  hoodOpen = false,
}) => `
  <path d="M110,150 Q112,118 160,108 Q208,118 210,150 L232,175 Q258,205 264,278 L56,278 Q62,205 88,175 Z"
        fill="${robeFill}" stroke="${robeTrim}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M56,278 L264,278 L258,262 L62,262 Z" fill="${robeTrim}" opacity="0.55"/>
  <path d="M124,150 L136,278 M160,148 L160,278 M196,150 L184,278" stroke="${robeTrim}" stroke-width="3" opacity="0.4" fill="none"/>
  ${hoodOpen ? '' : `<path d="M112,120 Q118,58 160,54 Q202,58 208,120 Q188,90 160,88 Q132,90 112,120 Z" fill="${hoodFill}" stroke="${robeTrim}" stroke-width="4" stroke-linejoin="round"/>`}
  <circle cx="160" cy="106" r="30" fill="${skinFill}"/>
  ${hoodOpen ? '' : `<path d="M132,96 Q160,76 188,96 Q188,80 160,74 Q132,80 132,96 Z" fill="${hoodFill}"/>`}
`

const unitArt = {
  city: `
    <ellipse cx="160" cy="272" rx="146" ry="26" fill="#6f8f4a"/>
    <circle cx="246" cy="62" r="24" fill="#ffd76a"/>
    <g stroke="#ffd76a" stroke-width="4" stroke-linecap="round">
      <line x1="246" y1="24" x2="246" y2="10"/>
      <line x1="280" y1="40" x2="292" y2="30"/>
      <line x1="292" y1="70" x2="306" y2="70"/>
    </g>
    <rect x="46" y="252" width="228" height="14" rx="4" fill="#9c9c8c"/>
    <g>
      <rect x="58" y="182" width="62" height="82" fill="#c98a3d" stroke="#8a4a26" stroke-width="3"/>
      <polygon points="52,182 126,182 89,142" fill="#8a4a26" stroke="#5f3116" stroke-width="3" stroke-linejoin="round"/>
      <rect x="78" y="216" width="16" height="16" fill="#5f3116"/>
      <rect x="80" y="238" width="18" height="26" fill="#5f3116"/>
    </g>
    <g>
      <rect x="206" y="192" width="58" height="72" fill="#c98a3d" stroke="#8a4a26" stroke-width="3"/>
      <polygon points="200,192 270,192 235,156" fill="#8a4a26" stroke="#5f3116" stroke-width="3" stroke-linejoin="round"/>
      <rect x="222" y="222" width="16" height="16" fill="#5f3116"/>
    </g>
    <g>
      <rect x="128" y="122" width="76" height="140" fill="#d69a4e" stroke="#7a3f20" stroke-width="4"/>
      <polygon points="120,122 216,122 168,66" fill="#7a3f20" stroke="#4a260f" stroke-width="4" stroke-linejoin="round"/>
      <rect x="146" y="150" width="18" height="18" fill="#4a260f"/>
      <rect x="176" y="150" width="18" height="18" fill="#4a260f"/>
      <rect x="152" y="212" width="32" height="50" fill="#4a260f"/>
      <line x1="168" y1="66" x2="168" y2="30" stroke="#4a260f" stroke-width="4" stroke-linecap="round"/>
      <polygon points="168,30 196,40 168,50" fill="#b8322f" stroke="#4a260f" stroke-width="2" stroke-linejoin="round"/>
    </g>
  `,
  temple: `
    <rect x="46" y="246" width="228" height="26" rx="4" fill="#d8cdb2" stroke="#b3a486" stroke-width="3"/>
    <rect x="66" y="224" width="188" height="24" rx="3" fill="#e4dac0" stroke="#b3a486" stroke-width="3"/>
    <rect x="86" y="203" width="148" height="23" rx="3" fill="#efe6cf" stroke="#b3a486" stroke-width="3"/>
    <g stroke="#b3a486" stroke-width="4">
      <rect x="93" y="96" width="20" height="112" fill="#f7f1e2"/>
      <rect x="133" y="96" width="20" height="112" fill="#f7f1e2"/>
      <rect x="173" y="96" width="20" height="112" fill="#f7f1e2"/>
      <rect x="213" y="96" width="20" height="112" fill="#f7f1e2"/>
    </g>
    <rect x="88" y="88" width="150" height="12" fill="#e4dac0" stroke="#b3a486" stroke-width="3"/>
    <polygon points="80,88 246,88 163,38" fill="#e9dcff" stroke="#8a3bdb" stroke-width="4" stroke-linejoin="round"/>
    <circle cx="163" cy="66" r="15" fill="#f6efff" stroke="#8a3bdb" stroke-width="3"/>
    <circle cx="163" cy="66" r="6" fill="#aa3bff"/>
    <g stroke="#c79bff" stroke-width="3" stroke-linecap="round">
      <line x1="163" y1="46" x2="163" y2="36"/>
      <line x1="144" y1="56" x2="136" y2="49"/>
      <line x1="182" y1="56" x2="190" y2="49"/>
      <line x1="144" y1="76" x2="136" y2="83"/>
      <line x1="182" y1="76" x2="190" y2="83"/>
    </g>
  `,
  nomad: `
    ${peg({ robeFill: '#caa06a', robeTrim: '#8a6a3f', hoodFill: '#a9815a' })}
    <line x1="220" y1="284" x2="240" y2="96" stroke="#6b4a2b" stroke-width="7" stroke-linecap="round"/>
    <circle cx="241" cy="90" r="10" fill="#d9b46a" stroke="#6b4a2b" stroke-width="3"/>
    <path d="M118,182 Q90,190 92,222 Q94,246 122,250" fill="none" stroke="#6b4a2b" stroke-width="6" stroke-linecap="round"/>
    <circle cx="94" cy="228" r="20" fill="#a9815a" stroke="#6b4a2b" stroke-width="4"/>
    <g fill="#c9b389" opacity="0.85">
      <ellipse cx="44" cy="292" rx="14" ry="5"/>
      <ellipse cx="20" cy="298" rx="10" ry="4"/>
    </g>
  `,
  merchant: `
    ${peg({ robeFill: '#2f8f74', robeTrim: '#1c5c49', hoodFill: '#e0c34a', hoodOpen: true })}
    <rect x="132" y="70" width="56" height="14" rx="6" fill="#e0c34a" stroke="#8a6d1a" stroke-width="2"/>
    <g stroke="#6b4a2b" stroke-width="5" stroke-linecap="round">
      <line x1="234" y1="286" x2="234" y2="150"/>
      <line x1="206" y1="156" x2="262" y2="156"/>
    </g>
    <line x1="212" y1="160" x2="206" y2="184" stroke="#8a6d1a" stroke-width="3"/>
    <line x1="256" y1="160" x2="262" y2="184" stroke="#8a6d1a" stroke-width="3"/>
    <path d="M198,184 Q206,200 214,184 Z" fill="none" stroke="#d4af37" stroke-width="3"/>
    <path d="M254,184 Q262,200 270,184 Z" fill="none" stroke="#d4af37" stroke-width="3"/>
    <path d="M96,196 Q78,196 76,222 Q75,250 100,256 Q122,250 120,222 Q118,196 96,196 Z"
          fill="#d4af37" stroke="#8a6d1a" stroke-width="4" stroke-linejoin="round"/>
    <line x1="86" y1="204" x2="106" y2="204" stroke="#8a6d1a" stroke-width="3"/>
    <circle cx="97" cy="226" r="8" fill="#8a6d1a"/>
  `,
  mountaineer: `
    <polygon points="20,282 108,150 160,220 200,168 300,282" fill="#7f97b3" stroke="#556a85" stroke-width="4" stroke-linejoin="round"/>
    <polygon points="80,196 108,150 138,196" fill="#f2f6fa" stroke="#556a85" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="176,198 200,168 224,200" fill="#f2f6fa" stroke="#556a85" stroke-width="3" stroke-linejoin="round"/>
    ${peg({ robeFill: '#3f5670', robeTrim: '#25384d', hoodFill: '#3f5670', hoodOpen: true })}
    <path d="M128,86 Q160,64 192,86 L188,104 Q160,90 132,104 Z" fill="#e9edf2" stroke="#25384d" stroke-width="3"/>
    <g fill="none" stroke="#c9b389" stroke-width="4">
      <circle cx="96" cy="230" r="16"/>
      <circle cx="96" cy="230" r="10"/>
    </g>
    <g stroke="#5a5a5a" stroke-width="6" stroke-linecap="round">
      <line x1="222" y1="204" x2="270" y2="122"/>
    </g>
    <path d="M270,122 L242,100 Q262,96 278,108 Z" fill="#8b8b8b" stroke="#4a4a4a" stroke-width="3" stroke-linejoin="round"/>
    <path d="M270,122 L296,138 Q280,146 262,136 Z" fill="#8b8b8b" stroke="#4a4a4a" stroke-width="3" stroke-linejoin="round"/>
  `,
  ship: `
    <g stroke="#3f9be0" stroke-width="5" fill="none" stroke-linecap="round" opacity="0.8">
      <path d="M10,268 Q45,254 80,268 T150,268 T220,268 T290,268 T360,268" />
      <path d="M0,288 Q35,276 70,288 T140,288 T210,288 T280,288 T350,288" opacity="0.6"/>
    </g>
    <path d="M60,222 Q60,250 100,256 L220,256 Q260,250 260,222 Q220,238 160,238 Q100,238 60,222 Z"
          fill="#7a4a26" stroke="#4a2c14" stroke-width="4" stroke-linejoin="round"/>
    <path d="M60,222 Q100,236 160,236 Q220,236 260,222" fill="none" stroke="#5a3419" stroke-width="3"/>
    <path d="M50,222 Q40,214 52,202 Q66,196 60,222 Z" fill="#7a4a26" stroke="#4a2c14" stroke-width="3" stroke-linejoin="round"/>
    <line x1="160" y1="240" x2="160" y2="76" stroke="#5a3419" stroke-width="7" stroke-linecap="round"/>
    <line x1="160" y1="96" x2="212" y2="96" stroke="#4a2c14" stroke-width="4" stroke-linecap="round"/>
    <path d="M164,92 Q222,118 172,224 Q152,148 164,92 Z" fill="#f2ead9" stroke="#c9bfa0" stroke-width="3" stroke-linejoin="round"/>
    <path d="M170,110 Q186,150 172,196" fill="none" stroke="#d9cfb4" stroke-width="2"/>
    <polygon points="160,76 190,84 160,92" fill="#0b4f8a" stroke="#083a63" stroke-width="2" stroke-linejoin="round"/>
  `,
}

export function unitArtFor(unitId) {
  return unitArt[unitId] ?? ''
}

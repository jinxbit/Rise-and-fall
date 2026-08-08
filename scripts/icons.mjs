// Small glyph icons, each centered on (0,0) in roughly a 24x24 box.
// Wrap with <g transform="translate(x,y) scale(s)"> to place/size them.

export const resourceIcon = {
  gold: () => `
    <circle r="10" fill="#f0c419" stroke="#8a6d1a" stroke-width="2"/>
    <circle r="5.5" fill="none" stroke="#8a6d1a" stroke-width="1.5"/>
  `,
  wood: () => `
    <rect x="-11" y="-6" width="22" height="12" rx="6" fill="#8a5a2b" stroke="#5a3719" stroke-width="1.5"/>
    <ellipse cx="-9" cy="0" rx="3" ry="5.5" fill="none" stroke="#5a3719" stroke-width="1.3"/>
  `,
  stone: () => `
    <polygon points="-9,4 -6,-8 4,-9 10,-1 6,8 -4,9" fill="#a3a3a3" stroke="#6b6b6b" stroke-width="1.6" stroke-linejoin="round"/>
    <line x1="-3" y1="-3" x2="3" y2="1" stroke="#8a8a8a" stroke-width="1.2"/>
  `,
}

export const actionTypeIcon = {
  create: (color = '#3f8f4a') => `
    <circle r="13" fill="${color}" opacity="0.16"/>
    <circle r="13" fill="none" stroke="${color}" stroke-width="2.2"/>
    <line x1="-6" y1="0" x2="6" y2="0" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
    <line x1="0" y1="-6" x2="0" y2="6" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
  `,
  transform: (color = '#7e14ff') => `
    <circle r="13" fill="${color}" opacity="0.14"/>
    <path d="M -8,-2 A 9,9 0 0 1 8,-4" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
    <polygon points="8,-8 8,-1 2,-4" fill="${color}"/>
    <path d="M 8,2 A 9,9 0 0 1 -8,4" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
    <polygon points="-8,8 -8,1 -2,4" fill="${color}"/>
  `,
  income: (color = '#c99a2e') => `
    <circle r="13" fill="${color}" opacity="0.16"/>
    <circle cx="-4" cy="3" r="7" fill="none" stroke="${color}" stroke-width="2"/>
    <circle cx="4" cy="-3" r="7" fill="#fffaf2" stroke="${color}" stroke-width="2"/>
  `,
  produce: (color = '#4a8f4a') => `
    <circle r="13" fill="${color}" opacity="0.16"/>
    <line x1="0" y1="9" x2="0" y2="-6" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M 0,-6 C -2,-11 -8,-11 -10,-8 C -10,-3 -3,-1 0,-6 Z" fill="${color}"/>
    <line x1="-6" y1="-7" x2="-2" y2="-5" stroke="#ffffff" stroke-width="1" opacity="0.55"/>
  `,
  convert: (color = '#8a3bdb') => `
    <circle r="13" fill="${color}" opacity="0.16"/>
    <circle r="4.5" fill="${color}"/>
    <g stroke="${color}" stroke-width="2" stroke-linecap="round">
      <line x1="0" y1="-11" x2="0" y2="-7"/>
      <line x1="0" y1="7" x2="0" y2="11"/>
      <line x1="-11" y1="0" x2="-7" y2="0"/>
      <line x1="7" y1="0" x2="11" y2="0"/>
      <line x1="-7.8" y1="-7.8" x2="-5" y2="-5"/>
      <line x1="5" y1="5" x2="7.8" y2="7.8"/>
      <line x1="7.8" y1="-7.8" x2="5" y2="-5"/>
      <line x1="-5" y1="5" x2="-7.8" y2="7.8"/>
    </g>
  `,
  trade: (color = '#2b7bb9') => `
    <circle r="13" fill="${color}" opacity="0.16"/>
    <line x1="-8" y1="-3" x2="8" y2="-3" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
    <polygon points="8,-3 3,-7 3,1" fill="${color}"/>
    <line x1="8" y1="3" x2="-8" y2="3" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>
    <polygon points="-8,3 -3,7 -3,-1" fill="${color}"/>
  `,
}

export const terrainIcon = {
  water: (color = '#3f9be0') => `
    <circle r="9" fill="${color}" opacity="0.22"/>
    <path d="M -6,1 Q -3,-3 0,1 Q 3,-3 6,1" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
    <path d="M -6,5 Q -3,1 0,5 Q 3,1 6,5" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
  `,
  plain: (color = '#8fb84e') => `
    <circle r="9" fill="${color}" opacity="0.22"/>
    <circle r="5.5" fill="${color}"/>
  `,
  forest: (color = '#2f7a3f') => `
    <circle r="9" fill="${color}" opacity="0.22"/>
    <polygon points="0,-7 6,4 -6,4" fill="${color}"/>
    <rect x="-1.5" y="4" width="3" height="3" fill="${color}"/>
  `,
  mountain: (color = '#7f7f7f') => `
    <circle r="9" fill="${color}" opacity="0.22"/>
    <polygon points="-7,6 -1,-6 3,0 7,6" fill="${color}"/>
  `,
  glacier: (color = '#8ec7e0') => `
    <circle r="9" fill="${color}" opacity="0.22"/>
    <polygon points="-7,6 -1,-6 3,0 7,6" fill="${color}"/>
    <polygon points="-7,6 -1,-6 -3,3" fill="#ffffff"/>
  `,
}

export const badgeIcon = {
  stationary: (color = '#8a6a3f') => `
    <circle r="13" fill="${color}" opacity="0.16"/>
    <line x1="0" y1="-9" x2="0" y2="9" stroke="${color}" stroke-width="2.2"/>
    <line x1="-6" y1="9" x2="6" y2="9" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M -7,-4 Q 0,-11 7,-4" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="0" cy="-9" r="2.4" fill="${color}"/>
  `,
  move: (color = '#3f5670') => `
    <circle r="13" fill="${color}" opacity="0.16"/>
    <path d="M -3,-9 Q 3,-9 3,-4 Q 3,0 -2,2 L 4,9" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="-3" cy="-9" r="2" fill="${color}"/>
  `,
  cliff: (color = '#6b6b6b') => `
    <circle r="13" fill="${color}" opacity="0.16"/>
    <path d="M -9,7 L -2,7 L -2,-7 L 5,-2 L 5,7 L 9,7" fill="none" stroke="${color}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round"/>
  `,
}

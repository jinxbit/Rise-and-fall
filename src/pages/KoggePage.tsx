import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { countMarkers, describeBid, hasLegalBid } from '../kogge/bids'
import { BONUS_DESCRIPTIONS, BONUS_LABELS, markerColor } from '../kogge/board'
import {
  activePlayerId,
  buildCost,
  developmentPoints,
  emptyGoods,
  emptyMarkers,
  formatGoods,
  goodsTotal,
  guildmasterPath,
  nextMoveCost,
  playerName,
  replayKogge,
  validateKoggeAction,
  victoryPoints,
} from '../kogge/engine'
import {
  BONUS_TYPES,
  GOOD_COLORS,
  MARKER_VALUES,
  type BonusType,
  type GoodColor,
  type Goods,
  type KoggeAction,
  type KoggePlayer,
  type KoggeSetup,
  type KoggeState,
  type MarkerCounts,
  type Payment,
} from '../kogge/types'

/**
 * Hotseat Kogge (KOGGE_PLAN.md) — every player on one device. The game is
 * saved to localStorage as `{ setup, actions }` and rebuilt with
 * `replayKogge`, so undo is just dropping the last action. Everything is open
 * information except the secret starting-city pick and face-down routes.
 */

const STORAGE_KEY = 'kogge.hotseat.v1'
const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308']
const GOOD_HEX: Record<GoodColor, string> = { grey: '#9ca3af', orange: '#f97316', purple: '#a855f7', white: '#f5f5f5' }

interface SavedGame {
  setup: KoggeSetup
  actions: KoggeAction[]
}

function loadSaved(): SavedGame | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as SavedGame
    replayKogge(saved.setup, saved.actions)
    return saved
  } catch {
    return null
  }
}

function persist(saved: SavedGame | null) {
  try {
    if (saved) localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable — the game still runs for this tab.
  }
}

export function KoggePage() {
  const [saved, setSaved] = useState<SavedGame | null>(loadSaved)
  const [error, setError] = useState<string | null>(null)

  const state = useMemo(() => (saved ? replayKogge(saved.setup, saved.actions) : null), [saved])

  function update(next: SavedGame | null) {
    setSaved(next)
    persist(next)
  }

  function dispatch(action: KoggeAction) {
    if (!saved || !state) return
    const reason = validateKoggeAction(state, action)
    if (reason) {
      setError(reason)
      return
    }
    setError(null)
    update({ ...saved, actions: [...saved.actions, action] })
  }

  if (!saved || !state) return <KoggeSetupScreen onStart={(setup) => update({ setup, actions: [] })} />

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">← Home</Link>
          <h1 className="text-2xl font-semibold">Kogge</h1>
          <span className="text-sm text-neutral-400">{phaseLabel(state)}</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={saved.actions.length === 0}
            onClick={() => update({ ...saved, actions: saved.actions.slice(0, -1) })}
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-40"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Abandon this game and start a new one?')) update(null)
            }}
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500"
          >
            New game
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-center justify-between rounded-md border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200">
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-4 text-red-300 hover:text-red-100">✕</button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex flex-col gap-4">
          <KoggeBoard state={state} />
          <PlayersTable state={state} />
        </div>
        <div className="flex flex-col gap-4">
          <ControlPanel key={state.actionHistory.length} state={state} dispatch={dispatch} />
          <GameLog state={state} />
        </div>
      </div>
    </div>
  )
}

function phaseLabel(state: KoggeState): string {
  switch (state.phase) {
    case 'startPick':
      return 'Choosing starting cities'
    case 'auction':
      return `Round ${state.round} · Auction`
    case 'guildmaster':
      return `Round ${state.round} · Guildmaster`
    case 'actions':
      return `Round ${state.round} · Actions${state.finalRound ? ' (final round)' : ''}`
    case 'finished':
      return 'Game over'
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────

function KoggeSetupScreen({ onStart }: { onStart: (setup: KoggeSetup) => void }) {
  const [names, setNames] = useState(['', '', ''])
  const [seed, setSeed] = useState('')
  const filled = names.map((n) => n.trim()).filter(Boolean)

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-8">
      <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">← Home</Link>
      <h1 className="text-3xl font-semibold">Kogge</h1>
      <p className="text-sm text-neutral-400">
        Hotseat trading game for 2–4 players on this device. Sail between nine cities, trade goods, build houses, and race to five
        development points before the Guildmaster completes its second lap.
      </p>
      <div className="flex flex-col gap-2">
        {names.map((name, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ background: PLAYER_COLORS[i] }} />
            <input
              value={name}
              onChange={(e) => setNames(names.map((n, j) => (j === i ? e.target.value : n)))}
              placeholder={`Player ${i + 1}`}
              className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5"
            />
            {names.length > 2 && (
              <button type="button" onClick={() => setNames(names.filter((_, j) => j !== i))} className="text-neutral-500 hover:text-neutral-300">
                ✕
              </button>
            )}
          </div>
        ))}
        {names.length < 4 && (
          <button type="button" onClick={() => setNames([...names, ''])} className="self-start text-sm text-neutral-400 hover:text-neutral-200">
            + Add player
          </button>
        )}
      </div>
      <label className="flex flex-col gap-1 text-sm text-neutral-400">
        Seed (optional)
        <input value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))} className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-neutral-100" />
      </label>
      <button
        type="button"
        disabled={filled.length < 2 || filled.length !== names.length}
        onClick={() =>
          onStart({
            seed: seed ? Number(seed) : Math.floor(Math.random() * 2 ** 31),
            players: names.map((n, i) => ({ id: `p${i + 1}`, name: n.trim() })),
          })
        }
        className="rounded-md bg-amber-600 px-4 py-2 font-medium text-neutral-950 hover:bg-amber-500 disabled:opacity-40"
      >
        Start game
      </button>
      <p className="text-xs text-neutral-500">Rules reference: KOGGE_PLAN.md in the repository.</p>
    </div>
  )
}

// ─── Board ────────────────────────────────────────────────────────────────

function KoggeBoard({ state }: { state: KoggeState }) {
  const size = 560
  const center = size / 2
  const radius = 205
  const colorOf = (id: string) => PLAYER_COLORS[state.players.find((p) => p.id === id)?.seat ?? 0]

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full rounded-xl bg-sky-950/60" role="img" aria-label="Kogge board">
      <circle cx={center} cy={center} r={radius} fill="none" stroke="#1e3a5f" strokeWidth={28} />
      <text x={center} y={center - 8} textAnchor="middle" className="fill-sky-300/60 text-[13px]">
        Supply: {formatGoods(state.supply)}
      </text>
      <text x={center} y={center + 12} textAnchor="middle" className="fill-sky-300/60 text-[13px]">
        Guildmaster start: {state.guildmaster.start} · laps {state.guildmaster.returns}/2
      </text>
      <text x={center} y={center + 32} textAnchor="middle" className="fill-sky-300/60 text-[13px]">
        ↻ clockwise
      </text>
      {state.ring.map((cityNumber, idx) => {
        const angle = (idx / state.ring.length) * Math.PI * 2 - Math.PI / 2
        const x = center + Math.cos(angle) * radius
        const y = center + Math.sin(angle) * radius
        const city = state.cities[cityNumber]
        const houses = state.houses.filter((h) => h.city === cityNumber)
        const boats = state.players.filter((p) => p.boatCity === cityNumber)
        return (
          <g key={cityNumber} transform={`translate(${x} ${y})`}>
            <circle r={50} fill="#0f172a" stroke={GOOD_HEX[city.color]} strokeWidth={4} />
            <text y={-22} textAnchor="middle" className="fill-neutral-100 text-[22px] font-bold">
              {cityNumber}
            </text>
            {state.guildmaster.city === cityNumber && (
              <text x={-40} y={-34} className="fill-amber-300 text-[20px]">
                ♛
              </text>
            )}
            {state.guildmaster.start === cityNumber && (
              <text x={30} y={-34} className="fill-amber-500/70 text-[14px]">
                ⚑
              </text>
            )}
            {city.slots.map((slot, i) => (
              <g key={i} transform={`translate(${i === 0 ? -14 : 14} -2)`}>
                <rect x={-11} y={-11} width={22} height={20} rx={4} fill={slot.faceUp ? GOOD_HEX[markerColor(slot.value)] : '#334155'} />
                <text y={5} textAnchor="middle" className="fill-neutral-950 text-[13px] font-bold">
                  {slot.faceUp ? slot.value : '?'}
                </text>
              </g>
            ))}
            <g transform="translate(-24 18)">
              {GOOD_COLORS.map((c, i) => (
                <g key={c} transform={`translate(${i * 16} 0)`}>
                  <rect x={-5} y={-5} width={10} height={10} rx={2} fill={GOOD_HEX[c]} opacity={city.goods[c] > 0 ? 1 : 0.2} />
                  <text y={17} textAnchor="middle" className="fill-neutral-300 text-[10px]">
                    {city.goods[c]}
                  </text>
                </g>
              ))}
            </g>
            {houses.map((h, i) => (
              <g key={i} transform={`translate(-66 ${-12 + i * 26})`}>
                <path d="M -9 4 L 0 -6 L 9 4 L 9 13 L -9 13 Z" fill={colorOf(h.ownerId)} stroke="#0f172a" />
                {goodsTotal(h.goods) > 0 && (
                  <text x={0} y={11} textAnchor="middle" className="fill-neutral-950 text-[9px] font-bold">
                    {goodsTotal(h.goods)}
                  </text>
                )}
              </g>
            ))}
            {boats.map((p, i) => (
              <path
                key={p.id}
                transform={`translate(62 ${-16 + i * 14})`}
                d="M -9 0 L 9 0 L 6 6 L -6 6 Z M 0 0 L 0 -9 L 6 -2 Z"
                fill={PLAYER_COLORS[p.seat]}
                stroke="#0f172a"
              />
            ))}
            {city.raids.map((id, i) => (
              <text key={i} x={-10 + i * 12} y={64} className="text-[14px] font-bold" fill={colorOf(id)}>
                ✕
              </text>
            ))}
          </g>
        )
      })}
    </svg>
  )
}

// ─── Players, log ─────────────────────────────────────────────────────────

function GoodsChips({ goods }: { goods: Goods }) {
  return (
    <span className="inline-flex gap-1.5">
      {GOOD_COLORS.map((c) => (
        <span key={c} className="inline-flex items-center gap-0.5" title={c}>
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: GOOD_HEX[c] }} />
          {goods[c]}
        </span>
      ))}
    </span>
  )
}

function MarkerChips({ hand }: { hand: MarkerCounts }) {
  const held = hand.flatMap((n, v) => new Array<number>(n).fill(v))
  if (held.length === 0) return <span className="text-neutral-500">—</span>
  return (
    <span className="inline-flex flex-wrap gap-1">
      {held.map((v, i) => (
        <span key={i} className="rounded px-1 text-xs font-bold text-neutral-950" style={{ background: GOOD_HEX[markerColor(v)] }}>
          {v}
        </span>
      ))}
    </span>
  )
}

function PlayersTable({ state }: { state: KoggeState }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-neutral-800">
      <table className="w-full text-sm">
        <thead className="bg-neutral-900 text-left text-neutral-400">
          <tr>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Player</th>
            <th className="px-3 py-2">Goods</th>
            <th className="px-3 py-2">Route markers</th>
            <th className="px-3 py-2">Raid</th>
            <th className="px-3 py-2">DP</th>
            <th className="px-3 py-2">VP</th>
          </tr>
        </thead>
        <tbody>
          {state.players.map((p) => {
            const order = state.turnOrder.indexOf(p.id)
            return (
              <tr key={p.id} className={`border-t border-neutral-800 ${activePlayerId(state) === p.id ? 'bg-neutral-900/80' : ''}`}>
                <td className="px-3 py-2 text-neutral-400">{order >= 0 ? order + 1 : '–'}</td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ background: PLAYER_COLORS[p.seat] }} />
                    {p.name}
                    {state.winnerIds.includes(p.id) && ' 🏆'}
                  </span>
                  {p.bonuses.length > 0 && (
                    <div className="text-xs text-amber-300">{p.bonuses.map((b) => BONUS_LABELS[b]).join(', ')}</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <GoodsChips goods={p.goods} />
                </td>
                <td className="px-3 py-2">
                  <MarkerChips hand={p.hand} />
                </td>
                <td className="px-3 py-2">{p.raidMarkersInHand}</td>
                <td className="px-3 py-2">{developmentPoints(state, p.id)}</td>
                <td className="px-3 py-2">{victoryPoints(state, p.id).total}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function GameLog({ state }: { state: KoggeState }) {
  return (
    <div className="max-h-72 overflow-y-auto rounded-xl border border-neutral-800 p-3 text-xs text-neutral-400">
      {state.log
        .slice()
        .reverse()
        .map((line, i) => (
          <div key={i} className={line.startsWith('—') ? 'mt-1 font-semibold text-neutral-300' : ''}>
            {line}
          </div>
        ))}
    </div>
  )
}

// ─── Controls ─────────────────────────────────────────────────────────────

type Dispatch = (action: KoggeAction) => void

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-800 p-3">
      <h3 className="text-sm font-semibold text-neutral-300">{title}</h3>
      {children}
    </section>
  )
}

function ActionButton({ state, action, dispatch, children }: { state: KoggeState; action: KoggeAction; dispatch: Dispatch; children: ReactNode }) {
  const reason = validateKoggeAction(state, action)
  return (
    <button
      type="button"
      disabled={reason !== null}
      title={reason ?? undefined}
      onClick={() => dispatch(action)}
      className="rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-neutral-950 hover:bg-amber-500 disabled:bg-neutral-800 disabled:text-neutral-500"
    >
      {children}
    </button>
  )
}

function Select<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <select
      value={String(value)}
      onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)!.value)}
      className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

const colorOptions = GOOD_COLORS.map((c) => ({ value: c, label: c }))
const markerOptions = MARKER_VALUES.map((v) => ({ value: v as number, label: `${v} (${markerColor(v)})` }))

function ControlPanel({ state, dispatch }: { state: KoggeState; dispatch: Dispatch }) {
  const activeId = activePlayerId(state)
  if (state.phase === 'finished') return <FinishedPanel state={state} />
  if (!activeId) return null
  const active = state.players.find((p) => p.id === activeId)!

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-full" style={{ background: PLAYER_COLORS[active.seat] }} />
        <span className="font-semibold">{active.name}</span>
        <span className="text-sm text-neutral-400">to act</span>
      </div>
      {state.phase === 'startPick' && <StartPickPanel state={state} player={active} dispatch={dispatch} />}
      {state.phase === 'auction' && <AuctionPanel state={state} player={active} dispatch={dispatch} />}
      {state.phase === 'guildmaster' && <GuildmasterPanel state={state} player={active} dispatch={dispatch} />}
      {state.phase === 'actions' && state.pending && <RaidPendingPanel state={state} player={active} dispatch={dispatch} />}
      {state.phase === 'actions' && !state.pending && <TurnPanel state={state} player={active} dispatch={dispatch} />}
    </div>
  )
}

function StartPickPanel({ state, player, dispatch }: { state: KoggeState; player: KoggePlayer; dispatch: Dispatch }) {
  const [revealed, setRevealed] = useState(false)
  const waiting = state.players.filter((p) => state.startPicks[p.id] === null).length
  if (!revealed) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-neutral-400">
          Secret pick ({waiting} left). Pass the device to {player.name}, then reveal. If three or more players pick the same city, they pick again.
        </p>
        <button type="button" onClick={() => setRevealed(true)} className="rounded-md border border-neutral-600 px-3 py-1 hover:border-neutral-400">
          I am {player.name} — show my choices
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-neutral-400">Choose your starting city. Your boat and first house go there.</p>
      <div className="flex flex-wrap gap-2">
        {MARKER_VALUES.map((v) => (
          <ActionButton key={v} state={state} action={{ type: 'PICK_START', playerId: player.id, value: v }} dispatch={dispatch}>
            City {v}
          </ActionButton>
        ))}
      </div>
    </div>
  )
}

function Stepper({ label, value, max, onChange, swatch }: { label: string; value: number; max: number; onChange: (v: number) => void; swatch?: string }) {
  return (
    <div className="flex items-center gap-1 text-sm">
      {swatch && <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: swatch }} />}
      <span className="w-12 text-neutral-400">{label}</span>
      <button type="button" disabled={value <= 0} onClick={() => onChange(value - 1)} className="rounded border border-neutral-700 px-1.5 disabled:opacity-30">
        −
      </button>
      <span className="w-5 text-center">{value}</span>
      <button type="button" disabled={value >= max} onClick={() => onChange(value + 1)} className="rounded border border-neutral-700 px-1.5 disabled:opacity-30">
        +
      </button>
      <span className="text-xs text-neutral-500">/ {max}</span>
    </div>
  )
}

function AuctionPanel({ state, player, dispatch }: { state: KoggeState; player: KoggePlayer; dispatch: Dispatch }) {
  const [draft, setDraft] = useState<MarkerCounts>(emptyMarkers())
  const markers = draft.flatMap((n, v) => new Array<number>(n).fill(v))
  const canBid = hasLegalBid(
    player.hand,
    state.bids.map((b) => b.markers),
  )
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <div className="text-neutral-400">Lots on offer this round</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {state.lots.map((lot, i) => (
            <span key={i} className="rounded border border-neutral-700 px-2 py-0.5">
              <MarkerChips hand={countMarkers(lot)} />
            </span>
          ))}
        </div>
      </div>
      {state.bids.length > 0 && (
        <div>
          <div className="text-neutral-400">Bids so far</div>
          {state.bids.map((b) => (
            <div key={b.playerId}>
              {playerName(state, b.playerId)}: {describeBid(b.markers)}
            </div>
          ))}
        </div>
      )}
      <p className="text-neutral-400">
        Bid for turn order with markers from your hand. A set of identical markers beats any mix; bigger sets beat smaller ones, then higher
        numbers; mixes compare by sum. You can’t repeat an earlier bid. Each marker bid adds 2 goods to the city with its number.
      </p>
      <div className="grid grid-cols-2 gap-1">
        {MARKER_VALUES.filter((v) => player.hand[v] > 0).map((v) => (
          <Stepper key={v} label={`${v}`} swatch={GOOD_HEX[markerColor(v)]} value={draft[v]} max={player.hand[v]} onChange={(n) => setDraft(draft.map((x, i) => (i === v ? n : x)))} />
        ))}
      </div>
      <div className="text-neutral-300">Your bid: {describeBid(markers)}</div>
      <div className="flex gap-2">
        <ActionButton state={state} action={{ type: 'BID', playerId: player.id, markers }} dispatch={dispatch}>
          {markers.length === 0 ? (canBid ? 'Choose markers' : 'Pass (no legal bid)') : 'Place bid'}
        </ActionButton>
      </div>
    </div>
  )
}

function GuildmasterPanel({ state, player, dispatch }: { state: KoggeState; player: KoggePlayer; dispatch: Dispatch }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-neutral-400">As start player, move the Guildmaster 1 or 2 cities clockwise (raided cities are skipped). Its city gains 2 goods.</p>
      <div className="flex gap-2">
        {([1, 2] as const).map((steps) => {
          const path = guildmasterPath(state, steps)
          return (
            <ActionButton key={steps} state={state} action={{ type: 'MOVE_GUILDMASTER', playerId: player.id, steps }} dispatch={dispatch}>
              {steps} → city {path[path.length - 1] ?? state.guildmaster.city}
            </ActionButton>
          )
        })}
      </div>
    </div>
  )
}

function paymentOptions(player: KoggePlayer): { value: string; label: string }[] {
  return [
    ...GOOD_COLORS.filter((c) => player.goods[c] > 0).map((c) => ({ value: `good:${c}`, label: `${c} good` })),
    ...MARKER_VALUES.filter((v) => player.hand[v] > 0).map((v) => ({ value: `marker:${v}`, label: `${v} marker` })),
  ]
}

function parsePayment(key: string): Payment {
  const [kind, value] = key.split(':')
  return kind === 'good' ? { kind: 'good', color: value as GoodColor } : { kind: 'marker', value: Number(value) }
}

function MoveButton({ state, player, route, label, dispatch }: { state: KoggeState; player: KoggePlayer; route: 0 | 1 | 'guildmaster'; label: string; dispatch: Dispatch }) {
  const cost = nextMoveCost(state, player, route)
  const options = paymentOptions(player)
  const [picks, setPicks] = useState<string[]>([])
  const chosen = Array.from({ length: cost }, (_, i) => picks[i] ?? options[i]?.value ?? options[0]?.value ?? '')
  const payments = chosen.filter(Boolean).map(parsePayment)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionButton state={state} action={{ type: 'MOVE', playerId: player.id, route, payments }} dispatch={dispatch}>
        {label}
      </ActionButton>
      {cost > 0 &&
        chosen.map((value, i) => (
          <Select key={i} value={value} options={options} onChange={(v) => setPicks(chosen.map((x, j) => (j === i ? v : x)))} />
        ))}
      {cost === 0 && <span className="text-xs text-neutral-500">free</span>}
    </div>
  )
}

function TurnPanel({ state, player, dispatch }: { state: KoggeState; player: KoggePlayer; dispatch: Dispatch }) {
  const turn = state.turn!
  const cityN = player.boatCity!
  const city = state.cities[cityN]
  const others = state.players.filter((p) => p.id !== player.id && p.boatCity === cityN)
  const cost = buildCost(state, cityN)
  const gmHere = state.guildmaster.city === cityN

  const [guildValue, setGuildValue] = useState(0)
  const [bonusColor, setBonusColor] = useState<GoodColor>('grey')
  const [bonus, setBonus] = useState<BonusType>(BONUS_TYPES.find((b) => state.bonusSupply[b] > 0) ?? 'tripleTrade')
  const [lotPayment, setLotPayment] = useState<GoodColor>(GOOD_COLORS.find((c) => player.goods[c] > 0) ?? 'grey')
  const [give, setGive] = useState<GoodColor>(GOOD_COLORS.find((c) => player.goods[c] > 0) ?? 'grey')
  const [take, setTake] = useState<GoodColor[]>(['orange', 'orange', 'orange'])
  const [takeCount, setTakeCount] = useState(2)
  const [routeSlot, setRouteSlot] = useState<0 | 1>(city.slots[0].faceUp ? 0 : 1)
  const [routeValue, setRouteValue] = useState<number>(MARKER_VALUES.find((v) => v !== cityN && player.hand[v] > 0) ?? 0)

  const slotLabel = (i: 0 | 1) => (city.slots[i].faceUp ? `${city.slots[i].value}` : '? (hidden)')

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="text-neutral-400">
        In city {cityN} ({city.color}). {turn.moved ? 'Sailed this turn.' : 'Has not sailed.'} Actions used: {turn.used.length > 0 ? turn.used.join(', ') : 'none'}.
      </div>

      {!turn.movementClosed && (
        <Panel title="Sail">
          {([0, 1] as const).map((i) => (
            <MoveButton key={`${i}-${turn.movesMade}`} state={state} player={player} route={i} label={`Route → ${slotLabel(i)}`} dispatch={dispatch} />
          ))}
          {player.bonuses.includes('secretPassage') && (
            <MoveButton key={`gm-${turn.movesMade}`} state={state} player={player} route="guildmaster" label={`Secret passage → ${state.guildmaster.city}`} dispatch={dispatch} />
          )}
          <p className="text-xs text-neutral-500">Taking any action below ends your sailing for this turn.</p>
        </Panel>
      )}

      <Panel title="Build a house">
        <div className="text-xs text-neutral-400">
          Cost: 1 each of {cost.goods.join(', ')} + {cost.markers}× marker {cityN}
        </div>
        <div>
          <ActionButton state={state} action={{ type: 'BUILD_HOUSE', playerId: player.id }} dispatch={dispatch}>
            Build
          </ActionButton>
        </div>
      </Panel>

      {gmHere && (
        <Panel title="Trade with the Guildmaster (one per turn)">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={guildValue} options={markerOptions} onChange={setGuildValue} />
            <ActionButton state={state} action={{ type: 'GUILD_BUY_MARKER', playerId: player.id, value: guildValue }} dispatch={dispatch}>
              Buy for 1 {markerColor(guildValue)}
            </ActionButton>
            <ActionButton state={state} action={{ type: 'GUILD_SELL_MARKER', playerId: player.id, value: guildValue }} dispatch={dispatch}>
              Sell for 1 {markerColor(guildValue)}
            </ActionButton>
            <ActionButton state={state} action={{ type: 'GUILD_RAID_MARKER', playerId: player.id, value: guildValue }} dispatch={dispatch}>
              3× for raid marker
            </ActionButton>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-neutral-400">6×</span>
            <Select value={bonusColor} options={colorOptions} onChange={setBonusColor} />
            <span className="text-neutral-400">for</span>
            <Select
              value={bonus}
              options={BONUS_TYPES.map((b) => ({ value: b, label: `${BONUS_LABELS[b]} (${state.bonusSupply[b]} left)` }))}
              onChange={setBonus}
            />
            <ActionButton state={state} action={{ type: 'GUILD_BONUS', playerId: player.id, color: bonusColor, bonus }} dispatch={dispatch}>
              Buy bonus
            </ActionButton>
          </div>
          <p className="text-xs text-neutral-500">{BONUS_DESCRIPTIONS[bonus]}</p>
        </Panel>
      )}

      <Panel title="Buy a lot of route markers">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-neutral-400">Pay</span>
          <Select value={lotPayment} options={colorOptions} onChange={setLotPayment} />
        </div>
        <div className="flex flex-wrap gap-2">
          {state.lots.map((lot, i) => (
            <ActionButton key={i} state={state} action={{ type: 'BUY_LOT', playerId: player.id, lot: i, payment: lotPayment }} dispatch={dispatch}>
              {lot.join(' + ')}
            </ActionButton>
          ))}
          {state.lots.length === 0 && <span className="text-neutral-500">None left.</span>}
        </div>
      </Panel>

      <Panel title="Trade with the city">
        <div className="text-xs text-neutral-400">City has {formatGoods(city.goods)}.</div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-neutral-400">Give</span>
          <Select value={give} options={colorOptions} onChange={setGive} />
          <span className="text-neutral-400">take</span>
          {take.slice(0, takeCount).map((c, i) => (
            <Select key={i} value={c} options={colorOptions} onChange={(v) => setTake(take.map((x, j) => (j === i ? v : x)))} />
          ))}
          {player.bonuses.includes('tripleTrade') && (
            <Select value={takeCount} options={[{ value: 2, label: '2 goods' }, { value: 3, label: '3 goods' }]} onChange={setTakeCount} />
          )}
          <ActionButton state={state} action={{ type: 'TRADE_CITY', playerId: player.id, give, take: take.slice(0, takeCount) }} dispatch={dispatch}>
            Trade
          </ActionButton>
        </div>
      </Panel>

      <Panel title="Change a route">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-neutral-400">Replace</span>
          <Select value={routeSlot} options={[0, 1].map((i) => ({ value: i as 0 | 1, label: slotLabel(i as 0 | 1) }))} onChange={setRouteSlot} />
          <span className="text-neutral-400">with</span>
          <Select value={routeValue} options={markerOptions} onChange={setRouteValue} />
          <ActionButton state={state} action={{ type: 'CHANGE_ROUTE', playerId: player.id, slot: routeSlot, value: routeValue }} dispatch={dispatch}>
            Lay face down
          </ActionButton>
        </div>
      </Panel>

      <Panel title={`Raid (${player.raidMarkersInHand} marker${player.raidMarkersInHand === 1 ? '' : 's'}) — ends your turn`}>
        <div className="flex flex-wrap gap-2">
          <ActionButton state={state} action={{ type: 'RAID', playerId: player.id, mode: 'city' }} dispatch={dispatch}>
            Raid city {cityN}
          </ActionButton>
          {others.map((o) => (
            <ActionButton key={o.id} state={state} action={{ type: 'RAID', playerId: player.id, mode: 'player', targetId: o.id }} dispatch={dispatch}>
              Raid {o.name}’s boat
            </ActionButton>
          ))}
        </div>
      </Panel>

      {others.length > 0 && <PlayerTradePanel state={state} player={player} partners={others} dispatch={dispatch} />}

      <div>
        <ActionButton state={state} action={{ type: 'END_TURN', playerId: player.id }} dispatch={dispatch}>
          End turn
        </ActionButton>
      </div>
    </div>
  )
}

function BundleEditor({ owner, goods, markers, onGoods, onMarkers }: { owner: KoggePlayer; goods: Goods; markers: MarkerCounts; onGoods: (g: Goods) => void; onMarkers: (m: MarkerCounts) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-semibold text-neutral-300">{owner.name} gives</div>
      {GOOD_COLORS.filter((c) => owner.goods[c] > 0).map((c) => (
        <Stepper key={c} label={c} swatch={GOOD_HEX[c]} value={goods[c]} max={owner.goods[c]} onChange={(n) => onGoods({ ...goods, [c]: n })} />
      ))}
      {MARKER_VALUES.filter((v) => owner.hand[v] > 0).map((v) => (
        <Stepper key={v} label={`#${v}`} swatch={GOOD_HEX[markerColor(v)]} value={markers[v]} max={owner.hand[v]} onChange={(n) => onMarkers(markers.map((x, i) => (i === v ? n : x)))} />
      ))}
    </div>
  )
}

function PlayerTradePanel({ state, player, partners, dispatch }: { state: KoggeState; player: KoggePlayer; partners: KoggePlayer[]; dispatch: Dispatch }) {
  const [partnerId, setPartnerId] = useState(partners[0].id)
  const partner = partners.find((p) => p.id === partnerId) ?? partners[0]
  const [giveGoods, setGiveGoods] = useState<Goods>(emptyGoods())
  const [giveMarkers, setGiveMarkers] = useState<MarkerCounts>(emptyMarkers())
  const [getGoods, setGetGoods] = useState<Goods>(emptyGoods())
  const [getMarkers, setGetMarkers] = useState<MarkerCounts>(emptyMarkers())
  return (
    <Panel title="Trade with a player (both must agree)">
      <Select value={partner.id} options={partners.map((p) => ({ value: p.id, label: p.name }))} onChange={setPartnerId} />
      <div className="grid grid-cols-2 gap-3">
        <BundleEditor owner={player} goods={giveGoods} markers={giveMarkers} onGoods={setGiveGoods} onMarkers={setGiveMarkers} />
        <BundleEditor owner={partner} goods={getGoods} markers={getMarkers} onGoods={setGetGoods} onMarkers={setGetMarkers} />
      </div>
      <p className="text-xs text-neutral-500">Promises about future play can be part of the deal — keep them!</p>
      <div>
        <ActionButton
          state={state}
          action={{ type: 'TRADE_PLAYERS', playerId: player.id, partnerId: partner.id, give: { goods: giveGoods, markers: giveMarkers }, receive: { goods: getGoods, markers: getMarkers } }}
          dispatch={dispatch}
        >
          Both agree — trade
        </ActionButton>
      </div>
    </Panel>
  )
}

function RaidPendingPanel({ state, player, dispatch }: { state: KoggeState; player: KoggePlayer; dispatch: Dispatch }) {
  const pending = state.pending!
  const [groupA, setGroupA] = useState<Goods>(emptyGoods())
  if (pending.kind === 'split') {
    const groupB = GOOD_COLORS.reduce((g, c) => ({ ...g, [c]: player.goods[c] - groupA[c] }), emptyGoods())
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-neutral-400">
          {playerName(state, pending.attackerId)} raids your boat. Split your goods into two piles differing by at most one good; they take one pile.
        </p>
        {GOOD_COLORS.filter((c) => player.goods[c] > 0).map((c) => (
          <Stepper key={c} label={c} swatch={GOOD_HEX[c]} value={groupA[c]} max={player.goods[c]} onChange={(n) => setGroupA({ ...groupA, [c]: n })} />
        ))}
        <div>Pile A: {formatGoods(groupA)}</div>
        <div>Pile B: {formatGoods(groupB)}</div>
        <div>
          <ActionButton state={state} action={{ type: 'RAID_SPLIT', playerId: player.id, groupA }} dispatch={dispatch}>
            Confirm split
          </ActionButton>
        </div>
      </div>
    )
  }
  if (pending.kind === 'choose') {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-neutral-400">Choose which pile to take from {playerName(state, pending.defenderId)}.</p>
        <div className="flex flex-wrap gap-2">
          <ActionButton state={state} action={{ type: 'RAID_TAKE', playerId: player.id, group: 'A' }} dispatch={dispatch}>
            A: {formatGoods(pending.groupA)}
          </ActionButton>
          <ActionButton state={state} action={{ type: 'RAID_TAKE', playerId: player.id, group: 'B' }} dispatch={dispatch}>
            B: {formatGoods(pending.groupB)}
          </ActionButton>
        </div>
      </div>
    )
  }
  const raider = state.players.find((p) => p.id === pending.attackerId)!
  const city = state.cities[raider.boatCity!]
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-neutral-400">
        {raider.name} raided and must sail once. As the player to their left, choose the route (agree with the table if you can).
      </p>
      <div className="flex gap-2">
        {([0, 1] as const).map((i) => (
          <ActionButton key={i} state={state} action={{ type: 'RAID_ROUTE', playerId: player.id, slot: i }} dispatch={dispatch}>
            Route → {city.slots[i].faceUp ? city.slots[i].value : '?'}
          </ActionButton>
        ))}
      </div>
    </div>
  )
}

function FinishedPanel({ state }: { state: KoggeState }) {
  const rows = state.players.map((p) => ({ p, vp: victoryPoints(state, p.id), dp: developmentPoints(state, p.id) })).sort((a, b) => b.vp.total - a.vp.total)
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-700 bg-amber-950/30 p-4 text-sm">
      <h2 className="text-lg font-semibold">
        {state.winnerIds.map((id) => playerName(state, id)).join(' & ')} win{state.winnerIds.length === 1 ? 's' : ''}!
      </h2>
      <p className="text-neutral-400">
        {state.endReason === 'development' ? 'Reached five development points.' : 'The Guildmaster completed its second lap — victory points decide.'}
      </p>
      <table className="w-full">
        <thead className="text-left text-neutral-400">
          <tr>
            <th>Player</th>
            <th>Houses</th>
            <th>Raid</th>
            <th>Bonus</th>
            <th>Goods</th>
            <th>VP</th>
            <th>DP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, vp, dp }) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{vp.houses}</td>
              <td>{vp.raidMarkers}</td>
              <td>{vp.bonuses}</td>
              <td>{vp.goods}</td>
              <td className="font-semibold">{vp.total}</td>
              <td>{dp}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

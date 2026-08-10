import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { BoardSetupView } from '../components/BoardSetupView'
import { RoundView } from '../components/RoundView'
import { resolveAchievementContent, resolveBoardGenerationContent, resolveUnitContent } from '../content/resolveContent'
import type { Action } from '../engine/actions'
import { applyActionAndFastForwardTiles } from '../engine/applyAction'
import { buildGameLog } from '../engine/gameLog'
import { replayActions } from '../engine/replay'
import type { ActionResult, GameState as EngineGameState, Coordinate } from '../engine/types'
import { buildTurnReview, findReviewWindowStart } from '../engine/turnReview'
import { currentActorId } from '../engine/turnOrder'
import { useAuth } from '../hooks/useAuth'
import type { GameRow, PlayerRow } from '../lib/dbTypes'
import { buildGenesisState } from '../lib/gameGenesis'
import { getGameByRoomCode, getGameState, listPlayers, subscribeToGameState, subscribeToPlayers, writeGameState } from '../lib/gameApi'

/**
 * Two players' writes racing the game_state row's optimistic-concurrency
 * `version` check is the COMMON case, not a rare edge case — e.g. both
 * players choosing their card in the same simultaneous select-cards phase
 * routinely land within milliseconds of each other. Whoever's write
 * doesn't land first isn't in any real conflict with the other's action
 * (their own choice is still entirely valid against the fresher state) —
 * so retrying against the latest state should just work, silently, rather
 * than surfacing a "someone else acted first, try again" error that the
 * player has to notice and manually retry (or, worse, just reach for a
 * full page refresh). Capped so a genuinely stuck case still surfaces an
 * error instead of hanging.
 */
const MAX_WRITE_RETRIES = 3

export function GamePage() {
  const { roomCode } = useParams<{ roomCode: string }>()
  const { session, loading: authLoading } = useAuth()

  const [game, setGame] = useState<GameRow | null>(null)
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [gameState, setGameState] = useState<EngineGameState | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showStateJson, setShowStateJson] = useState(false)
  const [copiedStateJson, setCopiedStateJson] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  /**
   * Hotseat pass-and-play: which seated player the shared device is
   * currently "handed to" — distinct from auth identity, since every
   * hotseat seat shares one signed-in host's user_id (see gameApi.ts's
   * addLocalPlayer). Null until confirmed via the pass-the-device gate
   * below, and reset whenever a fresh room loads.
   */
  const [hotseatActivePlayerId, setHotseatActivePlayerId] = useState<string | null>(null)

  useEffect(() => {
    if (!roomCode) return
    setHotseatActivePlayerId(null)
    void (async () => {
      const foundGame = await getGameByRoomCode(roomCode)
      setGame(foundGame)
      if (foundGame) setPlayers(await listPlayers(foundGame.id))
    })()
  }, [roomCode])

  useEffect(() => {
    if (!game) return
    let cancelled = false

    void (async () => {
      const snapshot = await getGameState(game.id)
      if (!cancelled && snapshot) {
        setGameState(snapshot.state)
        setVersion(snapshot.version)
      }
    })()

    const unsubscribeGameState = subscribeToGameState(game.id, (snapshot) => {
      setGameState(snapshot.state)
      setVersion(snapshot.version)
    })
    const unsubscribePlayers = subscribeToPlayers(game.id, () => {
      void listPlayers(game.id).then(setPlayers)
    })

    return () => {
      cancelled = true
      unsubscribeGameState()
      unsubscribePlayers()
    }
  }, [game])

  const boardGenerationContent = useMemo(() => resolveBoardGenerationContent(players.length), [players.length])
  const unitContent = useMemo(() => resolveUnitContent(players.length), [players.length])
  const achievementContent = useMemo(() => resolveAchievementContent(), [])

  const isHotseat = game?.play_mode === 'hotseat'
  // Creation-time opt-out (HomePage.tsx's checkbox) for groups that don't
  // want the extra tap every turn — when set, `me` just always follows
  // whoever must act next, and the gate never has anything to catch it on.
  const skipHotseatGate = game?.skip_hotseat_pass_gate ?? false
  /**
   * Whichever seated player must act next (see engine/turnOrder.ts) — used
   * to know who the pass-the-device gate should hand the shared device to.
   * Only meaningful for hotseat; live/async each run on their own device,
   * so there's nothing to gate.
   */
  const pendingActorId = gameState ? currentActorId(gameState) : null
  const needsHotseatGate = isHotseat && !skipHotseatGate && pendingActorId !== null && pendingActorId !== hotseatActivePlayerId

  const me = isHotseat
    ? players.find((p) => p.id === (skipHotseatGate ? pendingActorId : hotseatActivePlayerId))
    : players.find((p) => p.user_id === session?.user.id)

  /**
   * "What happened since I last acted" (see engine/turnReview.ts) — reviewed
   * on demand via RoundView's history toggle, not stored. Rebuilding it
   * needs genesis (same buildGenesisState() Undo already uses) plus a
   * replay up to the start of the review window before buildTurnReview can
   * even begin, so it's only worth doing here, once, off the full
   * actionHistory — not duplicated per component that wants a piece of it.
   * Recomputes whenever the action history actually grows (or the viewer
   * changes) — game/players staying referentially stable between fetches
   * would make this needlessly expensive otherwise.
   */
  const turnReview = useMemo(() => {
    if (!game || !gameState || !me || players.length === 0) return null
    try {
      const genesis = buildGenesisState(game, players)
      const windowStart = findReviewWindowStart(gameState.actionHistory, me.id)
      const stateAtWindowStart = replayActions(genesis, gameState.actionHistory.slice(0, windowStart), unitContent, achievementContent, boardGenerationContent)
      return buildTurnReview(stateAtWindowStart, gameState.actionHistory.slice(windowStart), unitContent, achievementContent, boardGenerationContent)
    } catch {
      // A genesis/content mismatch shouldn't be possible for a game this
      // session is actually playing, but the review is a nice-to-have, not
      // core gameplay — fail quiet (no review) rather than break the page.
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, gameState?.actionHistory.length, me?.id, players, unitContent, achievementContent, boardGenerationContent])

  /**
   * The running narration log (see engine/gameLog.ts) — nothing about it is
   * stored on GameState, so it's rebuilt from the full actionHistory the
   * same way turnReview rebuilds its own windowed slice above, just without
   * a window: every logged action, from genesis, gets its line(s).
   */
  const gameLog = useMemo(() => {
    if (!game || players.length === 0) return []
    try {
      const genesis = buildGenesisState(game, players)
      return buildGameLog(genesis, gameState?.actionHistory ?? [], unitContent, achievementContent, boardGenerationContent)
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, gameState?.actionHistory.length, players, unitContent, achievementContent, boardGenerationContent])

  /**
   * Writes whatever `computeNext` derives from the current state, retrying
   * against freshly refetched state (up to MAX_WRITE_RETRIES times) if the
   * write loses the optimistic-concurrency race — see MAX_WRITE_RETRIES's
   * comment for why this needs to be a transparent retry, not just an
   * error the player has to notice and act on themselves. Always leaves
   * `gameState`/`version` reflecting the latest known state, win or lose,
   * so the UI never sits on stale data after a failed attempt.
   */
  async function writeWithRetry(computeNext: (state: EngineGameState) => ActionResult): Promise<ActionResult> {
    if (!game || !gameState || version === null) {
      return { ok: false, error: 'Game not loaded yet' }
    }
    let state = gameState
    let ver = version
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
      const result = computeNext(state)
      if (!result.ok) return result

      const wrote = await writeGameState(game.id, result.state, ver)
      if (wrote) {
        setGameState(result.state)
        setVersion(ver + 1)
        return result
      }

      const fresh = await getGameState(game.id)
      if (!fresh) return { ok: false, error: 'Game state disappeared unexpectedly.' }
      state = fresh.state
      ver = fresh.version
      setGameState(fresh.state)
      setVersion(fresh.version)
    }
    return { ok: false, error: "Couldn't sync with the other player's moves — please try again." }
  }

  async function submitAction(action: Action) {
    const result = await writeWithRetry((state) => applyActionAndFastForwardTiles(state, action, unitContent, achievementContent, boardGenerationContent))
    setActionError(result.ok ? null : result.error)
  }

  /**
   * Undo: any player, at any time, can roll the game back one action.
   * Genesis isn't stored anywhere (see GameState.actionHistory's doc
   * comment) — it's deterministically rebuilt from the game's row + seated
   * players (buildGenesisState, same logic LobbyPage.tsx used to start the
   * game) and every logged action except the last one is replayed on top of
   * it (replayActions), which is exactly what event sourcing buys us here:
   * "step back one action" needs no separate undo stack, just a shorter
   * replay. The log itself needs no separate note about what got undone —
   * it's derived fresh from actionHistory (see gameLog above), so a shorter
   * history just naturally narrates one fewer step. Recomputed fresh on
   * each writeWithRetry attempt (not just once up front), since a retry
   * replays against newer state than what `gameState` held when the button
   * was clicked.
   */
  async function handleUndo() {
    if (!me || !game) return
    setUndoing(true)
    try {
      const result = await writeWithRetry((state) => {
        if (state.actionHistory.length === 0) {
          return { ok: false, error: 'Nothing left to undo.' }
        }
        const genesis = buildGenesisState(game, players)
        const previousHistory = state.actionHistory.slice(0, -1)
        const undoneState = replayActions(genesis, previousHistory, unitContent, achievementContent, boardGenerationContent)
        return { ok: true, state: undoneState }
      })
      setActionError(result.ok ? null : result.error)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to undo')
    } finally {
      setUndoing(false)
    }
  }

  async function handleCopyStateJson() {
    if (!gameState) return
    await navigator.clipboard.writeText(JSON.stringify(gameState, null, 2))
    setCopiedStateJson(true)
    setTimeout(() => setCopiedStateJson(false), 1500)
  }

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>
  if (!session) return <div className="p-8 text-neutral-400">Sign in from the home page first.</div>
  if (!game) return <div className="p-8 text-neutral-400">Looking for room {roomCode}…</div>

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Room {game.room_code}</h1>
        <div className="flex items-center gap-4">
          <ul className="flex gap-3 text-sm text-neutral-400">
            {players.map((p) => (
              <li key={p.id} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                {p.display_name}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={!me || undoing || !gameState || gameState.actionHistory.length === 0}
            onClick={() => void handleUndo()}
            title="Undo the last action — any player can do this, at any time."
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
          >
            {undoing ? 'Undoing…' : 'Undo last action'}
          </button>
          <button
            type="button"
            disabled={!gameState}
            onClick={() => setShowStateJson((v) => !v)}
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
          >
            {showStateJson ? 'Hide' : 'Show'} game state JSON
          </button>
        </div>
      </header>

      {showStateJson && gameState && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleCopyStateJson()}
              className="rounded-md border border-neutral-700 px-3 py-1 text-xs hover:border-neutral-500"
            >
              {copiedStateJson ? 'Copied!' : 'Copy JSON'}
            </button>
          </div>
          <pre className="max-h-96 overflow-auto rounded-md border border-neutral-800 bg-neutral-900 p-4 text-xs text-neutral-300">
            {JSON.stringify(gameState, null, 2)}
          </pre>
        </div>
      )}

      {actionError && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{actionError}</div>}

      {!gameState && <p className="text-neutral-400">Setting up the game…</p>}

      {needsHotseatGate && pendingActorId && (
        <div className="flex flex-col items-center gap-4 rounded-md border border-neutral-800 p-12 text-center">
          <p className="text-sm text-neutral-400">Pass the device to</p>
          <p className="text-3xl font-semibold">{players.find((p) => p.id === pendingActorId)?.display_name ?? 'the next player'}</p>
          <button
            type="button"
            onClick={() => setHotseatActivePlayerId(pendingActorId)}
            className="rounded-md bg-indigo-600 px-6 py-2 font-medium text-white hover:bg-indigo-500"
          >
            I&apos;m ready — continue
          </button>
        </div>
      )}

      {!needsHotseatGate && gameState?.status === 'boardSetup' && (
        <BoardSetupView
          state={gameState}
          players={players}
          myPlayerId={me?.id ?? null}
          boardGenerationContent={boardGenerationContent}
          onPlaceTile={(anchor: Coordinate, rotationSteps: number) => {
            if (!me) return
            void submitAction({ type: 'PLACE_TILE', playerId: me.id, anchor, rotationSteps })
          }}
          onPlaceUnit={(unitKind: string, coord: Coordinate) => {
            if (!me) return
            void submitAction({ type: 'PLACE_UNIT', playerId: me.id, unitKind, coord })
          }}
        />
      )}

      {gameState?.status === 'completed' && (
        <div className="rounded-md border border-amber-700/50 bg-amber-500/10 p-4 text-amber-300">
          <p className="text-lg font-semibold">Game over</p>
          <p>Winner{gameState.winnerPlayerIds.length > 1 ? 's' : ''}: {gameState.winnerPlayerIds.map((id) => players.find((p) => p.id === id)?.display_name ?? id).join(', ') || 'none'}</p>
        </div>
      )}

      {!needsHotseatGate && gameState?.status === 'active' && (
        <RoundView
          state={gameState}
          players={players}
          myPlayerId={me?.id ?? null}
          unitContent={unitContent}
          achievementContent={achievementContent}
          turnReview={turnReview}
          showHistory={showHistory}
          onToggleHistory={() => setShowHistory((v) => !v)}
          gameLog={gameLog}
          onChooseCard={(cardId) => {
            if (!me) return
            void submitAction({ type: 'CHOOSE_CARD', playerId: me.id, cardId })
          }}
          onResolveUnit={(unitId, actionId, target) => {
            if (!me) return
            void submitAction({ type: 'RESOLVE_UNIT_ACTION', playerId: me.id, unitActions: [{ unitId, actionId, target }] })
          }}
          onPassActions={() => {
            if (!me) return
            void submitAction({ type: 'PASS_ACTIONS', playerId: me.id })
          }}
          onMoveToDecline={(cardId) => {
            if (!me) return
            void submitAction({ type: 'MOVE_TO_DECLINE', playerId: me.id, cardId })
          }}
          onPurchaseCard={(cardId) => {
            if (!me) return
            void submitAction({ type: 'PURCHASE_CARD', playerId: me.id, cardId })
          }}
          onPassPurchase={() => {
            if (!me) return
            void submitAction({ type: 'PASS_PURCHASE', playerId: me.id })
          }}
        />
      )}
    </div>
  )
}

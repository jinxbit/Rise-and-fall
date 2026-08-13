import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { BoardSetupView } from '../components/BoardSetupView'
import { EndGameView } from '../components/EndGameView'
import { RoundView } from '../components/RoundView'
import { resolveAchievementContent, resolveBoardGenerationContent, resolveTaleContent, resolveUnitContent } from '../content/resolveContent'
import type { Action } from '../engine/actions'
import { applyActionAndFastForwardTiles } from '../engine/applyAction'
import { buildGameLog } from '../engine/gameLog'
import { replayActions } from '../engine/replay'
import { applyTaleModifiers } from '../engine/tales'
import type { ActionResult, GameState as EngineGameState, Coordinate } from '../engine/types'
import { buildTurnReview, findReviewWindowStart } from '../engine/turnReview'
import { currentActorId, pendingActorIds } from '../engine/turnOrder'
import { useAuth } from '../hooks/useAuth'
import type { GameRow, ObserverRow, PlayerRow } from '../lib/dbTypes'
import { buildGenesisState } from '../lib/gameGenesis'
import {
  cancelGame,
  deleteGame,
  getDiscordWebhookUrl,
  getGameByRoomCode,
  getGameState,
  joinAsObserver,
  leaveAsObserver,
  listObservers,
  listPlayers,
  subscribeToGame,
  subscribeToGameState,
  subscribeToObservers,
  subscribeToPlayers,
  writeGameState,
} from '../lib/gameApi'
import { encodeGameStateExport } from '../lib/gameStateExport'
import { sendDiscordNotification, turnNotificationMessage } from '../lib/discordNotify'

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
  const navigate = useNavigate()

  const [game, setGame] = useState<GameRow | null>(null)
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [gameState, setGameState] = useState<EngineGameState | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showStateJson, setShowStateJson] = useState(false)
  /** The top-left hamburger menu (Main menu, Show/Hide game state JSON) — see the click-outside/Escape effect below. */
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [copiedStateJson, setCopiedStateJson] = useState(false)
  const [copiedStateExport, setCopiedStateExport] = useState(false)
  const [stateExportError, setStateExportError] = useState<string | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [redoing, setRedoing] = useState(false)
  /**
   * Actions popped off actionHistory by Undo, most-recently-undone last —
   * Redo pops from the end and re-submits it through the normal action
   * path, which naturally restores multi-step undos in the right order
   * (undo A then B leaves [B, A]; redo pops A first, then B). Cleared
   * whenever a fresh player action is submitted, since that's a new
   * branch of history the undone actions no longer fit onto. Not
   * persisted anywhere — like the undo stack event-sourcing replaces, this
   * is just local UI state, so it resets on refresh and isn't shared
   * between players (each player's own undo/redo history, same as e.g.
   * their browser's back button).
   */
  const [redoStack, setRedoStack] = useState<Action[]>([])
  const [showHistory, setShowHistory] = useState(false)
  /**
   * Hotseat pass-and-play: which seated player the shared device is
   * currently "handed to" — distinct from auth identity, since every
   * hotseat seat shares one signed-in host's user_id (see gameApi.ts's
   * addLocalPlayer). Null until confirmed via the pass-the-device gate
   * below, and reset whenever a fresh room loads.
   */
  const [hotseatActivePlayerId, setHotseatActivePlayerId] = useState<string | null>(null)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const [observers, setObservers] = useState<ObserverRow[]>([])
  const [observerBusy, setObserverBusy] = useState(false)
  const [observerError, setObserverError] = useState<string | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!roomCode) return
    setHotseatActivePlayerId(null)
    void (async () => {
      const foundGame = await getGameByRoomCode(roomCode)
      setGame(foundGame)
      if (foundGame) {
        setPlayers(await listPlayers(foundGame.id))
        setObservers(await listObservers(foundGame.id))
      }
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
    const unsubscribeObservers = subscribeToObservers(game.id, () => {
      void listObservers(game.id).then(setObservers)
    })
    // Live status updates (e.g. the Owner canceling from another tab/device)
    // — GamePage otherwise only fetches `game` once on mount, unlike
    // LobbyPage which already subscribes for its own status-driven navigate.
    const unsubscribeGame = subscribeToGame(game.id, setGame)

    return () => {
      cancelled = true
      unsubscribeGameState()
      unsubscribePlayers()
      unsubscribeObservers()
      unsubscribeGame()
    }
  }, [game])

  const boardGenerationContent = useMemo(() => resolveBoardGenerationContent(players.length), [players.length])
  // Tales (src/content/tales.json) and the achievement target chosen at
  // game creation (games.settings.activeTaleIds/gameLength — see
  // HomePage.tsx's TaleSelector/GameLengthSelector) are carried into GameState itself
  // once genesis is built (GameState.activeTaleIds/gameLength — see
  // buildGenesisState), so once a game is under way this reads the
  // running gameState, not the games row — self-contained the same way a
  // RAF-STATE-1 export is. applyTaleModifiers is a no-op for a game with
  // no Tales active (the default, and every game before this variant
  // existed).
  const taleContent = useMemo(
    () => resolveTaleContent(gameState?.activeTaleIds ?? [], players.length),
    [players.length, gameState?.activeTaleIds],
  )
  const unitContent = useMemo(() => applyTaleModifiers(resolveUnitContent(players.length), taleContent), [players.length, taleContent])
  const achievementContent = useMemo(() => resolveAchievementContent(gameState?.gameLength), [gameState?.gameLength])

  const isCreator = game?.created_by === session?.user.id
  // Cancel is only offered while the room is genuinely Active (issue
  // section 11) — a finished game still reads `game.status === 'active'`
  // here too (see dbTypes.ts's GameRow comment), so the finer-grained
  // engine status rules out canceling a game that's already over.
  const canCancel = isCreator && game?.status === 'active' && gameState?.status !== 'completed'
  const canDelete = isCreator && game?.status === 'canceled'
  const isHotseat = game?.play_mode === 'hotseat'
  // Observers (issue section 6): view-only, don't occupy a seat. Joining is
  // only offered once the room is genuinely Active — same 'active' gate as
  // 0010_observers.sql's RLS (games.status can't distinguish In Progress
  // from Finished, see dbTypes.ts's GameRow comment).
  const isSeatedPlayer = players.some((p) => p.user_id === session?.user.id)
  const amObserving = observers.some((o) => o.user_id === session?.user.id)
  const canObserve = !isSeatedPlayer && game?.status === 'active' && !amObserving
  // Creation-time opt-out (HomePage.tsx's checkbox) for groups that don't
  // want the extra tap every turn — when set, `me` just always follows
  // whoever must act next, and the gate never has anything to catch it on.
  const skipHotseatGate = game?.settings.skipHotseatPassGate ?? false
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
      const stateAtWindowStart = replayActions(genesis, gameState.actionHistory.slice(0, windowStart), unitContent, achievementContent, boardGenerationContent, taleContent)
      return buildTurnReview(stateAtWindowStart, gameState.actionHistory.slice(windowStart), unitContent, achievementContent, boardGenerationContent, taleContent)
    } catch {
      // A genesis/content mismatch shouldn't be possible for a game this
      // session is actually playing, but the review is a nice-to-have, not
      // core gameplay — fail quiet (no review) rather than break the page.
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, gameState?.actionHistory.length, me?.id, players, unitContent, achievementContent, boardGenerationContent, taleContent])

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
      return buildGameLog(genesis, gameState?.actionHistory ?? [], unitContent, achievementContent, boardGenerationContent, taleContent)
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, gameState?.actionHistory.length, players, unitContent, achievementContent, boardGenerationContent, taleContent])

  /**
   * Async-mode "your turn" nudge (see discordNotify.ts): compares who must
   * act before vs. after a write and pings each player newly added to that
   * set on their own Discord webhook, if they've set one
   * (DiscordWebhookSettings.tsx). Live/hotseat games skip this — live
   * players already get pushed the update via Realtime, and hotseat is one
   * shared device with nobody to page. Fire-and-forget: this runs after the
   * write has already succeeded, so nothing here should ever block the UI
   * or surface as a game-facing error (sendDiscordNotification already
   * swallows its own failures; the .catch below only guards the webhook
   * lookup itself).
   */
  function notifyNewlyPendingPlayers(prevState: EngineGameState, nextState: EngineGameState) {
    if (!game || game.play_mode !== 'async') return
    const wasPending = new Set(pendingActorIds(prevState))
    const nowPending = pendingActorIds(nextState).filter((id) => !wasPending.has(id))
    for (const playerId of nowPending) {
      const player = players.find((p) => p.id === playerId)
      if (!player) continue
      void getDiscordWebhookUrl(player.user_id)
        .then((webhookUrl) => {
          if (!webhookUrl) return
          void sendDiscordNotification(webhookUrl, turnNotificationMessage({ roomCode: game.room_code, displayName: player.display_name }))
        })
        .catch(() => {})
    }
  }

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
    if (game.status === 'canceled') {
      // Belt-and-suspenders alongside 0008_room_lifecycle.sql's RLS policy,
      // which is the actual guard against a stale/malicious client.
      return { ok: false, error: 'This room has been canceled.' }
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
        notifyNewlyPendingPlayers(state, result.state)
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
    const result = await writeWithRetry((state) => applyActionAndFastForwardTiles(state, action, unitContent, achievementContent, boardGenerationContent, taleContent))
    if (result.ok) setRedoStack([])
    setActionError(result.ok ? null : result.error)
  }

  /**
   * Undo: any player, at any time, can roll the game back one action —
   * deliberately not gated on `me`, unlike every other action here. `me` is
   * "which specific player is this submission on behalf of" (a hotseat seat
   * or the signed-in live player), which Undo has no use for since it
   * doesn't submit a player-attributed action. That matters once the game
   * ends: `me` for skip-gate hotseat games follows `currentActorId`, which
   * is null once `status: 'completed'` (nobody's turn anymore) — and for
   * gated hotseat games, a fresh page load of an already-completed game
   * never shows the pass-device gate to set `hotseatActivePlayerId` in the
   * first place, so `me` is null there too. Gating Undo on `me` would make
   * it silently unavailable in both cases right when it's most wanted (fix
   * up the final round after seeing the end-of-game screen). The actual
   * write is still safe without it — RLS only lets a seated player of this
   * game write game_state at all (0001_init_schema.sql), so a signed-in
   * stranger with the room-code URL can click this but their write simply
   * won't land.
   *
   * Genesis isn't stored anywhere (see GameState.actionHistory's doc
   * comment) — it's deterministically rebuilt from the game's row + seated
   * players (buildGenesisState, same logic LobbyPage.tsx used to start the
   * game) and every logged action except the last one is replayed on top of
   * it (replayActions), which is exactly what event sourcing buys us here:
   * "step back one action" needs no separate undo stack, just a shorter
   * replay — including unwinding `status: 'completed'` back to `'active'`
   * when the undone action was the one that ended the game, since that
   * status lives on the replayed GameState like everything else. The log
   * itself needs no separate note about what got undone — it's derived
   * fresh from actionHistory (see gameLog above), so a shorter history just
   * naturally narrates one fewer step. Recomputed fresh on each
   * writeWithRetry attempt (not just once up front), since a retry replays
   * against newer state than what `gameState` held when the button was
   * clicked.
   */
  async function handleUndo() {
    if (!game) return
    setUndoing(true)
    let undoneAction: Action | null = null
    try {
      const result = await writeWithRetry((state) => {
        if (state.actionHistory.length === 0) {
          return { ok: false, error: 'Nothing left to undo.' }
        }
        const genesis = buildGenesisState(game, players)
        const previousHistory = state.actionHistory.slice(0, -1)
        undoneAction = state.actionHistory[state.actionHistory.length - 1].action
        const undoneState = replayActions(genesis, previousHistory, unitContent, achievementContent, boardGenerationContent, taleContent)
        return { ok: true, state: undoneState }
      })
      if (result.ok && undoneAction) {
        setRedoStack((stack) => [...stack, undoneAction as Action])
      }
      setActionError(result.ok ? null : result.error)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to undo')
    } finally {
      setUndoing(false)
    }
  }

  /**
   * Redo: re-submits the most recently undone action through the same
   * applyActionAndFastForwardTiles path a live player action takes (not a
   * raw history append), so if the game has moved on since the undo (e.g.
   * another player acted) it's validated fresh against current state and
   * fails cleanly rather than silently grafting a stale action onto the
   * wrong point in history.
   */
  async function handleRedo() {
    if (!game || redoStack.length === 0) return
    const action = redoStack[redoStack.length - 1]
    setRedoing(true)
    setRedoStack((stack) => stack.slice(0, -1))
    try {
      const result = await writeWithRetry((state) => applyActionAndFastForwardTiles(state, action, unitContent, achievementContent, boardGenerationContent, taleContent))
      setActionError(result.ok ? null : result.error)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to redo')
    } finally {
      setRedoing(false)
    }
  }

  async function handleCopyStateJson() {
    if (!gameState) return
    await navigator.clipboard.writeText(JSON.stringify(gameState, null, 2))
    setCopiedStateJson(true)
    setTimeout(() => setCopiedStateJson(false), 1500)
  }

  /**
   * The pretty-printed JSON above is unwieldy to paste into a bug report or
   * chat (easily tens of KB). This copies a gzip+base64 "state export"
   * instead — a single line, a fraction of the size, and self-describing
   * (see gameStateExport.ts's schema/version envelope) so it can be decoded
   * back into the exact state it came from.
   */
  async function handleCopyStateExport() {
    if (!gameState) return
    setStateExportError(null)
    try {
      await navigator.clipboard.writeText(await encodeGameStateExport(gameState))
      setCopiedStateExport(true)
      setTimeout(() => setCopiedStateExport(false), 1500)
    } catch (err) {
      setStateExportError(err instanceof Error ? err.message : 'Failed to copy game state export')
    }
  }

  async function handleCancelRoom() {
    if (!game) return
    setLifecycleBusy(true)
    setLifecycleError(null)
    try {
      await cancelGame(game.id)
    } catch (err) {
      setLifecycleError(err instanceof Error ? err.message : 'Failed to cancel room')
    } finally {
      setLifecycleBusy(false)
    }
  }

  async function handleDeleteRoom() {
    if (!game) return
    setLifecycleBusy(true)
    setLifecycleError(null)
    try {
      await deleteGame(game.id)
      navigate('/')
    } catch (err) {
      setLifecycleError(err instanceof Error ? err.message : 'Failed to delete room')
      setLifecycleBusy(false)
    }
  }

  async function handleObserve() {
    if (!game || !session) return
    setObserverBusy(true)
    setObserverError(null)
    try {
      await joinAsObserver({
        gameId: game.id,
        userId: session.user.id,
        displayName:
          (session.user.user_metadata?.full_name as string | undefined) ??
          (session.user.user_metadata?.name as string | undefined) ??
          session.user.email ??
          'Observer',
        avatarUrl: (session.user.user_metadata?.avatar_url as string | undefined) ?? null,
      })
      setObservers(await listObservers(game.id))
      // Joining flips the game_state select RLS from "no rows visible" to
      // "readable" for this user — refetch now rather than waiting for the
      // next unrelated `game` effect re-run (see the game-load effect above,
      // which only fires once per `game` reference).
      const snapshot = await getGameState(game.id)
      if (snapshot) {
        setGameState(snapshot.state)
        setVersion(snapshot.version)
      }
    } catch (err) {
      setObserverError(err instanceof Error ? err.message : 'Failed to start observing')
    } finally {
      setObserverBusy(false)
    }
  }

  async function handleStopObserving() {
    if (!game || !session) return
    setObserverBusy(true)
    setObserverError(null)
    try {
      await leaveAsObserver(game.id, session.user.id)
      setObservers(await listObservers(game.id))
    } catch (err) {
      setObserverError(err instanceof Error ? err.message : 'Failed to stop observing')
    } finally {
      setObserverBusy(false)
    }
  }

  if (authLoading) return <div className="p-8 text-neutral-400">Loading…</div>
  if (!session) return <div className="p-8 text-neutral-400">Sign in from the home page first.</div>
  if (!game) return <div className="p-8 text-neutral-400">Looking for room {roomCode}…</div>

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-8 lg:max-w-6xl xl:max-w-7xl">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Menu"
              className="rounded-md border border-neutral-700 p-2 hover:border-neutral-500"
            >
              <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current" aria-hidden="true">
                <rect x="2" y="4" width="16" height="2" rx="1" />
                <rect x="2" y="9" width="16" height="2" rx="1" />
                <rect x="2" y="14" width="16" height="2" rx="1" />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute left-0 top-full z-10 mt-2 flex w-56 flex-col overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 py-1 text-sm shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    navigate('/')
                  }}
                  title="Leave this game and return to the main menu — the game itself keeps going, you can rejoin from the room code."
                  className="px-3 py-2 text-left hover:bg-neutral-800"
                >
                  Main menu
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!gameState}
                  onClick={() => {
                    setMenuOpen(false)
                    setShowStateJson((v) => !v)
                  }}
                  title="Inspect the raw game state JSON — mainly useful for debugging or filing a bug report."
                  className="px-3 py-2 text-left hover:bg-neutral-800 disabled:opacity-50"
                >
                  {showStateJson ? 'Hide' : 'Show'} game state JSON
                </button>
                {canCancel && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={lifecycleBusy}
                    onClick={() => {
                      setMenuOpen(false)
                      void handleCancelRoom()
                    }}
                    title="Cancel this room — disables further play; it stays visible for reference until deleted."
                    className="px-3 py-2 text-left text-red-400 hover:bg-neutral-800 disabled:opacity-50"
                  >
                    Cancel room
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={lifecycleBusy}
                    onClick={() => {
                      setMenuOpen(false)
                      void handleDeleteRoom()
                    }}
                    title="Permanently delete this room."
                    className="px-3 py-2 text-left text-red-400 hover:bg-neutral-800 disabled:opacity-50"
                  >
                    Delete room
                  </button>
                )}
              </div>
            )}
          </div>
          <h1 className="text-2xl font-semibold">Room {game.room_code}</h1>
          <ul className="flex flex-wrap gap-3 text-sm text-neutral-400">
            {players.map((p) => (
              <li key={p.id} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                {p.display_name}
              </li>
            ))}
          </ul>
          {observers.length > 0 && (
            <p className="text-xs text-neutral-500">
              Observing: {observers.map((o) => o.display_name).join(', ')}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {amObserving && (
            <button
              type="button"
              disabled={observerBusy}
              onClick={() => void handleStopObserving()}
              title="Stop observing this game."
              className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
            >
              Stop observing
            </button>
          )}
          <button
            type="button"
            disabled={undoing || !gameState || gameState.actionHistory.length === 0}
            onClick={() => void handleUndo()}
            title="Undo the last action — any player can do this, at any time, even after the game has ended."
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
          >
            {undoing ? 'Undoing…' : 'Undo'}
          </button>
          <button
            type="button"
            disabled={redoing || redoStack.length === 0}
            onClick={() => void handleRedo()}
            title="Redo the last undone action."
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
          >
            {redoing ? 'Redoing…' : 'Redo'}
          </button>
        </div>
      </header>

      {stateExportError && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{stateExportError}</div>}

      {lifecycleError && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{lifecycleError}</div>}

      {observerError && <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">{observerError}</div>}

      {game.status === 'canceled' && (
        <div className="rounded-md bg-neutral-800/60 p-3 text-sm text-neutral-300">
          This room was canceled{isCreator ? '' : ' by the host'}. Play is disabled — it stays here for reference until{' '}
          {isCreator ? 'you delete it.' : 'the host deletes it.'}
        </div>
      )}

      {showStateJson && gameState && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleCopyStateExport()}
              title="Copies a compressed, single-line export of the game state — easier to paste into a bug report or chat than the full JSON."
              className="rounded-md border border-neutral-700 px-3 py-1 text-xs hover:border-neutral-500"
            >
              {copiedStateExport ? 'Copied!' : 'Copy state export'}
            </button>
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

      {!gameState && canObserve && (
        <div className="flex flex-col items-center gap-4 rounded-md border border-neutral-800 p-12 text-center">
          <p className="text-neutral-400">You&apos;re not seated in this game.</p>
          <button
            type="button"
            disabled={observerBusy}
            onClick={() => void handleObserve()}
            className="rounded-md bg-indigo-600 px-6 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Observe this game
          </button>
        </div>
      )}

      {!gameState && !canObserve && <p className="text-neutral-400">Setting up the game…</p>}

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
        <EndGameView state={gameState} players={players} achievementContent={achievementContent} taleContent={taleContent} />
      )}

      {!needsHotseatGate && gameState?.status === 'active' && (
        <RoundView
          state={gameState}
          players={players}
          myPlayerId={me?.id ?? null}
          unitContent={unitContent}
          achievementContent={achievementContent}
          taleContent={taleContent}
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

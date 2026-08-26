import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { BoardSetupView } from '../components/BoardSetupView'
import { EndGameView } from '../components/EndGameView'
import { ErrorBanner } from '../components/ErrorBanner'
import { RoundView } from '../components/RoundView'
import { resolveAchievementContent, resolveBoardGenerationContent, resolveTaleContent, resolveUnitContent } from '../content/resolveContent'
import type { Action, LoggedAction } from '../engine/actions'
import { applyActionAndFastForwardTiles } from '../engine/applyAction'
import { stripOccupants } from '../engine/board'
import { buildGameLogFrom, extendGameLog } from '../engine/gameLog'
import { replayActions } from '../engine/replay'
import { calculateScoreHistory } from '../engine/scoreHistory'
import { applyTaleAchievementModifiers, applyTaleModifiers } from '../engine/tales'
import { calculateGoldSpendingByCategory, calculateUnitValueDetail } from '../engine/unitValue'
import type { ActionResult, GameEvent, GameState as EngineGameState, Coordinate } from '../engine/types'
import { buildTurnReview, findReviewWindowStart, findTurnStops, recapTurnFor, reviewPhaseGroupAt, roundPhaseForRecap, shouldShowCardChoiceRecap } from '../engine/turnReview'
import type { TurnReview } from '../engine/turnReview'
import { currentActorId } from '../engine/turnOrder'
import { useAuth } from '../hooks/useAuth'
import { useIsAdmin } from '../hooks/useIsAdmin'
import { useUnitPlateColors } from '../hooks/useUnitPlateColors'
import type { GameRow, PlayerRow } from '../lib/dbTypes'
import { simpleError, toAppError, type AppError } from '../lib/errors'
import { buildGenesisState } from '../lib/gameGenesis'
import {
  cancelGame,
  deleteGame,
  getGameByRoomCode,
  getGameState,
  listPlayers,
  setGameVisibility,
  subscribeToGame,
  subscribeToGameState,
  subscribeToPlayers,
  writeGameState,
} from '../lib/gameApi'
import { encodeGameStateExport } from '../lib/gameStateExport'
import { saveMapToPool } from '../lib/mapPoolApi'
import { setPendingRedirect } from '../lib/pendingRedirect'

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

/**
 * The review banner's territory-control toggle (see `territoryControlMode`
 * state below) cycles through these in order on each click, rather than
 * offering three separate buttons — one button reads more like a single
 * "territory overlay" control switching between views than three
 * independent, easy-to-confuse-with-multi-select toggles.
 */
const TERRITORY_CONTROL_MODES = [
  { mode: 'off', label: 'Territory: off', title: 'Territory control is hidden. Click to outline every region a player currently controls, like the victory screen.' },
  {
    mode: 'on',
    label: 'Territory: on',
    title: 'Outlining every region currently under a player’s control, like the victory screen. Click to outline only what changed since the previous step instead.',
  },
  {
    mode: 'changes',
    label: 'Territory: changes',
    title:
      'Outlining only the regions whose control changed since the previous step — a region that turned neutral is striped black-and-white. Click to hide territory control.',
  },
] as const

export function GamePage() {
  const { roomCode } = useParams<{ roomCode: string }>()
  const { session, loading: authLoading } = useAuth()
  const isAdmin = useIsAdmin(session?.user ?? null)
  const { colors: unitPlateColors } = useUnitPlateColors(session?.user ?? null)
  const navigate = useNavigate()

  useEffect(() => {
    if (authLoading || session || !roomCode) return
    setPendingRedirect(`/game/${roomCode}`)
    navigate('/', { replace: true })
  }, [authLoading, session, roomCode, navigate])

  const [game, setGame] = useState<GameRow | null>(null)
  const [roomNotFound, setRoomNotFound] = useState(false)
  const [loadError, setLoadError] = useState<AppError | null>(null)
  const [players, setPlayers] = useState<PlayerRow[]>([])
  const [gameState, setGameState] = useState<EngineGameState | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [actionError, setActionError] = useState<AppError | null>(null)
  const [showStateJson, setShowStateJson] = useState(false)
  /** The top-left hamburger menu (Main menu, Show/Hide game state JSON) — see the click-outside/Escape effect below. */
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  /** The "Reviewing history" banner (Prev/Next/slider/Back to live, etc.) — see the page-wide click-to-exit handler below. */
  const reviewBannerRef = useRef<HTMLDivElement>(null)
  const [copiedStateJson, setCopiedStateJson] = useState(false)
  const [copiedStateExport, setCopiedStateExport] = useState(false)
  const [stateExportError, setStateExportError] = useState<AppError | null>(null)
  const [savingMap, setSavingMap] = useState(false)
  const [mapSaved, setMapSaved] = useState(false)
  const [mapSaveError, setMapSaveError] = useState<AppError | null>(null)
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
  /**
   * History review (issue #63): lets anyone step through past points in the
   * game — genesis plus every action since — without touching the live,
   * shared `game_state` row the way Undo does. `null` means "showing the
   * live game" (the normal case); otherwise it's an index into
   * `gameState.actionHistory` (0 = genesis, N = the state right after the
   * Nth logged action), and `reviewState` below replays purely client-side
   * up to that point. Reset whenever a fresh room loads, same as
   * `hotseatActivePlayerId`.
   *
   * Both step sizes ("action by action", "turn by turn", issue #261) drive
   * this same index — they're the same read-only replay feature, just with a
   * different step size (see `historyStepMode` below). One "Review history"
   * button opens this (issue #264) — the in-review "Step by turn"/"Step by
   * action" toggle then switches `historyStepMode` without leaving review.
   * Sharing one index means both step sizes show the exact same
   * reconstructed historical board (RoundView's `state` prop).
   */
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)
  /**
   * Which step size is currently driving `reviewIndex` — 'action' steps by a
   * single actionHistory entry at a time; 'turn' steps by a whole player's
   * turn at a time (see `fullTurnStops` below). Switched via the in-review
   * "Step by turn"/"Step by action" toggle (issue #264), which snaps
   * `reviewIndex` onto the nearest turn boundary when switching into 'turn'
   * mode so the switch keeps showing whichever turn was already being
   * reviewed. Only meaningful while `reviewIndex !== null`.
   */
  const [historyStepMode, setHistoryStepMode] = useState<'action' | 'turn'>('action')
  /**
   * The review banner's territory-control overlay mode (issue #281,
   * RoundView's `territoryControlMode` prop) — 'off' shows nothing extra,
   * 'on' outlines every currently-controlled region like the victory screen,
   * 'changes' outlines only what flipped since the previously-reviewed point
   * (including a region that turned neutral, shown in black-and-white
   * stripes). Defaults to 'changes' per issue #281 — the most useful
   * at-a-glance view while stepping through history, more so than either the
   * noisier 'on' or the silent 'off'. Cycled off -> on -> changes -> off by
   * one toggle button (TERRITORY_CONTROL_MODES below) rather than three
   * separate buttons, per follow-up request on issue #281.
   */
  const [territoryControlMode, setTerritoryControlMode] = useState<'off' | 'on' | 'changes'>('changes')
  /**
   * Hotseat pass-and-play: which seated player the shared device is
   * currently "handed to" — distinct from auth identity, since every
   * hotseat seat shares one signed-in host's user_id (see gameApi.ts's
   * addLocalPlayer). Null until confirmed via the pass-the-device gate
   * below, and reset whenever a fresh room loads.
   */
  const [hotseatActivePlayerId, setHotseatActivePlayerId] = useState<string | null>(null)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [lifecycleError, setLifecycleError] = useState<AppError | null>(null)
  /**
   * Guards against re-running the auto-enter-review effect below more than
   * once per room load (issue #105).
   */
  const autoReviewAppliedRef = useRef(false)

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
    let cancelled = false
    setGame(null)
    setRoomNotFound(false)
    setLoadError(null)
    setHotseatActivePlayerId(null)
    setReviewIndex(null)
    setHistoryStepMode('action')
    setMapSaved(false)
    setMapSaveError(null)
    autoReviewAppliedRef.current = false
    void (async () => {
      try {
        const foundGame = await getGameByRoomCode(roomCode)
        if (cancelled) return
        if (!foundGame) {
          setRoomNotFound(true)
          return
        }
        setGame(foundGame)
        const foundPlayers = await listPlayers(foundGame.id)
        if (!cancelled) setPlayers(foundPlayers)
      } catch (err) {
        if (!cancelled) setLoadError(toAppError(err, 'Failed to load room'))
      }
    })()
    return () => {
      cancelled = true
    }
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
    // Live status updates (e.g. the Owner canceling from another tab/device)
    // — GamePage otherwise only fetches `game` once on mount, unlike
    // LobbyPage which already subscribes for its own status-driven navigate.
    const unsubscribeGame = subscribeToGame(game.id, setGame)

    return () => {
      cancelled = true
      unsubscribeGameState()
      unsubscribePlayers()
      unsubscribeGame()
    }
  }, [game])

  const boardGenerationContent = useMemo(() => resolveBoardGenerationContent(players.length), [players.length])
  // Tales (src/content/tales.json) and the achievement target chosen at
  // game creation (games.settings.activeTaleIds/gameLength — see
  // CreateGamePage.tsx's TaleSelector/GameLengthSelector) are carried into GameState itself
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
  // A Tale can grant a real Trophy of its own (e.g. The Capital Tale) —
  // merged onto the base achievements the same way Tale unit content is,
  // so claiming it goes through the exact same claim/decline/game-length
  // pipeline as a base achievement. A no-op for a game with no such Tale
  // active, same convention as applyTaleModifiers.
  const achievementContent = useMemo(
    () => applyTaleAchievementModifiers(resolveAchievementContent(gameState?.gameLength), taleContent),
    [gameState?.gameLength, taleContent],
  )

  const isCreator = game?.created_by === session?.user.id
  // Cancel is only offered while the room is genuinely Active (issue
  // section 11) — a finished game still reads `game.status === 'active'`
  // here too (see dbTypes.ts's GameRow comment), so the finer-grained
  // engine status rules out canceling a game that's already over.
  const canCancel = isCreator && game?.status === 'active' && gameState?.status !== 'completed'
  // Admins (0017_admin_delete_any_game.sql) bypass both the ownership and
  // status restrictions — the matching RLS policy is the real guard, same
  // as LobbyPage.tsx's matching canDelete.
  const canDelete = (isCreator && game?.status === 'canceled') || isAdmin
  // Visibility (issue section 4): Owner-only, any time short of canceled —
  // not gameplay configuration, so it stays editable after the room leaves
  // the lobby (see LobbyPage.tsx's matching toggle and setGameVisibility).
  const canEditVisibility = isCreator && game?.status !== 'canceled'
  const isHotseat = game?.play_mode === 'hotseat'
  const isSeatedPlayer = players.some((p) => p.user_id === session?.user.id)

  /**
   * Open spectating in history review mode (issue #105), not live — a
   * non-seated visitor has no `me` and can't act regardless, but landing
   * straight on the live board skips past the one review affordance
   * actually meant for a spectator: scrubbing back through what already
   * happened. Applies once per room load (autoReviewAppliedRef) so it
   * doesn't fight a deliberate "Exit review" click later in the session.
   */
  useEffect(() => {
    if (autoReviewAppliedRef.current || isSeatedPlayer || !gameState) return
    autoReviewAppliedRef.current = true
    setHistoryStepMode('turn')
    setReviewIndex(gameState.actionHistory.length)
  }, [isSeatedPlayer, gameState])

  // Creation-time opt-out (CreateGamePage.tsx's checkbox, checked by default) for groups that don't
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
  // Concede (issue #172): only a seated player, in a game that's actually
  // under way, who hasn't already been eliminated — mirrors CONCEDE's own
  // engine-side rejection of an unknown/already-eliminated player
  // (applyConcede in engine/applyAction.ts).
  const canConcede = !!me && gameState?.status === 'active' && !gameState.players.find((p) => p.id === me.id)?.eliminated
  /**
   * The board's terrain is locked in the moment tile placement finishes —
   * unit placement (boardSetup's second sub-phase, see BoardSetupState in
   * ../engine/types.ts) only ever adds starting units, which handleSaveMap's
   * stripOccupants strips right back out anyway, so there's no reason to
   * keep "Save this map" disabled for that whole sub-phase (issue #294).
   * `active`/`completed` are always save-able too, same as before.
   */
  const canSaveMap = !!gameState && (gameState.status !== 'boardSetup' || gameState.boardSetup?.tileTierQueue.length === 0)

  /**
   * Deterministically rebuilt from the game's row + seated players — see
   * buildGenesisState's own doc comment (genesis itself isn't stored, same
   * as GameState.actionHistory's). Hoisted out of turnReview/gameLog below
   * so both share one build instead of two, and memoized on the actual
   * player fields genesis reads (id/displayName/color — see makePlayer-style
   * mapping in gameGenesis.ts), not just `players`' array identity, which
   * changes on every listPlayers() refetch even when nothing genesis cares
   * about actually changed.
   */
  const playersSignature = useMemo(() => JSON.stringify(players.map((p) => ({ id: p.id, name: p.display_name, color: p.color }))), [players])
  const genesis = useMemo(() => {
    if (!game || players.length === 0) return null
    try {
      return buildGenesisState(game, players)
    } catch {
      // Same "shouldn't be possible for a game this session is actually
      // playing, but fail quiet rather than crash the page" stance
      // turnReview/gameLog already took before this was hoisted out of them.
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, players.length, playersSignature])

  /**
   * Turn boundaries across the ENTIRE actionHistory (issue #261 follow-up:
   * "Show history" must be able to page all the way back through the whole
   * game, not just what happened since the reviewer's own last turn) — see
   * engine/turnReview.ts's findTurnStops. `fullTurnStops[0]` is always 0
   * (genesis) and its last entry is always `gameState.actionHistory.length`
   * (now); every entry in between is a point where the acting player
   * changes. Each entry is itself a valid `reviewIndex` (see below), so
   * "Show history"'s Prev/Next/slider just step across this array instead
   * of the raw action-by-action `reviewIndex` "Review history" uses.
   */
  const fullTurnStops = useMemo(
    () => (gameState ? findTurnStops(gameState.actionHistory, 0) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gameState?.actionHistory],
  )
  /**
   * Where "Show history" defaults to on entry — right after `me`'s own last
   * turn, so paging forward reveals each opponent's turn in order, while
   * Prev can still walk all the way back to genesis (issue #261). An
   * observer has no turn of their own to anchor to, so they start at
   * genesis (0) instead.
   *
   * `findReviewWindowStart`'s raw result isn't always one of
   * `fullTurnStops`'s own values, though: `me`'s own last action can land
   * inside a simultaneous `selectCards`/`declinePurchase` group (see
   * `ReviewPhaseGroup`'s doc comment) immediately before a DIFFERENT
   * player's action within that same group — `findTurnStops` never draws a
   * boundary there, since those groups intentionally don't split per actor.
   * Every other bit of turn-mode logic (Prev/Next's `currentTurnPos`, the
   * halo/recap lookups above) assumes `reviewIndex` is always one of
   * `fullTurnStops`'s own values, so snap forward to the next real stop —
   * this can only ever land later within the same still-open group (often
   * exactly "now", if nothing outside that group followed), never skip past
   * a turn `me` hasn't reviewed yet (issue #333: this mismatch is what left
   * "Review history"'s Next button wrongly disabled the instant it opened,
   * for a finished game where the reviewer's own last action fell inside
   * the final round's decline/purchase phase).
   */
  const defaultTurnHistoryIndex = useMemo(() => {
    if (!gameState) return 0
    const rawStart = me ? findReviewWindowStart(gameState.actionHistory, me.id) : 0
    if (!fullTurnStops) return rawStart
    return fullTurnStops.find((stop) => stop >= rawStart) ?? fullTurnStops[fullTurnStops.length - 1]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState?.actionHistory, me?.id, fullTurnStops])

  /**
   * The running narration log (see engine/gameLog.ts) — nothing about it is
   * stored on GameState, so it's rebuilt from the full actionHistory the
   * same way turnReview rebuilds its own windowed slice above, just without
   * a window: every logged action, from genesis, gets its line(s). Unlike
   * turnReview's window, there's no cheaper starting point available here —
   * every action, from every player, always belongs in the full log. What
   * IS avoidable is re-replaying the *entire* history from genesis on every
   * single new action (which is what made this scale worse the longer a
   * game went on): gameLogCacheRef keeps the last-computed {actionHistory,
   * state, events} around, and on the very common case of the new
   * actionHistory being exactly that same prefix plus newly-appended
   * actions (checked cheaply via a boundary-entry comparison, not a full
   * deep-equal — event-sourcing here only ever appends or, via Undo,
   * truncates from the end, never rewrites an already-logged entry in
   * place), only extendGameLog()s the new suffix on top of the cached
   * state instead of replaying from genesis again. Falls back to a full
   * buildGameLogFrom() whenever that invariant doesn't hold (a different
   * game/players/content, or a history that no longer starts with the
   * cached prefix — e.g. Undo followed by a different action).
   */
  const gameLogCacheRef = useRef<{
    gameId: string
    playersSignature: string
    unitContent: typeof unitContent
    achievementContent: typeof achievementContent
    boardGenerationContent: typeof boardGenerationContent
    taleContent: typeof taleContent
    actionHistory: LoggedAction[]
    state: EngineGameState
    events: GameEvent[]
  } | null>(null)

  const gameLog = useMemo(() => {
    if (!game || !genesis) return []
    const actionHistory = gameState?.actionHistory ?? []
    const cache = gameLogCacheRef.current

    const cacheCoversPrefix =
      !!cache &&
      cache.gameId === game.id &&
      cache.playersSignature === playersSignature &&
      cache.unitContent === unitContent &&
      cache.achievementContent === achievementContent &&
      cache.boardGenerationContent === boardGenerationContent &&
      cache.taleContent === taleContent &&
      cache.actionHistory.length <= actionHistory.length &&
      (cache.actionHistory.length === 0 ||
        JSON.stringify(cache.actionHistory[cache.actionHistory.length - 1]) === JSON.stringify(actionHistory[cache.actionHistory.length - 1]))

    try {
      if (cacheCoversPrefix && cache) {
        const newActions = actionHistory.slice(cache.actionHistory.length)
        if (newActions.length === 0) return cache.events
        const extended = extendGameLog(cache.state, newActions, cache.events.length + 1, unitContent, achievementContent, boardGenerationContent, taleContent)
        const events = [...cache.events, ...extended.events]
        gameLogCacheRef.current = { ...cache, actionHistory, state: extended.state, events }
        return events
      }

      const built = buildGameLogFrom(genesis, actionHistory, unitContent, achievementContent, boardGenerationContent, taleContent)
      gameLogCacheRef.current = {
        gameId: game.id,
        playersSignature,
        unitContent,
        achievementContent,
        boardGenerationContent,
        taleContent,
        actionHistory,
        state: built.state,
        events: built.events,
      }
      return built.events
    } catch {
      gameLogCacheRef.current = null
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, genesis, playersSignature, gameState?.actionHistory, unitContent, achievementContent, boardGenerationContent, taleContent])

  const reviewMaxIndex = gameState?.actionHistory.length ?? 0
  const isReviewingHistory = reviewIndex !== null

  /**
   * The state (for BoardSetupView/RoundView) and narration log (see
   * engine/gameLog.ts) at `reviewIndex` (see its doc comment above) —
   * reusing `gameLog` above as-is for the log would leak entries from after
   * the reviewed point (and everyone else's future moves, in an async
   * game), defeating the point of a spoiler-free "what did the board look
   * like back then" view, so both are rebuilt from genesis up to
   * `reviewIndex` specifically.
   *
   * Scrubbing through review (the Prev/Next buttons and slider) used to
   * replay the *entire* prefix from genesis on every single step — the
   * same O(n) per-step / O(n^2) over a scrub session that made the live
   * narration log slow before it got gameLogCacheRef below. This keeps its
   * own equivalent: `reviewCacheRef` remembers every state/log-so-far it's
   * ever derived, indexed by how many actions had been applied, and only
   * computes the actions between the highest index already cached and
   * whatever's newly requested — because each step is derived from the one
   * before it, walking forward to a never-before-seen index naturally
   * back-fills every index in between too, so the cache ends up dense
   * (0..maxIndex), not just holding whichever indices were explicitly
   * visited. Revisiting any already-cached index (stepping back, or
   * forward within ground already covered) is then a plain array lookup.
   * Same prefix-validity/invalidation rule as gameLogCacheRef above
   * (actionHistory only ever appends or, via Undo, truncates from the end)
   * — a truncation invalidates the whole cache, since indices past the
   * truncation point may now derive from different actions.
   */
  const reviewCacheRef = useRef<{
    gameId: string
    playersSignature: string
    unitContent: typeof unitContent
    achievementContent: typeof achievementContent
    boardGenerationContent: typeof boardGenerationContent
    taleContent: typeof taleContent
    actionHistory: LoggedAction[]
    states: EngineGameState[]
    events: GameEvent[]
    eventCountAtIndex: number[]
  } | null>(null)

  const { reviewState, reviewGameLog, turnHalos, previousTerritoryState, showCardChoiceRecap } = useMemo((): {
    reviewState: EngineGameState | null
    reviewGameLog: GameEvent[]
    turnHalos: TurnReview | null
    previousTerritoryState: EngineGameState | null
    showCardChoiceRecap: boolean
  } => {
    if (reviewIndex === null || !game || !genesis || !gameState)
      return { reviewState: null, reviewGameLog: [], turnHalos: null, previousTerritoryState: null, showCardChoiceRecap: false }
    const actionHistory = gameState.actionHistory
    let cache = reviewCacheRef.current

    const cacheCoversPrefix =
      !!cache &&
      cache.gameId === game.id &&
      cache.playersSignature === playersSignature &&
      cache.unitContent === unitContent &&
      cache.achievementContent === achievementContent &&
      cache.boardGenerationContent === boardGenerationContent &&
      cache.taleContent === taleContent &&
      cache.actionHistory.length <= actionHistory.length &&
      (cache.actionHistory.length === 0 ||
        JSON.stringify(cache.actionHistory[cache.actionHistory.length - 1]) === JSON.stringify(actionHistory[cache.actionHistory.length - 1]))

    try {
      if (!cacheCoversPrefix || !cache) {
        const initialEvents: GameEvent[] =
          genesis.status === 'boardSetup' ? [{ id: 'evt_1', turn: genesis.turn, playerId: null, message: 'Board setup begins', timestamp: '' }] : []
        cache = {
          gameId: game.id,
          playersSignature,
          unitContent,
          achievementContent,
          boardGenerationContent,
          taleContent,
          actionHistory,
          states: [genesis],
          events: initialEvents,
          eventCountAtIndex: [initialEvents.length],
        }
      }

      while (cache.states.length - 1 < reviewIndex) {
        const fromIndex = cache.states.length - 1
        const extended = extendGameLog(
          cache.states[fromIndex],
          [actionHistory[fromIndex]],
          cache.events.length + 1,
          unitContent,
          achievementContent,
          boardGenerationContent,
          taleContent,
        )
        if (extended.state === cache.states[fromIndex]) {
          // A validly-logged action should never fail to reapply — bail
          // defensively (caught below) rather than cache a duplicate state
          // under the wrong index and silently desync every later index.
          throw new Error(`Review replay failed at action ${fromIndex}`)
        }
        cache.states.push(extended.state)
        cache.events = [...cache.events, ...extended.events]
        cache.eventCountAtIndex.push(cache.events.length)
      }
      cache.actionHistory = actionHistory
      reviewCacheRef.current = cache

      // "Show history" (turn mode) also highlights what happened during the
      // single turn currently on screen — the diff between the previously
      // replayed state just before this turn started and the one now shown
      // (issue #261). Both ends are already in `cache.states` (dense up to
      // `reviewIndex`), so this is a small, single-turn buildTurnReview
      // call, not a fresh whole-game replay. Skipped at the default entry
      // point (`defaultTurnHistoryIndex`) and at genesis (index 0) — there's
      // no "just happened" turn to highlight at either (see
      // `defaultTurnHistoryIndex`'s own doc comment: paging forward from
      // there is what reveals each opponent's turn).
      let turnHalos: TurnReview | null = null
      // The territory-control "highlight changes" mode (issue #281) needs
      // the same "state just before this point" boundary turnHalos already
      // diffs against — reusing its exact prevStop (and the same
      // defaultTurnHistoryIndex/genesis skip) keeps both features agreeing
      // on what "just changed" means at any given point in turn mode. Action
      // mode has no equivalent halo feature to share a boundary with, so it
      // just uses the one action immediately prior.
      let previousTerritoryState: EngineGameState | null = null
      if (historyStepMode === 'turn' && reviewIndex > 0 && reviewIndex !== defaultTurnHistoryIndex && fullTurnStops) {
        const pos = fullTurnStops.indexOf(reviewIndex)
        if (pos > 0) {
          const prevStop = fullTurnStops[pos - 1]
          turnHalos = buildTurnReview(cache.states[prevStop], actionHistory.slice(prevStop, reviewIndex), unitContent, achievementContent, boardGenerationContent, taleContent)
          previousTerritoryState = cache.states[prevStop]
        }
      } else if (historyStepMode === 'action' && reviewIndex > 0) {
        previousTerritoryState = cache.states[reviewIndex - 1]
      }

      // The card-choice recap overlay's own "is this the first stop showing
      // it" check (issue #326 follow-up, refined by #331) needs the
      // roundPhase (and round number, see recapTurnFor) the PREVIOUS
      // turn-stop actually replayed to — see shouldShowCardChoiceRecap's doc
      // comment for why that can't be read off this stop's own action types.
      // Computed independently of `previousTerritoryState` above: that one
      // intentionally goes null at `defaultTurnHistoryIndex` (issue #261 —
      // no "just happened" turn to halo-highlight there), but the recap
      // should still reflect a real phase change at that same point. Both
      // this stop's and the previous stop's phase go through
      // `roundPhaseForRecap`, not the replayed state's raw `roundPhase` —
      // see that function's doc comment for why a completed `declinePurchase`
      // stop's raw `roundPhase` can't be trusted (issue #326's second
      // follow-up).
      let previousStop: { roundPhase: EngineGameState['roundPhase']; recapTurn: number } | null = null
      if (historyStepMode === 'turn' && fullTurnStops) {
        const pos = fullTurnStops.indexOf(reviewIndex)
        if (pos > 0) {
          const prevStop = fullTurnStops[pos - 1]
          previousStop = { roundPhase: roundPhaseForRecap(actionHistory, prevStop, cache.states[prevStop]), recapTurn: recapTurnFor(cache.states[prevStop]) }
        }
      }
      const showCardChoiceRecap = shouldShowCardChoiceRecap(
        roundPhaseForRecap(actionHistory, reviewIndex, cache.states[reviewIndex]),
        recapTurnFor(cache.states[reviewIndex]),
        previousStop,
        historyStepMode,
      )

      return {
        reviewState: cache.states[reviewIndex],
        reviewGameLog: cache.events.slice(0, cache.eventCountAtIndex[reviewIndex]),
        turnHalos,
        previousTerritoryState,
        showCardChoiceRecap,
      }
    } catch {
      reviewCacheRef.current = null
      return { reviewState: null, reviewGameLog: [], turnHalos: null, previousTerritoryState: null, showCardChoiceRecap: false }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    reviewIndex,
    game,
    genesis,
    gameState?.actionHistory,
    playersSignature,
    unitContent,
    achievementContent,
    boardGenerationContent,
    taleContent,
    historyStepMode,
    fullTurnStops,
    defaultTurnHistoryIndex,
  ])

  /** The action most recently applied as of `reviewIndex`, for the review banner's label — null at genesis (reviewIndex 0). */
  const reviewActionMeta = reviewIndex !== null && reviewIndex > 0 ? (gameState?.actionHistory[reviewIndex - 1] ?? null) : null

  /** How many turns `fullTurnStops` covers — "Show history"'s slider/Prev/Next range. */
  const turnPosCount = fullTurnStops ? fullTurnStops.length - 1 : 0
  /** Where `reviewIndex` currently sits within `fullTurnStops`, for "Show history"'s slider — only meaningful (and always found) while `historyStepMode === 'turn'`, since that's the only mode that ever sets `reviewIndex` to one of `fullTurnStops`'s own values. */
  const currentTurnPos = fullTurnStops && reviewIndex !== null ? fullTurnStops.indexOf(reviewIndex) : -1
  /** The history banner's status text — branches on `historyStepMode` since "Review history" and "Show history" share the one banner but describe different units (actions vs. turns). */
  const historyBannerLabel = (() => {
    if (reviewIndex === null) return ''
    if (historyStepMode !== 'turn') {
      return reviewActionMeta ? `Turn ${reviewActionMeta.turn} — action ${reviewIndex} of ${reviewMaxIndex}` : 'Start of game (before any actions)'
    }
    if (reviewIndex === defaultTurnHistoryIndex && defaultTurnHistoryIndex === reviewMaxIndex) {
      return me ? 'Nothing since your last turn.' : 'Nothing has happened yet.'
    }
    if (reviewIndex === 0) return 'Start of the game'
    if (reviewIndex === defaultTurnHistoryIndex) return 'Right after your last turn'
    // selectCards/declinePurchase are simultaneous — every player acts at once, so
    // there's no single "next" player to name; show the phase instead (issue #324).
    const group = gameState ? reviewPhaseGroupAt(gameState.actionHistory, reviewIndex) : null
    if (group === 'selectCards') return `Select cards (${currentTurnPos} of ${turnPosCount})`
    if (group === 'declinePurchase') return `Decline / Purchase (${currentTurnPos} of ${turnPosCount})`
    const actorId = gameState?.actionHistory[reviewIndex - 1]?.action.playerId ?? null
    const actorName = players.find((p) => p.id === actorId)?.display_name ?? 'Unknown'
    return `${actorName}'s turn (${currentTurnPos} of ${turnPosCount})`
  })()

  const displayState = isReviewingHistory ? reviewState : gameState

  /**
   * The "total score over time" series behind EndGameView's line chart —
   * only worth deriving once the game is actually over, and only from the
   * real (not history-review) state, so reviewing an earlier round never
   * flickers the end-of-game chart's data. Keyed on actionHistory's length
   * rather than `gameState` itself so an identical completed state refetched
   * by a live subscription doesn't retrigger a full game replay for no
   * reason (same rationale as playersSignature above).
   */
  const scoreHistory = useMemo(() => {
    if (!genesis || !gameState || gameState.status !== 'completed') return null
    return calculateScoreHistory(genesis, gameState.actionHistory, unitContent, achievementContent, boardGenerationContent, taleContent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genesis, gameState?.status, gameState?.actionHistory.length, unitContent, achievementContent, boardGenerationContent, taleContent])

  /**
   * Per-player, per-unit-kind "unit value" breakdown behind EndGameView's
   * stacked bar chart (issue #335) — same "only once the game is over, keyed
   * on actionHistory's length" rationale as scoreHistory above, since this
   * also replays the whole game to attribute cumulative gold production per
   * unit kind (./engine/unitValue.ts).
   */
  const unitValueDetail = useMemo(() => {
    if (!genesis || !gameState || gameState.status !== 'completed') return null
    return calculateUnitValueDetail(gameState, genesis, gameState.actionHistory, unitContent, achievementContent, boardGenerationContent, taleContent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genesis, gameState?.status, gameState?.actionHistory.length, unitContent, achievementContent, boardGenerationContent, taleContent])

  /**
   * Per-player gold-spending breakdown by category behind EndGameView's
   * "Spending" stacked bar chart (issue #336 follow-up) — same "only once the
   * game is over, keyed on actionHistory's length" rationale as
   * unitValueDetail above, since this also replays the whole game
   * (./engine/unitValue.ts).
   */
  const spendingBreakdown = useMemo(() => {
    if (!genesis || !gameState || gameState.status !== 'completed') return null
    return calculateGoldSpendingByCategory(genesis, gameState.actionHistory, unitContent, achievementContent, boardGenerationContent, taleContent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genesis, gameState?.status, gameState?.actionHistory.length, unitContent, achievementContent, boardGenerationContent, taleContent])

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
    if (isReviewingHistory) {
      // Belt-and-suspenders alongside passing myPlayerId={null} to every
      // view below while reviewing, which already keeps their UI from
      // calling any of these in the first place.
      return { ok: false, error: 'Exit history review before making changes.' }
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
    setActionError(result.ok ? null : simpleError(result.error))
  }

  /**
   * Concede (issue #172): a seated, not-yet-eliminated player gives up —
   * treated identically to an automatic no-card elimination (see
   * eliminatePlayer in engine/elimination.ts, and CONCEDE's dispatch in
   * engine/applyAction.ts), removed from the board/turn order for the rest
   * of the game and excluded from winning. Unlike every other action `me`
   * submits below, this isn't gated on it being their turn or any
   * particular round phase — a player can concede at any point once the
   * game is active.
   */
  async function handleConcede() {
    if (!me) return
    if (!window.confirm('Concede this game? You will be eliminated and cannot undo this by yourself — this cannot be undone.')) return
    await submitAction({ type: 'CONCEDE', playerId: me.id })
  }

  /**
   * True when `action` was CHOOSE_CARD for a player who, in `stateBefore`
   * (the state right before it was applied), had exactly one card in hand
   * — i.e. it wasn't a real decision, SelectCardsPanel's auto-choose effect
   * (RoundView.tsx) submitted it the instant the phase made that player
   * pending, and would instantly do so again if Undo stopped here. Used by
   * handleUndo to keep walking back past these instead of landing on one.
   */
  function wasForcedCardChoice(stateBefore: EngineGameState, action: Action): boolean {
    if (action.type !== 'CHOOSE_CARD') return false
    const player = stateBefore.players.find((p) => p.id === action.playerId)
    return !!player && player.handCardIds.length === 1
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
   *
   * "One action" can mean more than one actionHistory entry: see
   * wasForcedCardChoice below.
   */
  async function handleUndo() {
    if (!game) return
    setUndoing(true)
    let undoneActions: Action[] = []
    try {
      const result = await writeWithRetry((state) => {
        if (state.actionHistory.length === 0) {
          return { ok: false, error: 'Nothing left to undo.' }
        }
        const genesis = buildGenesisState(game, players)
        undoneActions = []
        let history = state.actionHistory
        let undoneState: EngineGameState
        // A CHOOSE_CARD submitted for a one-card hand (SelectCardsPanel's
        // auto-choose, RoundView.tsx) wasn't a real decision — stepping back
        // past just that one action would land right back on the same
        // forced choice, which the UI would instantly auto-resubmit, making
        // Undo look like a no-op (issue #131). Keep walking back past any
        // number of these until an action the player actually chose is
        // reached, or history runs out.
        do {
          const lastAction = history[history.length - 1].action
          undoneActions.push(lastAction)
          history = history.slice(0, -1)
          undoneState = replayActions(genesis, history, unitContent, achievementContent, boardGenerationContent, taleContent)
        } while (history.length > 0 && wasForcedCardChoice(undoneState, undoneActions[undoneActions.length - 1]))
        return { ok: true, state: undoneState }
      })
      if (result.ok && undoneActions.length > 0) {
        setRedoStack((stack) => [...stack, ...undoneActions])
      }
      setActionError(result.ok ? null : simpleError(result.error))
    } catch (err) {
      // replayActions (./gameGenesis.ts's buildGenesisState + ../engine/
      // replay.ts) throws "Replay failed at action ...: <reason>" if some
      // earlier action in this game's history no longer replays cleanly —
      // e.g. a rules change landed on the live site while this particular
      // game was in progress, so an action genuinely accepted back then no
      // longer validates against today's rules. That JSON-dump message is
      // meant for a developer, not a player, so show a plain explanation
      // instead and keep the raw detail in the console for a bug report.
      if (err instanceof Error && err.message.startsWith('Replay failed')) {
        console.error('Undo: history no longer replays cleanly', err)
        setActionError(
          simpleError(
            "Can't undo: this game's history no longer replays under the current rules, so Undo isn't available for this game.",
          ),
        )
      } else {
        setActionError(toAppError(err, 'Failed to undo'))
      }
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
      setActionError(result.ok ? null : simpleError(result.error))
    } catch (err) {
      setActionError(toAppError(err, 'Failed to redo'))
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
   * chat (easily tens of KB). This copies a "game export" instead — a real
   * JSON file (see gameStateExport.schema.json) whose gameStateZipped field
   * gzip+base64-encodes the state, a fraction of the size and self-describing
   * (schema/version) so it can be decoded back into the exact state it came
   * from.
   */
  async function handleCopyStateExport() {
    if (!gameState) return
    setStateExportError(null)
    try {
      await navigator.clipboard.writeText(await encodeGameStateExport(gameState))
      setCopiedStateExport(true)
      setTimeout(() => setCopiedStateExport(false), 1500)
    } catch (err) {
      setStateExportError(toAppError(err, 'Failed to copy game state export'))
    }
  }

  /**
   * Save this game's current board terrain to the map pool (issue #164) —
   * the same pool src/pages/MapBuilderPage.tsx's dedicated build-a-map flow
   * (issue #23) feeds, just sourced from a real game already under way
   * instead of a from-scratch builder session. `stripOccupants` clears the
   * board's unit/settlement occupancy first: a pool entry only ever seeds a
   * future game's terrain (see beginBoardSetupWithPresetBoard), and this
   * game's own unit ids on the board wouldn't mean anything there.
   */
  async function handleSaveMap() {
    if (!gameState || !session) return
    setSavingMap(true)
    setMapSaveError(null)
    try {
      await saveMapToPool({ board: stripOccupants(gameState.board), playerCount: players.length, userId: session.user.id })
      setMapSaved(true)
      setTimeout(() => setMapSaved(false), 1500)
    } catch (err) {
      setMapSaveError(toAppError(err, 'Failed to save map'))
    } finally {
      setSavingMap(false)
    }
  }

  async function handleCancelRoom() {
    if (!game) return
    if (!window.confirm('Cancel this room? Play will be disabled for everyone — this cannot be undone.')) return
    setLifecycleBusy(true)
    setLifecycleError(null)
    try {
      await cancelGame(game.id)
    } catch (err) {
      setLifecycleError(toAppError(err, 'Failed to cancel room'))
    } finally {
      setLifecycleBusy(false)
    }
  }

  async function handleToggleVisibility() {
    if (!game) return
    setLifecycleBusy(true)
    setLifecycleError(null)
    try {
      await setGameVisibility(game.id, game.visibility === 'public' ? 'private' : 'public')
    } catch (err) {
      setLifecycleError(toAppError(err, 'Failed to update visibility'))
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
      setLifecycleError(toAppError(err, 'Failed to delete room'))
      setLifecycleBusy(false)
    }
  }

  if (authLoading || !session) return <div className="p-8 text-neutral-400">Loading…</div>
  if (loadError) {
    return (
      <div className="p-8">
        <ErrorBanner message={loadError.message} details={loadError.details} />
      </div>
    )
  }
  if (roomNotFound) return <div className="p-8 text-neutral-400">Room {roomCode} not found.</div>
  if (!game) return <div className="p-8 text-neutral-400">Looking for room {roomCode}…</div>

  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-8 lg:max-w-6xl xl:max-w-7xl"
      onClick={(event) => {
        // Reviewing history has no "save"/confirm step to protect — any
        // click outside the review banner itself (the board, the sidebar,
        // the header, anywhere) exits back to live play, the same as
        // clicking "Back to live" (issue #285 follow-up: originally only
        // the board's own hexes did this, via RoundView's onExitHistory).
        if (!isReviewingHistory) return
        if (reviewBannerRef.current?.contains(event.target as Node)) return
        setReviewIndex(null)
      }}
    >
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
                {canConcede && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isReviewingHistory}
                    onClick={() => {
                      setMenuOpen(false)
                      void handleConcede()
                    }}
                    title="Concede this game — you'll be eliminated and can no longer act, same as running out of cards."
                    className="px-3 py-2 text-left text-red-400 hover:bg-neutral-800 disabled:opacity-50"
                  >
                    Concede
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  disabled={!gameState}
                  onClick={() => {
                    setMenuOpen(false)
                    void handleCopyStateExport()
                  }}
                  title="Copies a game state export (a small JSON file) to the clipboard — paste it into a bug report or chat, or save it as a .json file."
                  className="px-3 py-2 text-left hover:bg-neutral-800 disabled:opacity-50"
                >
                  Copy game export
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
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canSaveMap || savingMap}
                  onClick={() => {
                    setMenuOpen(false)
                    void handleSaveMap()
                  }}
                  title="Save this game's current board layout to the map pool, so a future game can start from it. Available once tile placement finishes — the terrain won't change after that."
                  className="px-3 py-2 text-left hover:bg-neutral-800 disabled:opacity-50"
                >
                  {savingMap ? 'Saving map…' : 'Save this map'}
                </button>
                {canEditVisibility && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={lifecycleBusy}
                    onClick={() => {
                      setMenuOpen(false)
                      void handleToggleVisibility()
                    }}
                    title="Toggle whether this room is listed on the Public rooms screen."
                    className="px-3 py-2 text-left hover:bg-neutral-800 disabled:opacity-50"
                  >
                    Make {game.visibility === 'public' ? 'private' : 'public'}
                  </button>
                )}
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
          <h1 className="text-2xl font-semibold">{game.name}</h1>
          <p className="text-sm text-neutral-500">Room {game.room_code}</p>
          <ul className="flex flex-wrap gap-3 text-sm text-neutral-400">
            {players.map((p) => (
              <li key={p.id} className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
                {p.display_name}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={undoing || isReviewingHistory || !gameState || gameState.actionHistory.length === 0}
            onClick={() => void handleUndo()}
            title="Undo the last action — any player can do this, at any time, even after the game has ended."
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
          >
            {undoing ? 'Undoing…' : 'Undo'}
          </button>
          <button
            type="button"
            disabled={redoing || isReviewingHistory || redoStack.length === 0}
            onClick={() => void handleRedo()}
            title="Redo the last undone action."
            className="rounded-md border border-neutral-700 px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50"
          >
            {redoing ? 'Redoing…' : 'Redo'}
          </button>
          <button
            type="button"
            disabled={!gameState || reviewMaxIndex === 0}
            onClick={() => {
              if (isReviewingHistory) {
                setReviewIndex(null)
                return
              }
              setHistoryStepMode('turn')
              setReviewIndex(defaultTurnHistoryIndex)
            }}
            title={
              me
                ? "Step through the game's history — turn by turn or action by action, switchable once open — starting right after your own last turn so you can review what every opponent did since. Unlike Undo, this never touches the live game."
                : "Step through the game's history — turn by turn or action by action, switchable once open. Unlike Undo, this never touches the live game."
            }
            className={`rounded-md border px-3 py-1 text-sm hover:border-neutral-500 disabled:opacity-50 ${
              isReviewingHistory ? 'border-amber-500 text-amber-400' : 'border-neutral-700'
            }`}
          >
            {isReviewingHistory ? 'Exit review' : 'Review history'}
          </button>
        </div>
      </header>

      {isReviewingHistory && (
        <div
          ref={reviewBannerRef}
          className="flex flex-wrap items-center gap-3 rounded-md border border-amber-700/40 bg-amber-500/10 p-3 text-sm text-amber-200"
        >
          <span className="font-medium">Reviewing history</span>
          <button
            type="button"
            onClick={() => {
              if (historyStepMode === 'turn') {
                setHistoryStepMode('action')
                return
              }
              // Switching into turn mode must land on the turn stop that
              // completes whichever turn `reviewIndex` currently sits inside
              // (or the exact stop it's already on) — turn mode's Prev/Next
              // and `turnHalos` both assume `reviewIndex` is one of
              // `fullTurnStops`'s own values (see `currentTurnPos` above), and
              // this keeps the switch showing the same turn just reviewed
              // instead of jumping elsewhere in the game.
              const current = reviewIndex ?? 0
              const target = fullTurnStops ? (fullTurnStops.find((stop) => stop >= current) ?? fullTurnStops[fullTurnStops.length - 1]) : current
              setHistoryStepMode('turn')
              setReviewIndex(target)
            }}
            title={
              historyStepMode === 'turn'
                ? 'Switch to stepping action by action instead of turn by turn.'
                : 'Switch to stepping turn by turn instead of action by action.'
            }
            className="rounded-md border border-amber-700/60 px-2 py-0.5 hover:border-amber-400"
          >
            {historyStepMode === 'turn' ? 'Step by action' : 'Step by turn'}
          </button>
          <button
            type="button"
            onClick={() =>
              setTerritoryControlMode((current) => {
                const currentIndex = TERRITORY_CONTROL_MODES.findIndex((m) => m.mode === current)
                return TERRITORY_CONTROL_MODES[(currentIndex + 1) % TERRITORY_CONTROL_MODES.length].mode
              })
            }
            title={TERRITORY_CONTROL_MODES.find((m) => m.mode === territoryControlMode)?.title}
            className={`rounded-md border px-2 py-0.5 hover:border-amber-400 ${
              territoryControlMode === 'off' ? 'border-amber-700/60' : 'border-amber-500 bg-amber-500/10 text-amber-300'
            }`}
          >
            {TERRITORY_CONTROL_MODES.find((m) => m.mode === territoryControlMode)?.label}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={historyStepMode === 'turn' ? currentTurnPos <= 0 : reviewIndex === 0}
              onClick={() => {
                if (historyStepMode === 'turn') {
                  if (fullTurnStops && currentTurnPos > 0) setReviewIndex(fullTurnStops[currentTurnPos - 1])
                } else {
                  setReviewIndex((i) => Math.max(0, (i ?? 0) - 1))
                }
              }}
              title={historyStepMode === 'turn' ? 'Step back one turn.' : 'Step back one action.'}
              className="rounded-md border border-amber-700/60 px-2 py-0.5 hover:border-amber-400 disabled:opacity-40"
            >
              ← Prev
            </button>
            <input
              type="range"
              min={0}
              max={historyStepMode === 'turn' ? turnPosCount : reviewMaxIndex}
              value={historyStepMode === 'turn' ? Math.max(0, currentTurnPos) : (reviewIndex ?? 0)}
              onChange={(e) => {
                const value = Number(e.target.value)
                if (historyStepMode === 'turn') {
                  if (fullTurnStops) setReviewIndex(fullTurnStops[value])
                } else {
                  setReviewIndex(value)
                }
              }}
              className="w-40"
            />
            <button
              type="button"
              disabled={historyStepMode === 'turn' ? currentTurnPos < 0 || currentTurnPos >= turnPosCount : reviewIndex === reviewMaxIndex}
              onClick={() => {
                if (historyStepMode === 'turn') {
                  if (fullTurnStops && currentTurnPos >= 0 && currentTurnPos < turnPosCount) setReviewIndex(fullTurnStops[currentTurnPos + 1])
                } else {
                  setReviewIndex((i) => Math.min(reviewMaxIndex, (i ?? 0) + 1))
                }
              }}
              title={historyStepMode === 'turn' ? 'Step forward one turn.' : 'Step forward one action.'}
              className="rounded-md border border-amber-700/60 px-2 py-0.5 hover:border-amber-400 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
          <span>{historyBannerLabel}</span>
          <button
            type="button"
            onClick={() => setReviewIndex(null)}
            className="ml-auto rounded-md border border-amber-700/60 px-3 py-1 font-medium hover:border-amber-400"
          >
            Back to live
          </button>
        </div>
      )}

      {stateExportError && (
        <ErrorBanner message={stateExportError.message} details={stateExportError.details} onDismiss={() => setStateExportError(null)} />
      )}

      {copiedStateExport && !showStateJson && (
        <div className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-400">Game export copied to clipboard!</div>
      )}

      {mapSaveError && <ErrorBanner message={mapSaveError.message} details={mapSaveError.details} onDismiss={() => setMapSaveError(null)} />}

      {mapSaved && <div className="rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-400">Map saved to the pool!</div>}

      {lifecycleError && (
        <ErrorBanner message={lifecycleError.message} details={lifecycleError.details} onDismiss={() => setLifecycleError(null)} />
      )}

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
              title="Copies a game state export (a small JSON file) — easier to paste into a bug report or chat, or save as a .json file, than the full JSON below."
              className="rounded-md border border-neutral-700 px-3 py-1 text-xs hover:border-neutral-500"
            >
              {copiedStateExport ? 'Copied!' : 'Copy game export'}
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

      {actionError && <ErrorBanner message={actionError.message} details={actionError.details} onDismiss={() => setActionError(null)} />}

      {!gameState && <p className="text-neutral-400">Setting up the game…</p>}

      {needsHotseatGate && pendingActorId && !isReviewingHistory && (
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

      {(!needsHotseatGate || isReviewingHistory) && displayState?.status === 'boardSetup' && (
        <BoardSetupView
          state={displayState}
          players={players}
          myPlayerId={isReviewingHistory ? null : (me?.id ?? null)}
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

      {displayState?.status === 'completed' && (
        <EndGameView
          state={displayState}
          players={players}
          achievementContent={achievementContent}
          taleContent={taleContent}
          scoreHistory={scoreHistory?.snapshots}
          achievementClaims={scoreHistory?.achievementClaims}
          unitValueDetail={unitValueDetail}
          spendingBreakdown={spendingBreakdown}
        />
      )}

      {(!needsHotseatGate || isReviewingHistory) && displayState?.status === 'active' && (
        <RoundView
          state={displayState}
          players={players}
          myPlayerId={isReviewingHistory ? null : (me?.id ?? null)}
          unitContent={unitContent}
          achievementContent={achievementContent}
          taleContent={taleContent}
          unitPlateColors={unitPlateColors}
          turnReview={turnHalos}
          showHistory={isReviewingHistory}
          showCardChoiceRecap={showCardChoiceRecap}
          onExitHistory={() => setReviewIndex(null)}
          territoryControlMode={territoryControlMode}
          previousHistoryState={previousTerritoryState}
          gameLog={isReviewingHistory ? reviewGameLog : gameLog}
          isAdmin={isAdmin}
          onChooseCard={(cardId) => {
            if (!me) return
            void submitAction({ type: 'CHOOSE_CARD', playerId: me.id, cardId })
          }}
          onResolveUnit={(unitId, actionId, target) => {
            if (!me) return
            void submitAction({ type: 'RESOLVE_UNIT_ACTION', playerId: me.id, unitActions: [{ unitId, actionId, target }] })
          }}
          onResolveBulkAction={(unitIds, actionId) => {
            if (!me) return
            void submitAction({ type: 'RESOLVE_UNIT_ACTION', playerId: me.id, unitActions: unitIds.map((unitId) => ({ unitId, actionId })) })
          }}
          onResolveSupportedAction={(supportAssignments, primary) => {
            if (!me) return
            void submitAction({ type: 'RESOLVE_UNIT_ACTION', playerId: me.id, unitActions: [...supportAssignments, primary] })
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

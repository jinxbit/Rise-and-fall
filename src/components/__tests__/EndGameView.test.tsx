import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EndGameView } from '../EndGameView'
import { EMPTY_ACHIEVEMENT_CONTENT } from '../../engine/achievementContent'
import type { AchievementContent } from '../../engine/achievementContent'
import { createEmptyBoard } from '../../engine/board'
import { createPlayerCards } from '../../engine/cards'
import { EMPTY_TALE_CONTENT } from '../../engine/taleContent'
import type { GameState, Player, Unit } from '../../engine/types'
import type { PlayerRow } from '../../lib/dbTypes'

function makePlayerRow(id: string, displayName: string, color: string): PlayerRow {
  return { id, game_id: 'g1', user_id: id, display_name: displayName, avatar_url: null, seat_index: 0, color, is_active: true, joined_at: '', ready_for_version: 0 }
}

function makeEnginePlayer(id: string, gold: number): Player {
  return {
    id,
    authUserId: null,
    displayName: id,
    color: 'red',
    handCardIds: [],
    currentlyPlayedCardId: null,
    discardCardIds: [],
    supplyCardIds: createPlayerCards(id).map((c) => c.id),
    declineCardIds: [],
    eliminated: false,
    resources: { gold, wood: 0, stone: 0 },
  }
}

function unitAt(ownerId: string, kind: string): Unit {
  return { id: `${ownerId}-${kind}`, ownerId, kind, coord: { q: 0, r: 0 }, movement: { isMobile: false, terrains: [], canCrossCliffs: false }, traits: [] }
}

function makeState(): GameState {
  const p1 = makeEnginePlayer('p1', 4)
  const p2 = makeEnginePlayer('p2', 0)
  const cards = Object.fromEntries([...createPlayerCards('p1'), ...createPlayerCards('p2')].map((c) => [c.id, c]))

  return {
    gameId: 'g1',
    playMode: 'hotseat',
    status: 'completed',
    turn: 5,
    activePlayerId: null,
    roundPhase: 'selectCards',
    chosenCardIdByPlayerId: { p1: null, p2: null },
    pendingPlayerIds: [],
    resolvedUnitIdsThisTurn: [],
    unitsCreatedThisTurn: [],
    turnOrder: ['p1', 'p2'],
    board: createEmptyBoard('hex'),
    players: [p1, p2],
    units: [unitAt('p1', 'city')],
    cards,
    resourceBank: { gold: 100, wood: 100, stone: 100 },
    activeTaleIds: [],
    gameLength: Infinity,
    winnerPlayerIds: ['p1'],
    claimedByAchievementId: { 'city-mastery': 'p1' },
    achievementsClaimedThisRound: 0,
    boardSetup: null,
    idSequence: 0,
    actionHistory: [],
  }
}

const content: AchievementContent = {
  ...EMPTY_ACHIEVEMENT_CONTENT,
  achievementVictoryPoints: { 'city-mastery': 3 },
  unitBoardCountVP: { city: [1] },
  goldPerVictoryPoint: 2,
}

describe('EndGameView', () => {
  it('shows every player, ranked by total VP descending, with the breakdown table pivoted one row per scoring criterion', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    const { container } = render(<EndGameView state={state} players={players} achievementContent={content} taleContent={EMPTY_TALE_CONTENT} />)

    // p1 (Alice): City (3) + 1 City board-count (1) + 4 Gold (2) = 6.
    // Real content/achievements.json's display name for 'city-mastery' is
    // "City" — EndGameView resolves the id to a name via the real
    // listAchievements(), independent of the test's own achievementContent.
    // Each row is the same criterion for every player's column: the achievement
    // row ("city-mastery") and the board-count row (kind "city") are separate
    // rows, in separate category groups, even though both happen to be
    // labeled "City".
    expect(screen.getByTestId('breakdown-group-Achievements')).toHaveTextContent('Achievements')
    expect(screen.getByTestId('breakdown-cell-Achievements-city-mastery-p1')).toHaveTextContent('3 points')
    // p2 (Bob) never claimed it — blank, not a stray value.
    expect(screen.getByTestId('breakdown-cell-Achievements-city-mastery-p2')).toHaveTextContent('—')

    expect(screen.getByTestId('breakdown-cell-Units-city-p1')).toHaveTextContent('1 point')
    expect(screen.getByTestId('breakdown-cell-Units-city-p1')).toHaveTextContent('1 on board')

    expect(screen.getByTestId('breakdown-cell-Gold-gold-p1')).toHaveTextContent('2 points')
    expect(screen.getByTestId('breakdown-cell-Gold-gold-p1')).toHaveTextContent('4 gold')

    expect(screen.getByTestId('breakdown-points-p1')).toHaveTextContent('6 points')

    // Ranked highest total first: Alice's column comes before Bob's.
    const headers = [...container.querySelectorAll('[data-testid="score-breakdown"] th')]
    const aliceIndex = headers.findIndex((h) => h.textContent?.includes('Alice'))
    const bobIndex = headers.findIndex((h) => h.textContent?.includes('Bob'))
    expect(aliceIndex).toBeGreaterThanOrEqual(0)
    expect(aliceIndex).toBeLessThan(bobIndex)

    expect(screen.getByText('Winner:', { exact: false })).toBeInTheDocument()
  })

  it('shows a single "Breakdown" fallback row when nobody scored anything', () => {
    const state = { ...makeState(), claimedByAchievementId: {}, units: [] }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const noGoldContent: AchievementContent = { ...content, goldPerVictoryPoint: null }
    const noGoldState = { ...state, players: state.players.map((p) => ({ ...p, resources: { ...p.resources, gold: 0 } })) }

    render(<EndGameView state={noGoldState} players={players} achievementContent={noGoldContent} taleContent={EMPTY_TALE_CONTENT} />)

    expect(screen.queryByTestId('breakdown-group-Achievements')).not.toBeInTheDocument()
    expect(screen.getAllByText('No points scored')).toHaveLength(2)
  })

  it('pluralizes an achievement quantity correctly (e.g. board-count "2 on board")', () => {
    const state = { ...makeState(), units: [...makeState().units, unitAt('p1', 'city')] }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const twoCityContent: AchievementContent = { ...content, unitBoardCountVP: { city: [1, 2] } }

    render(<EndGameView state={state} players={players} achievementContent={twoCityContent} taleContent={EMPTY_TALE_CONTENT} />)

    expect(screen.getByTestId('breakdown-cell-Units-city-p1')).toHaveTextContent('2 on board')
  })

  it("highlights the winner(s) with a trophy, even ranked below someone eliminated", () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(<EndGameView state={state} players={players} achievementContent={content} taleContent={EMPTY_TALE_CONTENT} />)

    const breakdown = within(screen.getByTestId('score-breakdown'))
    const winnerHeader = breakdown.getByText('Alice').closest('th')
    expect(winnerHeader).toHaveTextContent('🏆')

    const loserHeader = breakdown.getByText('Bob').closest('th')
    expect(loserHeader).not.toHaveTextContent('🏆')
  })

  it('lists every player tied for the win when winnerPlayerIds has more than one id', () => {
    const state = { ...makeState(), winnerPlayerIds: ['p1', 'p2'] }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(<EndGameView state={state} players={players} achievementContent={content} taleContent={EMPTY_TALE_CONTENT} />)

    expect(screen.getByText('Winners:', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/Alice, Bob/)).toBeInTheDocument()
  })

  it("scores a Tale controllable structure (e.g. The Cathedral) for whoever controls it, itemized by name", () => {
    const state = { ...makeState(), units: [...makeState().units, unitAt('p2', 'cathedral')] }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const taleContent = { ...EMPTY_TALE_CONTENT, controllableStructures: [{ kind: 'cathedral', name: 'The Cathedral', victoryPoints: 15 }] }

    render(<EndGameView state={state} players={players} achievementContent={content} taleContent={taleContent} />)

    // p2 (Bob) scored nothing without the Cathedral; now scores exactly its 15 VP.
    expect(screen.getByTestId('breakdown-row-Structures-cathedral')).toHaveTextContent('The Cathedral')
    expect(screen.getByTestId('breakdown-cell-Structures-cathedral-p2')).toHaveTextContent('15 points')
    expect(screen.getByTestId('breakdown-points-p2')).toHaveTextContent('15 points')
  })

  it('shows each player their final position, ranked by total VP', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(<EndGameView state={state} players={players} achievementContent={content} taleContent={EMPTY_TALE_CONTENT} />)

    expect(screen.getByTestId('breakdown-place-p1')).toHaveTextContent('1st')
    expect(screen.getByTestId('breakdown-place-p2')).toHaveTextContent('2nd')
  })

  it('gives tied players the same place, and skips ahead by the number tied above for whoever is next', () => {
    const state = makeState()
    // 12 gold at goldPerVictoryPoint: 2 -> 6 VP, matching Alice's City (3) + 1 City board-count (1) + 4 Gold (2) = 6 total.
    const p3 = makeEnginePlayer('p3', 12)
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff'), makePlayerRow('p3', 'Carol', '#00ff00')]
    const tiedState: GameState = { ...state, players: [...state.players, p3], turnOrder: ['p1', 'p2', 'p3'] }

    render(<EndGameView state={tiedState} players={players} achievementContent={content} taleContent={EMPTY_TALE_CONTENT} />)

    // Alice and Carol both scored 6 (Alice via achievement+board+gold, Carol via gold alone) -> tied for 1st; Bob (0) is 3rd, not 2nd.
    expect(screen.getByTestId('breakdown-place-p1')).toHaveTextContent('1st')
    expect(screen.getByTestId('breakdown-place-p3')).toHaveTextContent('1st')
    expect(screen.getByTestId('breakdown-place-p2')).toHaveTextContent('3rd')
  })

  it("shows each player's resources and on-board unit counts, and the final board", () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    render(<EndGameView state={state} players={players} achievementContent={content} taleContent={EMPTY_TALE_CONTENT} />)

    expect(screen.getByText('Final board')).toBeInTheDocument()

    expect(screen.getByTestId('breakdown-resources-p1')).toHaveTextContent('4 Gold, 0 Wood, 0 Stone')
    expect(screen.getByTestId('breakdown-units-p1')).not.toHaveTextContent('—')

    expect(screen.getByTestId('breakdown-resources-p2')).toHaveTextContent('0 Gold, 0 Wood, 0 Stone')
    expect(screen.getByTestId('breakdown-units-p2')).toHaveTextContent('—')
  })

  it('shows a "Final score" ranked summary and a "Score categories" comparison table, dropping any category nobody scored', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    const { container } = render(<EndGameView state={state} players={players} achievementContent={content} taleContent={EMPTY_TALE_CONTENT} />)

    expect(screen.getByText('Final score')).toBeInTheDocument()
    // Alice: City achievement (3) + 1 City board-count (1) + 4 Gold at 2/VP (2) = 6; Bob: 0.
    expect(screen.getByText('6 pts')).toBeInTheDocument()
    expect(screen.getByText('0 pts')).toBeInTheDocument()

    // The visible comparison table, not ScoreCategoryChart's own sr-only table-view fallback for the same data.
    const categoriesTable = container.querySelector('[data-testid="score-categories"] table:not(.sr-only)')
    expect(categoriesTable).toHaveTextContent('Gold')
    expect(categoriesTable).toHaveTextContent('Units')
    expect(categoriesTable).toHaveTextContent('Achievements')
    // Nobody controls a terrain-majority region on this synthetic board — the row is dropped rather than shown all-zero.
    expect(categoriesTable).not.toHaveTextContent('Terrain')
  })

  it('omits the "Score categories" section entirely when every category is scoreless', () => {
    const state = { ...makeState(), claimedByAchievementId: {}, units: [] }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]
    const noGoldContent: AchievementContent = { ...content, goldPerVictoryPoint: null }
    const noGoldState = { ...state, players: state.players.map((p) => ({ ...p, resources: { ...p.resources, gold: 0 } })) }

    render(<EndGameView state={noGoldState} players={players} achievementContent={noGoldContent} taleContent={EMPTY_TALE_CONTENT} />)

    expect(screen.queryByText('Score categories')).not.toBeInTheDocument()
  })

  it('shows "Eliminated" instead of a score breakdown for an eliminated player, in every place a breakdown appears, and hides their score entirely rather than a stale pre-elimination number', () => {
    const state = makeState()
    // p2 kept the "temple-mastery" achievement they claimed before being eliminated — achievements
    // aren't revoked on elimination (see elimination.ts) — so their raw VP total is still 20, not 0.
    const eliminatedContent: AchievementContent = { ...content, achievementVictoryPoints: { ...content.achievementVictoryPoints, 'temple-mastery': 20 } }
    const eliminatedState: GameState = {
      ...state,
      claimedByAchievementId: { ...state.claimedByAchievementId, 'temple-mastery': 'p2' },
      players: state.players.map((p) => (p.id === 'p2' ? { ...p, eliminated: true } : p)),
    }
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    const { container } = render(<EndGameView state={eliminatedState} players={players} achievementContent={eliminatedContent} taleContent={EMPTY_TALE_CONTENT} />)

    // Final score summary flags Bob eliminated and shows "—" instead of his leftover 20-point total.
    const finalScore = screen.getByText('Final score').closest('div') as HTMLElement
    const bobRow = within(finalScore).getByText('Bob').closest('li') as HTMLElement
    expect(bobRow).toHaveTextContent('(eliminated)')
    expect(bobRow).toHaveTextContent('—')
    expect(within(finalScore).queryByText(/20 pts/)).not.toBeInTheDocument()

    // Score categories: Bob's per-category cells and the Total row are hidden, not real (leftover) numbers.
    const categoriesTable = container.querySelector('[data-testid="score-categories"] table:not(.sr-only)') as HTMLElement
    expect(categoriesTable).toHaveTextContent('Bob')
    expect(categoriesTable).toHaveTextContent('(eliminated)')
    const totalRow = within(categoriesTable).getByText('Total').closest('tr') as HTMLElement
    expect(totalRow).toHaveTextContent('—')
    expect(totalRow).not.toHaveTextContent('20')

    // The bar chart (rendered in the same "Score categories" section) drops Bob's bar/legend entry entirely.
    const chartSvg = container.querySelector('[data-testid="score-categories"] svg')
    expect(chartSvg?.textContent).not.toContain('Bob')

    // Score breakdown: Bob's Points/Resources/On board cells say "Eliminated" instead of the misleading leftover detail,
    // and his claimed-before-elimination "temple-mastery" achievement never becomes a pivoted row at all — an eliminated
    // player's leftover VP source shouldn't resurrect a category nobody currently active scored in.
    expect(screen.getByTestId('breakdown-points-p2')).toHaveTextContent('Eliminated')
    expect(screen.queryByTestId('breakdown-row-Achievements-temple-mastery')).not.toBeInTheDocument()
    expect(screen.getByTestId('breakdown-resources-p2')).toHaveTextContent('Eliminated')
    expect(screen.getByTestId('breakdown-units-p2')).toHaveTextContent('Eliminated')

    // Alice (not eliminated) is unaffected.
    expect(screen.getByTestId('breakdown-points-p1')).toHaveTextContent('6 points')
    expect(screen.getByTestId('breakdown-cell-Achievements-city-mastery-p1')).toHaveTextContent('3 points')
    expect(screen.getByTestId('breakdown-resources-p1')).toHaveTextContent('4 Gold, 0 Wood, 0 Stone')
  })

  it('renders the "Total score over time" chart once scoreHistory has at least two points, and omits it otherwise', () => {
    const state = makeState()
    const players = [makePlayerRow('p1', 'Alice', '#ff0000'), makePlayerRow('p2', 'Bob', '#0000ff')]

    const { rerender } = render(<EndGameView state={state} players={players} achievementContent={content} taleContent={EMPTY_TALE_CONTENT} />)
    expect(screen.queryByText('Total score over time')).not.toBeInTheDocument()

    rerender(
      <EndGameView
        state={state}
        players={players}
        achievementContent={content}
        taleContent={EMPTY_TALE_CONTENT}
        scoreHistory={[
          { turn: 0, totalByPlayerId: { p1: 0, p2: 0 } },
          { turn: 1, totalByPlayerId: { p1: 6, p2: 0 } },
        ]}
      />,
    )
    expect(screen.getByText('Total score over time')).toBeInTheDocument()
  })
})

// Decides whether the running build should announce which backend it is
// talking to, and what to say.
//
// The app is configured entirely at build time (`src/lib/supabase.ts` reads
// `VITE_SUPABASE_URL` out of the bundle), so a deployment looks identical
// whichever Supabase project it points at — there is nothing on screen, and
// nothing short of reading the built JavaScript, that distinguishes
// pre-production from production. That ambiguity has already caused real
// mistakes: see DELIVERY_PIPELINE_PLAN.md §8 on an environment deploying to
// the wrong project because nothing said otherwise.
//
// So: `VITE_ENVIRONMENT` is set ONLY on non-production builds (Vercel's
// Preview scope). Production leaves it unset and therefore renders nothing —
// the safe state is the one that needs no configuration, rather than one
// that depends on remembering to set a variable correctly.
//
// The Supabase project ref alone turned out not to be enough to tell builds
// apart: every Preview deployment — `main`'s and every `claude/*` branch's —
// points at the same Preview project, so the badge read identically on all
// of them. That cost real time on 2026-09-09 (issue #496): a checkbox looked
// absent because the page was an older branch's preview, not `main`'s. So the
// badge also names the git branch and short commit it was built from, read
// from `__GIT_COMMIT_REF__`/`__GIT_COMMIT_SHA__` (injected by
// `vite.config.ts` from Vercel's `VERCEL_GIT_COMMIT_REF`/`VERCEL_GIT_COMMIT_SHA`
// build-time env — see that file). Those are empty outside Vercel, in which
// case the badge just omits them rather than showing something misleading.

export interface EnvironmentBadgeInfo {
  /** What to call this environment, e.g. "Preview". */
  label: string
  /** The Supabase project the build talks to, parsed out of its URL — null if that URL isn't the usual hosted shape. */
  projectRef: string | null
  /** The git branch this build was made from — null if unknown (e.g. built outside Vercel). */
  branch: string | null
  /** The first 7 characters of the git commit this build was made from — null if unknown. */
  commit: string | null
}

/** `https://abcdefgh.supabase.co` -> `abcdefgh`; null for a self-hosted or malformed URL. */
function supabaseProjectRef(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null
  const match = /^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i.exec(supabaseUrl.trim())
  return match ? match[1] : null
}

/**
 * The badge to show, or null to show none.
 *
 * Null whenever `environment` is unset — which is how production is
 * identified, since it is the only build that sets nothing — and also when it
 * says "production" outright, so that a misconfigured production build still
 * stays quiet rather than labelling itself. This gate is independent of
 * `gitCommitRef`/`gitCommitSha`, which Vercel populates on every deployment
 * including production ones — so a production build stays quiet even though
 * those two are non-empty for it too.
 */
export function resolveEnvironmentBadge(
  environment: string | undefined,
  supabaseUrl: string | undefined,
  gitCommitRef: string | undefined,
  gitCommitSha: string | undefined,
): EnvironmentBadgeInfo | null {
  const label = environment?.trim() ?? ''
  if (label.length === 0 || label.toLowerCase() === 'production') return null
  const branch = gitCommitRef?.trim() || null
  const commit = gitCommitSha?.trim() ? gitCommitSha.trim().slice(0, 7) : null
  return { label, projectRef: supabaseProjectRef(supabaseUrl), branch, commit }
}

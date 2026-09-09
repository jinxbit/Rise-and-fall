import type { EnvironmentBadgeInfo } from './environmentBadge'

/**
 * A corner marker naming the environment this build talks to — shown only on
 * non-production builds (see ./environmentBadge.ts for how that is decided).
 *
 * `pointer-events-none` on purpose: this is something to glance at, never
 * something to click, and it must not be able to swallow a tap meant for the
 * board underneath it on a small screen.
 */
export function EnvironmentBadge({ label, projectRef, branch, commit }: EnvironmentBadgeInfo) {
  const ariaExtras = [
    branch ? `branch ${branch}` : null,
    commit ? `commit ${commit}` : null,
    projectRef ? `Supabase project ${projectRef}` : null,
  ].filter(Boolean)
  return (
    <div
      role="status"
      aria-label={`Environment: ${label}${ariaExtras.length ? `, ${ariaExtras.join(', ')}` : ''}`}
      className="pointer-events-none fixed bottom-2 left-2 z-50 select-none rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] leading-tight text-amber-300 backdrop-blur-sm"
    >
      <span className="font-semibold uppercase tracking-wide">{label}</span>
      {branch && <span className="ml-1.5 font-mono text-amber-400/80">{branch}</span>}
      {commit && <span className="ml-1.5 font-mono text-amber-400/80">{commit}</span>}
      {projectRef && <span className="ml-1.5 font-mono text-amber-400/80">{projectRef}</span>}
    </div>
  )
}

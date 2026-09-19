// Shared production/non-production detection, per the `VITE_ENVIRONMENT`
// convention: it is set ONLY on non-production builds (Vercel's Preview
// scope), so a build is production either when the variable is unset or
// when it says "production" outright. See src/components/environmentBadge.ts
// for the full reasoning and history (issue #496).

/** True when this build is production, by the `VITE_ENVIRONMENT` convention above. */
export function isProductionBuild(environment: string | undefined): boolean {
  const label = environment?.trim() ?? ''
  return label.length === 0 || label.toLowerCase() === 'production'
}

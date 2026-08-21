interface UpdateBannerProps {
  onReload: () => void
}

/** Prompts players to reload once a newer deployment is detected, so they update on their own terms instead of hitting a stale-build error (issue #247). */
export function UpdateBanner({ onReload }: UpdateBannerProps) {
  return (
    <div className="flex items-center justify-center gap-3 bg-sky-500/10 px-4 py-2 text-sm text-sky-300">
      <span>A new version is available.</span>
      <button
        type="button"
        onClick={onReload}
        className="rounded bg-sky-500/20 px-2 py-0.5 font-medium text-sky-200 hover:bg-sky-500/30"
      >
        Reload
      </button>
    </div>
  )
}

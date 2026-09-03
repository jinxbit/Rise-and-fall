/**
 * Always-available manual reload affordance, floating in the corner on every
 * page. Clicking a push notification can bring an already-open tab back to
 * the foreground without the visibilitychange-driven refetches (see
 * useRefetchOnVisible, useAppUpdateAvailable) reliably catching every case
 * (issue #405) — this gives players a guaranteed way to force a fresh load
 * instead of hunting for a way to re-navigate.
 */
export function RefreshButton() {
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      aria-label="Refresh page"
      title="Refresh page"
      className="fixed bottom-4 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800/90 text-neutral-300 shadow-lg backdrop-blur transition hover:bg-neutral-700 hover:text-neutral-100"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
        aria-hidden="true"
      >
        <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
    </button>
  )
}

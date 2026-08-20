import { useState } from 'react'

interface ErrorBannerProps {
  message: string
  onDismiss?: () => void
}

/** Standard error display used across the app: red banner with a copy-details and dismiss action. */
export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied or unavailable; nothing useful to do about it here.
    }
  }

  return (
    <div className="flex items-start gap-3 rounded-md bg-red-500/10 p-3 text-sm text-red-400">
      <span className="flex-1">{message}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="rounded px-1.5 py-0.5 text-xs text-red-300 hover:bg-red-500/20 hover:text-red-200"
        >
          {copied ? 'Copied!' : 'Copy details'}
        </button>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error"
            title="Dismiss"
            className="rounded px-1.5 py-0.5 leading-none text-red-300 hover:bg-red-500/20 hover:text-red-200"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}

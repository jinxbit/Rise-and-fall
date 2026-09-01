import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches errors thrown while rendering the app. Without this, React
 * unmounts the whole tree on an uncaught render error, leaving `#root`
 * empty — since the page has no background color set (only `color-scheme:
 * dark` in index.css), that reads as a plain black screen with no
 * indication anything went wrong.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled error in render tree:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 p-8 text-center text-neutral-100">
        <h1 className="text-xl font-semibold text-red-400">Something went wrong</h1>
        <p className="text-neutral-400">{error.message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border border-neutral-700 px-4 py-2 font-medium hover:border-neutral-500"
        >
          Reload
        </button>
      </div>
    )
  }
}

import { pageCount } from '../lib/pagination'

/** Prev/next controls for a client-paginated list (see lib/pagination.ts). Renders nothing once everything fits on one page. */
export function Pagination(props: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const count = pageCount(props.total, props.pageSize)
  if (count <= 1) return null

  return (
    <div className="flex items-center justify-between text-sm text-neutral-400">
      <button
        type="button"
        disabled={props.page <= 0}
        onClick={() => props.onChange(props.page - 1)}
        className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 disabled:opacity-30"
      >
        Previous
      </button>
      <span>
        Page {props.page + 1} of {count}
      </span>
      <button
        type="button"
        disabled={props.page >= count - 1}
        onClick={() => props.onChange(props.page + 1)}
        className="rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 disabled:opacity-30"
      >
        Next
      </button>
    </div>
  )
}

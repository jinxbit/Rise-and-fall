// Pure client-side pagination for the landing page's game lists
// (HomePage.tsx) — every list it shows is already fetched in full (small
// scale, same as listMyGames/listPublicRooms), so paging just slices an
// already-sorted array rather than adding offset/limit params to the query.

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize
  return items.slice(start, start + pageSize)
}

export function pageCount(totalItems: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalItems / pageSize))
}

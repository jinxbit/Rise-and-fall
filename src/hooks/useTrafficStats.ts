import { useEffect, useState } from 'react'
import { formatByteSize, getTrafficBytes, subscribeToTraffic } from '../lib/trafficTracker'

/** Formatted cumulative Supabase network traffic for the current session, updating live. */
export function useTrafficStats(): string {
  const [bytes, setBytes] = useState(getTrafficBytes)

  useEffect(() => subscribeToTraffic(setBytes), [])

  return formatByteSize(bytes)
}

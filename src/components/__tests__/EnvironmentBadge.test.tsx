import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EnvironmentBadge } from '../EnvironmentBadge'
import { resolveEnvironmentBadge } from '../environmentBadge'

describe('resolveEnvironmentBadge', () => {
  it('shows nothing when the environment is unset — which is how production identifies itself', () => {
    expect(resolveEnvironmentBadge(undefined, 'https://abcdefgh.supabase.co')).toBeNull()
    expect(resolveEnvironmentBadge('', 'https://abcdefgh.supabase.co')).toBeNull()
    expect(resolveEnvironmentBadge('   ', 'https://abcdefgh.supabase.co')).toBeNull()
  })

  it('stays quiet even if a production build sets the variable outright', () => {
    expect(resolveEnvironmentBadge('production', 'https://abcdefgh.supabase.co')).toBeNull()
    expect(resolveEnvironmentBadge('Production', 'https://abcdefgh.supabase.co')).toBeNull()
  })

  it('names the environment and the Supabase project it talks to', () => {
    expect(resolveEnvironmentBadge('Preview', 'https://abcdefgh.supabase.co')).toEqual({ label: 'Preview', projectRef: 'abcdefgh' })
    // A trailing slash is the same project.
    expect(resolveEnvironmentBadge('Preview', 'https://abcdefgh.supabase.co/')).toEqual({ label: 'Preview', projectRef: 'abcdefgh' })
  })

  it('still names the environment when the project ref cannot be parsed', () => {
    // A self-hosted or local URL — the environment is the important half, so
    // the badge appears either way rather than failing closed and hiding.
    expect(resolveEnvironmentBadge('Local', 'http://127.0.0.1:54321')).toEqual({ label: 'Local', projectRef: null })
    expect(resolveEnvironmentBadge('Preview', undefined)).toEqual({ label: 'Preview', projectRef: null })
  })
})

describe('EnvironmentBadge', () => {
  it('renders the environment and project ref', () => {
    render(<EnvironmentBadge label="Preview" projectRef="abcdefgh" />)
    expect(screen.getByText('Preview')).toBeInTheDocument()
    expect(screen.getByText('abcdefgh')).toBeInTheDocument()
  })

  it('renders just the environment when there is no project ref', () => {
    render(<EnvironmentBadge label="Preview" projectRef={null} />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Environment: Preview')
  })

  it('never intercepts a click meant for the page underneath', () => {
    render(<EnvironmentBadge label="Preview" projectRef="abcdefgh" />)
    expect(screen.getByRole('status').className).toContain('pointer-events-none')
  })
})

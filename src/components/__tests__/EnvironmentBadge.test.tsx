import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EnvironmentBadge } from '../EnvironmentBadge'
import { resolveEnvironmentBadge } from '../environmentBadge'

describe('resolveEnvironmentBadge', () => {
  it('shows nothing when the environment is unset — which is how production identifies itself', () => {
    expect(resolveEnvironmentBadge(undefined, 'https://abcdefgh.supabase.co', 'main', 'ba78a43abc')).toBeNull()
    expect(resolveEnvironmentBadge('', 'https://abcdefgh.supabase.co', 'main', 'ba78a43abc')).toBeNull()
    expect(resolveEnvironmentBadge('   ', 'https://abcdefgh.supabase.co', 'main', 'ba78a43abc')).toBeNull()
  })

  it('stays quiet even if a production build sets the variable outright', () => {
    expect(resolveEnvironmentBadge('production', 'https://abcdefgh.supabase.co', 'production', 'ba78a43abc')).toBeNull()
    expect(resolveEnvironmentBadge('Production', 'https://abcdefgh.supabase.co', 'production', 'ba78a43abc')).toBeNull()
  })

  it('names the environment and the Supabase project it talks to', () => {
    expect(resolveEnvironmentBadge('Preview', 'https://abcdefgh.supabase.co', undefined, undefined)).toEqual({
      label: 'Preview',
      projectRef: 'abcdefgh',
      branch: null,
      commit: null,
    })
    // A trailing slash is the same project.
    expect(resolveEnvironmentBadge('Preview', 'https://abcdefgh.supabase.co/', undefined, undefined)).toEqual({
      label: 'Preview',
      projectRef: 'abcdefgh',
      branch: null,
      commit: null,
    })
  })

  it('still names the environment when the project ref cannot be parsed', () => {
    // A self-hosted or local URL — the environment is the important half, so
    // the badge appears either way rather than failing closed and hiding.
    expect(resolveEnvironmentBadge('Local', 'http://127.0.0.1:54321', undefined, undefined)).toEqual({
      label: 'Local',
      projectRef: null,
      branch: null,
      commit: null,
    })
    expect(resolveEnvironmentBadge('Preview', undefined, undefined, undefined)).toEqual({
      label: 'Preview',
      projectRef: null,
      branch: null,
      commit: null,
    })
  })

  it('names the branch and shortened commit when the build carries them', () => {
    expect(resolveEnvironmentBadge('Preview', 'https://abcdefgh.supabase.co', 'main', 'ba78a43abc123')).toEqual({
      label: 'Preview',
      projectRef: 'abcdefgh',
      branch: 'main',
      commit: 'ba78a43',
    })
    expect(resolveEnvironmentBadge('Preview', 'https://abcdefgh.supabase.co', 'claude/issue-496', 'ba78a43')).toEqual({
      label: 'Preview',
      projectRef: 'abcdefgh',
      branch: 'claude/issue-496',
      commit: 'ba78a43',
    })
  })

  it('treats an empty branch or commit the same as missing', () => {
    expect(resolveEnvironmentBadge('Preview', 'https://abcdefgh.supabase.co', '', '')).toEqual({
      label: 'Preview',
      projectRef: 'abcdefgh',
      branch: null,
      commit: null,
    })
  })
})

describe('EnvironmentBadge', () => {
  it('renders the environment, branch, commit, and project ref', () => {
    render(<EnvironmentBadge label="Preview" projectRef="abcdefgh" branch="main" commit="ba78a43" />)
    expect(screen.getByText('Preview')).toBeInTheDocument()
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('ba78a43')).toBeInTheDocument()
    expect(screen.getByText('abcdefgh')).toBeInTheDocument()
  })

  it('renders just the environment when nothing else is known', () => {
    render(<EnvironmentBadge label="Preview" projectRef={null} branch={null} commit={null} />)
    expect(screen.getByRole('status')).toHaveAccessibleName('Environment: Preview')
  })

  it('never intercepts a click meant for the page underneath', () => {
    render(<EnvironmentBadge label="Preview" projectRef="abcdefgh" branch="main" commit="ba78a43" />)
    expect(screen.getByRole('status').className).toContain('pointer-events-none')
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../UpdateBanner'

describe('UpdateBanner', () => {
  it('renders the update message', () => {
    render(<UpdateBanner onReload={vi.fn()} />)
    expect(screen.getByText('A new version is available.')).toBeInTheDocument()
  })

  it('calls onReload when the reload button is clicked', () => {
    const onReload = vi.fn()
    render(<UpdateBanner onReload={onReload} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledOnce()
  })
})

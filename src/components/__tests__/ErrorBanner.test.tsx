import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorBanner } from '../ErrorBanner'

describe('ErrorBanner', () => {
  it('renders the error message', () => {
    render(<ErrorBanner message="Something went wrong" />)
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn()
    render(<ErrorBanner message="Something went wrong" onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('does not render a dismiss button when onDismiss is not provided', () => {
    render(<ErrorBanner message="Something went wrong" />)
    expect(screen.queryByRole('button', { name: 'Dismiss error' })).not.toBeInTheDocument()
  })

  it('copies the message to the clipboard when copy details is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(<ErrorBanner message="Something went wrong" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }))

    expect(writeText).toHaveBeenCalledWith('Something went wrong')
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument()
  })
})

// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { ShieldX } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorNotice } from './error-notice'

describe('ErrorNotice', () => {
  afterEach(cleanup)

  it('renders only the sections whose props are provided', () => {
    render(<ErrorNotice title="Something broke" />)

    expect(screen.getByText('Something broke')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders every section and wires the callbacks', () => {
    const onQuit = vi.fn()
    const onRetry = vi.fn()
    const onIssue = vi.fn()

    render(
      <ErrorNotice
        icon={ShieldX}
        tone="red"
        title="Broken"
        description="More detail"
        errorCode="some_code · 0009_migration"
        help={{
          whyLabel: 'Why this happened',
          why: 'Because reasons',
          howLabel: 'How to fix',
          how: 'Fix it this way'
        }}
        issueLink={{ label: 'Get help', tooltip: 'Opens a pre-filled draft', onClick: onIssue }}
        secondaryButton={{ label: 'Quit', onClick: onQuit }}
        primaryButton={{ label: 'Retry', onClick: onRetry, disabled: true }}
      />
    )

    expect(screen.getByText('Broken')).toBeTruthy()
    expect(screen.getByText('More detail')).toBeTruthy()
    expect(screen.getByText('some_code · 0009_migration')).toBeTruthy()
    expect(screen.getByText('Why this happened')).toBeTruthy()
    expect(screen.getByText('Because reasons')).toBeTruthy()
    expect(screen.getByText('How to fix')).toBeTruthy()
    expect(screen.getByText('Fix it this way')).toBeTruthy()

    screen.getByRole('button', { name: 'Quit' }).click()
    expect(onQuit).toHaveBeenCalledOnce()

    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry).toHaveProperty('disabled', true)
    retry.click()
    expect(onRetry).not.toHaveBeenCalled()

    screen.getByRole('button', { name: /Get help/ }).click()
    expect(onIssue).toHaveBeenCalledOnce()
  })

  it('renders either button on its own', () => {
    render(<ErrorNotice title="t" primaryButton={{ label: 'Retry', onClick: () => undefined }} />)

    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Quit' })).toBeNull()
  })

  it('shows a spinner and blocks clicks while a button is loading', () => {
    const onRetry = vi.fn()
    const { container } = render(
      <ErrorNotice
        title="t"
        primaryButton={{ label: 'Retrying…', onClick: onRetry, loading: true }}
      />
    )

    const retry = screen.getByRole('button', { name: /Retrying/ })
    expect(retry).toHaveProperty('disabled', true)
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(retry.getAttribute('aria-busy')).toBe('true')
    retry.click()
    expect(onRetry).not.toHaveBeenCalled()
  })
})

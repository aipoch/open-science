// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { ShieldX } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorNotice } from './error-notice'

describe.each([false, true])('ErrorNotice (fullPage: %s)', (fullPage) => {
  afterEach(cleanup)

  it('renders only the sections whose props are provided', () => {
    render(<ErrorNotice fullPage={fullPage} title="Something broke" />)

    expect(
      screen.getByRole('heading', { name: 'Something broke', level: fullPage ? 1 : 2 })
    ).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders every section and wires the callbacks', () => {
    const onQuit = vi.fn()
    const onRetry = vi.fn()
    const onIssue = vi.fn()

    render(
      <ErrorNotice
        fullPage={fullPage}
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
    render(
      <ErrorNotice
        fullPage={fullPage}
        title="t"
        primaryButton={{ label: 'Retry', onClick: () => undefined }}
      />
    )

    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Quit' })).toBeNull()
  })

  it('shows a spinner and blocks clicks while a button is loading', () => {
    const onRetry = vi.fn()
    const { container } = render(
      <ErrorNotice
        fullPage={fullPage}
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

describe('contextual notice content', () => {
  afterEach(cleanup)

  it('keeps diagnostics collapsed and outside the alert while recovery stays available', () => {
    render(
      <ErrorNotice
        role="alert"
        title="Version check failed"
        errorCode="version_mismatch"
        diagnosticsLabel="Diagnostics"
        primaryButton={{ label: 'Retry', onClick: vi.fn() }}
      />
    )
    const diagnostics = screen.getByText('Diagnostics').closest('details')!
    expect(diagnostics).not.toBeNull()
    expect(diagnostics.open).toBe(false)
    expect(screen.getByText('version_mismatch').closest('[role="alert"]')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Version check failed')
    expect(screen.getByRole('button', { name: 'Retry' }).closest('details')).toBeNull()
  })

  it('associates each recovery choice with its consequence and renders owner content', () => {
    render(
      <ErrorNotice
        title="Tag version updated"
        primaryButton={{
          label: 'Continue editing draft',
          description: 'Save later to replace the latest version.',
          onClick: vi.fn()
        }}
        secondaryButton={{
          label: 'Load latest version',
          description: 'Replace the current draft.',
          onClick: vi.fn()
        }}
      >
        <p>Latest saved version: Research</p>
      </ErrorNotice>
    )
    expect(screen.getByText('Latest saved version: Research')).toBeTruthy()
    for (const [name, description] of [
      ['Continue editing draft', 'Save later to replace the latest version.'],
      ['Load latest version', 'Replace the current draft.']
    ]) {
      const button = screen.getByRole('button', { name })
      expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(
        description
      )
    }
  })
})

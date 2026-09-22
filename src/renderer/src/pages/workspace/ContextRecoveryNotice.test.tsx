// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ContextRecoveryNotice } from './ContextRecoveryNotice'
import { recoveryStateForDisplay } from './context-recovery-presentation'

afterEach(cleanup)

it('offers recovery for a legacy failure and contains transport failures', async () => {
  const onRecover = vi.fn().mockRejectedValue(new Error('Transport unavailable'))
  render(<ContextRecoveryNotice onRecover={onRecover} />)
  fireEvent.click(screen.getByRole('button', { name: 'Recover session' }))
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Transport unavailable')
  )
  expect(onRecover).toHaveBeenCalledOnce()
})

it('projects Main recovery progress without dispatching a second recovery', () => {
  const onRecover = vi.fn()
  render(<ContextRecoveryNotice state={{ phase: 'replacing' }} onRecover={onRecover} />)
  expect(screen.getByRole('status').textContent).toContain('Recovering session…')
  fireEvent.click(screen.getByRole('button', { name: 'Recover session' }))
  expect(onRecover).not.toHaveBeenCalled()
})

it('shows an actionable blocking reason without a blind retry', () => {
  render(
    <ContextRecoveryNotice
      state={{ phase: 'blocked', reason: 'Check the interrupted write before continuing.' }}
      onRecover={vi.fn()}
    />
  )
  expect(screen.getByRole('alert').textContent).toContain('Check the interrupted write')
  expect(screen.queryByRole('button', { name: 'Recover session' })).toBeNull()
})

it('allows explicit recovery after a safe interrupted preparation', async () => {
  const onRecover = vi.fn().mockResolvedValue(undefined)
  render(
    <ContextRecoveryNotice state={{ phase: 'blocked', canRetry: true }} onRecover={onRecover} />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Recover session' }))
  await waitFor(() => expect(onRecover).toHaveBeenCalledOnce())
})

const reasons = { interrupted: 'Interrupted', unknownOutcome: 'Check results' }
it('projects persisted interrupted recovery without pretending it is still running', () => {
  expect(recoveryStateForDisplay(undefined, { phase: 'replacing' }, reasons)).toEqual({
    phase: 'blocked',
    canRetry: true,
    reason: 'Interrupted'
  })
  expect(recoveryStateForDisplay(undefined, { phase: 'continuing' }, reasons)).toEqual({
    phase: 'blocked',
    canRetry: false,
    reason: 'Check results'
  })
})
it('prefers live recovery and preserves settled persisted states', () => {
  const live = { phase: 'replacing' as const }
  expect(recoveryStateForDisplay(live, { phase: 'continuing' }, reasons)).toBe(live)
  expect(recoveryStateForDisplay(undefined, { phase: 'ready' }, reasons)).toEqual({
    phase: 'ready'
  })
})

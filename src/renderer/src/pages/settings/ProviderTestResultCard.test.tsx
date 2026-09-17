// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ProviderTestResultCard } from './ProviderTestResultCard'

afterEach(cleanup)

it('presents a successful test with the shared success semantics from the settings design', () => {
  render(<ProviderTestResultCard result={{ ok: true, category: 'ok' }} />)
  const status = screen.getByRole('status')
  expect(status.textContent).toContain('Connection succeeded.')
  expect(status.querySelector('.bg-status-success-surface')).not.toBeNull()
  expect(status.querySelector('.dark\\:bg-status-success-dark-surface')).not.toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps rejection diagnostics in the expandable warning surface', () => {
  render(<ProviderTestResultCard result={{ ok: false, category: 'auth', status: 403 }} />)
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toContain('Connection test failed.')
  expect(alert.querySelector('.bg-status-warning-surface')).not.toBeNull()
  expect(alert.querySelector('details')?.open).toBe(false)
  expect(alert.textContent).toContain('403')
})

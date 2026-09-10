// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApplicationErrorBoundary } from './application-error-boundary'
import { NotificationErrorBoundary } from './NotificationErrorBoundary'

const BrokenView = (): never => {
  throw new TypeError('private research content and secret-token')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('reports only a projected failure and keeps private error content out of the recovery page', () => {
  const reportRendererFailure = vi.fn()
  const quit = vi.fn()
  window.api = {
    diagnostics: { reportRendererFailure },
    databaseStartup: { quit }
  } as unknown as Window['api']
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(
    <ApplicationErrorBoundary>
      <BrokenView />
    </ApplicationErrorBoundary>
  )
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy()
  expect(document.body.textContent).not.toContain('secret-token')
  expect(reportRendererFailure).toHaveBeenCalledOnce()
  expect(reportRendererFailure).toHaveBeenCalledWith({
    source: 'handled-error',
    surface: 'unknown',
    errorCategory: 'type',
    fingerprint: expect.stringMatching(/^[a-f0-9]{8}$/)
  })
  expect(quit).not.toHaveBeenCalled()
})

it('keeps recovery visible when reporting the failure throws', () => {
  window.api = {
    diagnostics: {
      reportRendererFailure: () => {
        throw new Error('bridge unavailable')
      }
    }
  } as unknown as Window['api']
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() =>
    render(
      <ApplicationErrorBoundary>
        <BrokenView />
      </ApplicationErrorBoundary>
    )
  ).not.toThrow()
  expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy()
})

it('leaves a locally contained notification failure within its existing boundary', () => {
  window.api = {} as Window['api']
  vi.spyOn(console, 'error').mockImplementation(() => {})
  render(
    <ApplicationErrorBoundary>
      <div>Application content</div>
      <NotificationErrorBoundary>
        <BrokenView />
      </NotificationErrorBoundary>
    </ApplicationErrorBoundary>
  )
  expect(screen.getByText('Application content')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Reload page' })).toBeNull()
})

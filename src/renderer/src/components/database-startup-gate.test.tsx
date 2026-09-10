// @vitest-environment jsdom

import { StrictMode } from 'react'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import type { DatabaseStartupState } from '../../../shared/database-startup'
import { DatabaseStartupGate } from './database-startup-gate'

describe('DatabaseStartupGate', () => {
  let publish: (state: DatabaseStartupState) => void
  const getState = vi.fn<() => Promise<DatabaseStartupState>>()
  const retry = vi.fn<() => Promise<DatabaseStartupState>>()
  const quit = vi.fn<() => Promise<void>>()

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await i18next.changeLanguage('en')
  })

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    getState.mockReset().mockResolvedValue({ phase: 'checking' })
    retry.mockReset()
    quit.mockReset().mockResolvedValue()
    window.api = {
      databaseStartup: {
        getState,
        retry,
        quit,
        onStateChanged: (listener: (state: DatabaseStartupState) => void) => {
          publish = listener
          return () => undefined
        }
      }
    } as unknown as Window['api']
  })

  it('keeps the ready application mounted after a delayed retry snapshot', async () => {
    let resolveRetry!: (state: DatabaseStartupState) => void
    retry.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve
        })
    )
    await act(async () => {
      render(
        <DatabaseStartupGate>
          <div>Business application</div>
        </DatabaseStartupGate>
      )
    })
    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_open_failed',
          message: 'Open Science could not open its database.',
          retryable: true
        }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    act(() => publish({ phase: 'ready' }))
    const application = screen.getByText('Business application')
    await act(async () => resolveRetry({ phase: 'starting' }))
    expect(screen.queryByText('Business application')).toBe(application)
    expect(screen.queryByText('Starting Open Science…')).toBeNull()
  })

  it.each(['ready', 'blocked'] as const)(
    'keeps a newer %s event when retry rejects',
    async (phase) => {
      let rejectRetry!: (error: Error) => void
      retry.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectRetry = reject
          })
      )
      await act(async () => {
        render(
          <DatabaseStartupGate>
            <div>Business application</div>
          </DatabaseStartupGate>
        )
      })
      const blocked: DatabaseStartupState = {
        phase: 'blocked',
        error: {
          code: 'database_open_failed',
          message: 'Open Science could not open its database.',
          retryable: true
        }
      }
      act(() => publish(blocked))
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      act(() => publish(phase === 'ready' ? { phase } : blocked))
      await act(async () => rejectRetry(new Error('late failure')))
      expect(screen.queryByText('Open Science could not finish checking its database.')).toBeNull()
      expect(
        screen.getByText(phase === 'ready' ? 'Business application' : blocked.error.message)
      ).toBeTruthy()
    }
  )

  it('keeps a newer blocked event when a retry returns an older starting state', async () => {
    let resolveRetry!: (state: DatabaseStartupState) => void
    retry.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve
        })
    )
    await act(async () => {
      render(
        <DatabaseStartupGate>
          <div>Business application</div>
        </DatabaseStartupGate>
      )
    })
    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_open_failed',
          message: 'Open Science could not open its database.',
          retryable: true
        }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_newer_than_app',
          message: 'A newer app is required.',
          retryable: false
        }
      })
    )
    await act(async () => resolveRetry({ phase: 'starting' }))
    expect(screen.getByText('A newer app is required.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('accepts a retry snapshot before ready and ignores events after unmount', async () => {
    let resolveRetry!: (state: DatabaseStartupState) => void
    retry.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve
        })
    )
    const view = render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )
    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_open_failed',
          message: 'Open Science could not open its database.',
          retryable: true
        }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => resolveRetry({ phase: 'starting' }))
    expect(screen.getByText('Starting Open Science…')).toBeTruthy()
    act(() => publish({ phase: 'ready' }))
    expect(screen.getByText('Business application')).toBeTruthy()
    view.unmount()
    act(() => publish({ phase: 'starting' }))
    expect(screen.queryByText('Starting Open Science…')).toBeNull()
  })

  it('ignores a retry from an unmounted StrictMode gate after a new gate is ready', async () => {
    let resolveRetry!: (state: DatabaseStartupState) => void
    retry.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve
        })
    )
    const view = render(
      <StrictMode>
        <DatabaseStartupGate>
          <div>Old application</div>
        </DatabaseStartupGate>
      </StrictMode>
    )
    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_open_failed',
          message: 'Open Science could not open its database.',
          retryable: true
        }
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    view.unmount()
    getState.mockResolvedValue({ phase: 'ready' })
    await act(async () => {
      render(
        <StrictMode>
          <DatabaseStartupGate>
            <div>New application</div>
          </DatabaseStartupGate>
        </StrictMode>
      )
    })
    const application = screen.getByText('New application')
    await act(async () => resolveRetry({ phase: 'starting' }))
    expect(screen.getByText('New application')).toBe(application)
    expect(screen.queryByText('Starting Open Science…')).toBeNull()
  })

  it('reuses the branded startup loader while checking and migrating the database', () => {
    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )

    const startupLoader = screen.getByTestId('open-science-logo-loader')
    const startupStatus = screen.getByRole('status')
    const checkingLabel = screen.getByText('Checking database…')
    expect(startupStatus.className).toContain('min-h-svh')
    expect(startupStatus.className).toContain('text-foreground')
    expect(checkingLabel.tagName).toBe('SPAN')
    expect(checkingLabel.className).toContain('text-sm')
    expect(checkingLabel.className).toContain('text-muted-foreground')

    act(() => publish({ phase: 'migrating', migrationId: '0002_example' }))

    const updatingLabel = screen.getByText('Updating database…')
    expect(updatingLabel.tagName).toBe('SPAN')
    expect(updatingLabel.className).toBe(checkingLabel.className)
    expect(screen.getByText('Keep Open Science open while this finishes.')).toBeTruthy()
    expect(screen.getByTestId('open-science-logo-loader')).toBe(startupLoader)

    act(() => publish({ phase: 'starting' }))

    const startingLabel = screen.getByText('Starting Open Science…')
    expect(startingLabel.tagName).toBe('SPAN')
    expect(startingLabel.className).toBe(checkingLabel.className)
    expect(screen.getByText('Keep Open Science open while this finishes.')).toBeTruthy()
    expect(screen.queryByText('Checking database…')).toBeNull()
    expect(screen.getByTestId('open-science-logo-loader')).toBe(startupLoader)
  })

  it('keeps the application unmounted until the database and runtime are ready', async () => {
    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )

    expect(screen.getByText('Checking database…')).toBeTruthy()
    expect(screen.queryByText('Business application')).toBeNull()

    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_newer_than_app',
          message: 'This database was updated by a newer version of Open Science.',
          migrationId: '0002_future_schema',
          retryable: false
        }
      })
    )
    expect(screen.getByText("Open Science couldn't start")).toBeTruthy()
    expect(screen.getByText(/database_newer_than_app/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()

    act(() => publish({ phase: 'ready' }))
    expect(screen.getByText('Business application')).toBeTruthy()
  })

  it('mounts the application immediately on the Web surface', () => {
    window.api = {} as Window['api']

    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )

    expect(screen.getByText('Business application')).toBeTruthy()
    expect(screen.queryByText('Checking database…')).toBeNull()
  })

  it('surfaces a retryable block when the startup state IPC rejects', async () => {
    getState.mockRejectedValue(new Error('No handler registered for database-startup:get-state'))

    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )

    await waitFor(() => {
      expect(screen.getByText("Open Science couldn't start")).toBeTruthy()
    })
    expect(screen.getByText('Open Science could not finish checking its database.')).toBeTruthy()
    expect(screen.getByText(/database_startup_unavailable/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Quit' })).toBeTruthy()
    expect(screen.queryByText('Business application')).toBeNull()
  })

  it('keeps a live startup event when the catch-up read later rejects', async () => {
    let rejectGetState: ((error: Error) => void) | undefined
    getState.mockImplementation(
      () =>
        new Promise<DatabaseStartupState>((_resolve, reject) => {
          rejectGetState = reject
        })
    )

    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )
    act(() => publish({ phase: 'ready' }))
    await act(async () => {
      rejectGetState?.(new Error('No handler registered for database-startup:get-state'))
    })

    expect(screen.getByText('Business application')).toBeTruthy()
    expect(screen.queryByText("Open Science couldn't start")).toBeNull()
  })

  it('restores retry after a retry IPC rejection', async () => {
    retry.mockImplementation(async () => {
      publish({ phase: 'checking' })
      throw new Error('No handler registered for database-startup:retry')
    })
    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )
    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_open_failed',
          message: 'Open Science could not open its database.',
          retryable: true
        }
      })
    )

    await act(async () => screen.getByRole('button', { name: 'Retry' }).click())

    expect(screen.getByText("Open Science couldn't start")).toBeTruthy()
    expect(screen.getByText('Open Science could not finish checking its database.')).toBeTruthy()
    expect(screen.getByText(/database_startup_unavailable/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText('Checking database…')).toBeNull()
    expect(screen.queryByText('Business application')).toBeNull()
  })

  it('keeps a ready application mounted when the locale changes', async () => {
    getState.mockResolvedValue({ phase: 'ready' })

    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )

    await waitFor(() => {
      expect(screen.getByText('Business application')).toBeTruthy()
    })

    getState.mockRejectedValue(new Error('No handler registered for database-startup:get-state'))
    await act(async () => {
      await i18next.changeLanguage('zh-Hans')
    })

    expect(screen.getByText('Business application')).toBeTruthy()
    expect(screen.queryByText("Open Science couldn't start")).toBeNull()
    expect(getState).toHaveBeenCalledOnce()
  })

  it('translates the unavailable startup copy when the locale changes', async () => {
    getState.mockRejectedValue(new Error('No handler registered for database-startup:get-state'))

    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )

    await waitFor(() => {
      expect(screen.getByText('Open Science could not finish checking its database.')).toBeTruthy()
    })

    await act(async () => {
      await i18next.changeLanguage('zh-Hans')
    })

    expect(screen.getByText('Open Science 无法完成数据库检查。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.queryByText('Business application')).toBeNull()
  })

  it('offers retry only for a retryable database failure', async () => {
    retry.mockResolvedValue({ phase: 'checking' })
    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )
    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_open_failed',
          message: 'Open Science could not open its database.',
          retryable: true
        }
      })
    )

    await act(async () => screen.getByRole('button', { name: 'Retry' }).click())
    expect(retry).toHaveBeenCalledOnce()
  })

  it('renders per-error guidance and requires review before exposing the GitHub issue URL', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )
    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_newer_than_app',
          message: 'The database was updated by a newer version of Open Science.',
          migrationId: '0009_vision_evidence',
          retryable: false,
          diagnostics: 'App version: 0.9.2 (darwin-arm64)\n\nError: boom'
        }
      })
    )

    expect(screen.getByText('Why this happened')).toBeTruthy()
    expect(screen.getByText('How to fix')).toBeTruthy()
    expect(screen.getByText(/last written by a newer release/)).toBeTruthy()
    expect(screen.getByText(/database_newer_than_app/)).toBeTruthy()
    expect(screen.getByText(/0009_vision_evidence/)).toBeTruthy()

    await act(async () => screen.getByRole('button', { name: /Create an issue for help/ }).click())

    expect(open).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    const details = screen.getByLabelText('Error details') as HTMLTextAreaElement
    expect(details.value).toContain('Error: boom')
    const issueLink = document.body.querySelector<HTMLAnchorElement>('a[aria-disabled]')!
    expect(issueLink.textContent).toContain('Open GitHub issue')
    expect(issueLink.getAttribute('aria-disabled')).toBe('true')
    expect(issueLink.getAttribute('href')).toBeNull()

    fireEvent.change(details, { target: { value: 'Error: reviewed and edited' } })
    await act(async () => screen.getByRole('checkbox').click())

    expect(issueLink.getAttribute('aria-disabled')).toBe('false')
    const url = issueLink.getAttribute('href') ?? ''
    expect(url).toContain('https://github.com/aipoch/open-science/issues/new?title=')
    expect(decodeURIComponent(url)).toContain('Startup blocked: database_newer_than_app')
    expect(decodeURIComponent(url)).toContain('Error: reviewed and edited')

    fireEvent.change(details, { target: { value: '' } })
    expect(issueLink.getAttribute('aria-disabled')).toBe('true')
    expect(issueLink.getAttribute('href')).toBeNull()

    await act(async () => screen.getByRole('checkbox').click())
    const clearedUrl = issueLink.getAttribute('href') ?? ''
    expect(issueLink.getAttribute('aria-disabled')).toBe('false')
    expect(decodeURIComponent(clearedUrl)).not.toContain('Error: boom')
    expect(decodeURIComponent(clearedUrl)).not.toContain('## Error stack')

    fireEvent.change(details, { target: { value: 'Error: edited again' } })
    expect(issueLink.getAttribute('aria-disabled')).toBe('true')
    expect(issueLink.getAttribute('href')).toBeNull()
  })
  it('shows storage recovery guidance for a retryable validation-query failure', () => {
    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )
    act(() =>
      publish({
        phase: 'blocked',
        error: {
          code: 'database_open_failed',
          message: 'Open Science could not open its database.',
          retryable: true
        }
      })
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(
      screen.getByText(
        'Quit other copies of Open Science, check free disk space and folder permissions, then retry.'
      )
    ).toBeTruthy()
    expect(screen.queryByText(/Part of the stored data doesn't match/)).toBeNull()
  })
})

// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
        onStateChanged: (listener) => {
          publish = listener
          return () => undefined
        }
      }
    } as unknown as Window['api']
  })

  it('reuses the branded startup loader while checking and migrating the database', () => {
    render(
      <DatabaseStartupGate>
        <div>Business application</div>
      </DatabaseStartupGate>
    )

    const startupLoader = screen.getByTestId('open-science-logo-loader')
    expect(screen.getByText('Checking database…')).toBeTruthy()

    act(() => publish({ phase: 'migrating', migrationId: '0002_example' }))

    expect(screen.getByText('Updating database…')).toBeTruthy()
    expect(screen.getByText('Keep Open Science open while this finishes.')).toBeTruthy()
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

  it('renders per-error guidance and opens a pre-filled GitHub issue draft', async () => {
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

    expect(open).toHaveBeenCalledOnce()
    const [url, target] = open.mock.calls[0] as unknown as [string, string]
    expect(url).toContain('https://github.com/aipoch/open-science/issues/new?title=')
    expect(decodeURIComponent(url)).toContain('Startup blocked: database_newer_than_app')
    expect(decodeURIComponent(url)).toContain('Error: boom')
    expect(target).toBe('_blank')
  })
})

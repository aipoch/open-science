// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DatabaseStartupState } from '../../../shared/database-startup'
import { DatabaseStartupGate } from './database-startup-gate'

describe('DatabaseStartupGate', () => {
  let publish: (state: DatabaseStartupState) => void
  const getState = vi.fn<() => Promise<DatabaseStartupState>>()
  const retry = vi.fn<() => Promise<DatabaseStartupState>>()
  const quit = vi.fn<() => Promise<void>>()

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
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
})

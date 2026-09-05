import { describe, expect, it, vi } from 'vitest'

import { DatabaseMigrationError, type SchemaMigrationProgress } from './migration-service'
import { createDatabaseStartupOwner } from './database-startup-owner'

describe('database startup owner', () => {
  it('reports an active schema attempt only until that attempt settles', async () => {
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const owner = createDatabaseStartupOwner({
      reportBlocked: vi.fn(),
      verifyDatabase: async (onProgress) => {
        onProgress({ phase: 'migrating', migrationId: '0001_runtime_schema_baseline' })
        await pending
      }
    })

    const attempt = owner.start()
    expect(owner.isMigrating()).toBe(true)
    finish?.()
    await attempt

    expect(owner.getState()).toEqual({ phase: 'starting' })
    expect(owner.isMigrating()).toBe(false)
  })

  it('blocks business readiness, retries a transient failure, and publishes ready explicitly', async () => {
    let attempt = 0
    const verifyDatabase = vi.fn(
      async (onProgress: (progress: SchemaMigrationProgress) => void): Promise<void> => {
        attempt += 1
        onProgress({ phase: 'checking' })
        onProgress({ phase: 'migrating', migrationId: '0001_runtime_schema_baseline' })
        if (attempt === 1) {
          throw new DatabaseMigrationError(
            'database_open_failed',
            'Open Science could not open its database.',
            true
          )
        }
      }
    )
    const owner = createDatabaseStartupOwner({ reportBlocked: vi.fn(), verifyDatabase })
    const states = [owner.getState()]
    owner.subscribe((state) => states.push(state))

    await expect(owner.start()).resolves.toMatchObject({
      phase: 'blocked',
      error: { code: 'database_open_failed', retryable: true }
    })
    expect(states).toContainEqual({
      phase: 'migrating',
      migrationId: '0001_runtime_schema_baseline'
    })

    await expect(owner.retry()).resolves.toEqual({ phase: 'starting' })
    await expect(owner.whenVerified()).resolves.toBeUndefined()
    expect(owner.getState()).toEqual({ phase: 'starting' })

    owner.complete()
    expect(owner.getState()).toEqual({ phase: 'ready' })
    expect(verifyDatabase).toHaveBeenCalledTimes(2)
  })

  it('blocks an unclassified verification failure so retry remains available', async () => {
    let attempt = 0
    const reportBlocked = vi.fn()
    const verifyDatabase = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('startup subscriber failed')
    })
    const owner = createDatabaseStartupOwner({ reportBlocked, verifyDatabase })

    await expect(owner.start()).resolves.toMatchObject({
      phase: 'blocked',
      error: {
        code: 'database_startup_unavailable',
        message: 'Open Science could not finish checking its database.',
        retryable: true
      }
    })
    expect(reportBlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'database_startup_unavailable',
        retryable: true
      })
    )

    await expect(owner.retry()).resolves.toEqual({ phase: 'starting' })
    await expect(owner.whenVerified()).resolves.toBeUndefined()
    expect(verifyDatabase).toHaveBeenCalledTimes(2)
  })

  it('leaves the database-checking copy after verification while runtime composition continues', async () => {
    const owner = createDatabaseStartupOwner({
      reportBlocked: vi.fn(),
      verifyDatabase: async (onProgress) => {
        onProgress({ phase: 'checking' })
      }
    })
    const states: ReturnType<typeof owner.getState>[] = []
    owner.subscribe((state) => states.push(state))

    await expect(owner.start()).resolves.toEqual({ phase: 'starting' })
    expect(states).toEqual([{ phase: 'checking' }, { phase: 'checking' }, { phase: 'starting' }])
    expect(owner.getState()).toEqual({ phase: 'starting' })
  })

  it('does not retry a non-retryable compatibility failure', async () => {
    const reportBlocked = vi.fn()
    const verifyDatabase = vi.fn(async () => {
      throw new DatabaseMigrationError(
        'database_newer_than_app',
        'The database was updated by a newer version of Open Science.',
        false,
        '0002_future_schema'
      )
    })
    const owner = createDatabaseStartupOwner({ reportBlocked, verifyDatabase })

    const blocked = await owner.start()
    await expect(owner.retry()).resolves.toBe(blocked)
    expect(verifyDatabase).toHaveBeenCalledTimes(1)
    expect(reportBlocked).toHaveBeenCalledOnce()
    expect(reportBlocked).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'database_newer_than_app',
        migrationId: '0002_future_schema'
      })
    )
  })

  it('attaches pre-redacted diagnostics and the environment to the blocked state', async () => {
    const verifyDatabase = vi.fn(async () => {
      throw new DatabaseMigrationError(
        'database_open_failed',
        'Open Science could not open its database.',
        true
      )
    })
    const environment = {
      appVersion: '0.9.2',
      platform: 'darwin',
      arch: 'arm64',
      electron: '37.2.0',
      node: '22.17.0'
    }
    const owner = createDatabaseStartupOwner({
      reportBlocked: vi.fn(),
      verifyDatabase,
      environment,
      buildDiagnostics: (error) =>
        error.code === 'database_open_failed' ? 'Error: boom\n    at f (/f.js:1:1)' : undefined
    })

    const blocked = await owner.start()

    expect(blocked).toMatchObject({
      phase: 'blocked',
      error: { diagnostics: 'Error: boom\n    at f (/f.js:1:1)', environment }
    })
  })

  it('still blocks cleanly when the diagnostics builder throws', async () => {
    const verifyDatabase = vi.fn(async () => {
      throw new DatabaseMigrationError(
        'database_open_failed',
        'Open Science could not open its database.',
        true
      )
    })
    const owner = createDatabaseStartupOwner({
      reportBlocked: vi.fn(),
      verifyDatabase,
      buildDiagnostics: () => {
        throw new Error('diagnostics failed')
      }
    })

    const blocked = await owner.start()

    expect(blocked).toMatchObject({
      phase: 'blocked',
      error: { code: 'database_open_failed' }
    })
    expect(blocked.phase === 'blocked' && blocked.error.diagnostics).toBeFalsy()
  })
})

describe('D03 subscriber failure isolation', () => {
  it('keeps verification, published state, and retry consistent when starting delivery throws', async () => {
    const verifyDatabase = vi.fn(async () => {})
    const reportBlocked = vi.fn()
    const owner = createDatabaseStartupOwner({ verifyDatabase, reportBlocked })
    const unsubscribe = owner.subscribe((state) => {
      if (state.phase === 'starting') throw new Error('injected notification failure')
    })
    const healthyListener = vi.fn()
    owner.subscribe(healthyListener)

    expect.soft(await owner.start()).toEqual({ phase: 'starting' })
    await owner.whenVerified()
    expect.soft(healthyListener).toHaveBeenCalledWith({ phase: 'starting' })
    expect.soft(reportBlocked).not.toHaveBeenCalled()
    unsubscribe()
    expect.soft(await owner.retry()).toEqual({ phase: 'starting' })
    expect(verifyDatabase).toHaveBeenCalledOnce()
    owner.complete()
    expect(owner.getState()).toEqual({ phase: 'ready' })
  })
  it('can retry a database failure even if blocked notifications throw', async () => {
    const failure = new DatabaseMigrationError('database_open_failed', 'locked', true)
    const verifyDatabase = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    const owner = createDatabaseStartupOwner({ verifyDatabase, reportBlocked: vi.fn() })
    owner.subscribe(() => {
      throw new Error('notification unavailable')
    })
    const healthy = vi.fn()
    owner.subscribe(healthy)
    await expect(owner.start()).resolves.toMatchObject({
      phase: 'blocked',
      error: { retryable: true }
    })
    expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ phase: 'blocked' }))
    await expect(owner.retry()).resolves.toEqual({ phase: 'starting' })
    await owner.whenVerified()
    owner.complete()
    expect(healthy).toHaveBeenCalledWith({ phase: 'ready' })
    expect(verifyDatabase).toHaveBeenCalledTimes(2)
  })
})

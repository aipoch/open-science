import { describe, expect, it, vi } from 'vitest'

import {
  PermissionGrantTargetUnavailableError,
  type PermissionGrantRegistry
} from '../permission-grants/registry'
import { createComputePermissionGrantAdapter } from './permission-grant-adapter'

const context = {
  projectId: 'project-1',
  sessionId: 'session-1',
  operation: 'submit_job',
  providerId: 'ssh:biowulf'
}

describe('compute permission grant adapter', () => {
  it('persists Session and Global decisions in the unified Registry', async () => {
    const remember = vi.fn().mockResolvedValue({})
    const registry = { remember } as unknown as PermissionGrantRegistry
    const adapter = createComputePermissionGrantAdapter(registry)

    await adapter.remember(context, 'session')
    await adapter.remember(context, 'global')

    expect(remember).toHaveBeenNthCalledWith(1, {
      capability: {
        kind: 'execution',
        key: 'exec:compute/ssh:biowulf/submit_job',
        qualifier: { mode: 'any' }
      },
      scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
    })
    expect(remember).toHaveBeenNthCalledWith(2, {
      capability: expect.any(Object),
      scope: { kind: 'global' }
    })
  })

  it('migrates legacy settings.json Project grants and clears the old source', async () => {
    const remember = vi.fn().mockResolvedValue({})
    const registry = {
      resolve: vi.fn().mockResolvedValue({ matchedScope: 'project' }),
      remember
    } as unknown as PermissionGrantRegistry
    const legacy = {
      listComputeGrants: vi.fn().mockResolvedValue([
        {
          projectId: context.projectId,
          operation: context.operation,
          providerId: context.providerId
        }
      ]),
      clearComputeGrants: vi.fn().mockResolvedValue(undefined)
    }
    const adapter = createComputePermissionGrantAdapter(registry, legacy)

    await expect(adapter.resolve(context)).resolves.toBe('project')
    expect(remember).toHaveBeenCalledWith({
      capability: expect.objectContaining({ key: 'exec:compute/ssh:biowulf/submit_job' }),
      scope: { kind: 'project', projectId: 'project-1' }
    })
    expect(legacy.clearComputeGrants).toHaveBeenCalledOnce()
  })

  it('retains legacy grants when a Registry migration write fails', async () => {
    const registry = {
      resolve: vi.fn(),
      remember: vi.fn().mockRejectedValue(new Error('database unavailable'))
    } as unknown as PermissionGrantRegistry
    const legacy = {
      listComputeGrants: vi.fn().mockResolvedValue([
        {
          projectId: context.projectId,
          operation: context.operation,
          providerId: context.providerId
        }
      ]),
      clearComputeGrants: vi.fn()
    }

    const adapter = createComputePermissionGrantAdapter(registry, legacy)
    await expect(adapter.migrateLegacy()).rejects.toThrow('database unavailable')
    expect(legacy.clearComputeGrants).not.toHaveBeenCalled()
  })

  it('retries a transient legacy migration failure in the same app lifetime', async () => {
    const registry = {
      remember: vi
        .fn()
        .mockRejectedValueOnce(new Error('database locked'))
        .mockResolvedValueOnce({})
    } as unknown as PermissionGrantRegistry
    const legacy = {
      listComputeGrants: vi.fn().mockResolvedValue([
        {
          projectId: context.projectId,
          operation: context.operation,
          providerId: context.providerId
        }
      ]),
      clearComputeGrants: vi.fn().mockResolvedValue(undefined)
    }

    const adapter = createComputePermissionGrantAdapter(registry, legacy)

    await expect(adapter.migrateLegacy()).rejects.toThrow('database locked')
    await expect(adapter.migrateLegacy()).resolves.toBeUndefined()
    expect(legacy.listComputeGrants).toHaveBeenCalledTimes(2)
    expect(legacy.clearComputeGrants).toHaveBeenCalledOnce()
  })

  it('keeps a partially imported batch and clears it only after a complete idempotent retry', async () => {
    const remember = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('database locked'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    const registry = { remember } as unknown as PermissionGrantRegistry
    const legacy = {
      listComputeGrants: vi.fn().mockResolvedValue([
        {
          projectId: context.projectId,
          operation: context.operation,
          providerId: context.providerId
        },
        { projectId: context.projectId, operation: 'cancel_job', providerId: context.providerId }
      ]),
      clearComputeGrants: vi.fn().mockResolvedValue(undefined)
    }
    const adapter = createComputePermissionGrantAdapter(registry, legacy)

    await expect(adapter.migrateLegacy()).rejects.toThrow('database locked')
    expect(legacy.clearComputeGrants).not.toHaveBeenCalled()

    await expect(adapter.migrateLegacy()).resolves.toBeUndefined()
    expect(remember).toHaveBeenCalledTimes(4)
    expect(legacy.listComputeGrants).toHaveBeenCalledTimes(2)
    expect(legacy.clearComputeGrants).toHaveBeenCalledOnce()
  })

  it('imports valid rows but retains the entire legacy source when a Project owner is gone', async () => {
    const remember = vi
      .fn()
      .mockRejectedValueOnce(new PermissionGrantTargetUnavailableError())
      .mockResolvedValueOnce({})
    const resolve = vi.fn().mockResolvedValue({ matchedScope: 'project' })
    const registry = { remember, resolve } as unknown as PermissionGrantRegistry
    const legacy = {
      listComputeGrants: vi.fn().mockResolvedValue([
        { projectId: 'deleted-project', operation: 'submit_job', providerId: 'ssh:old' },
        {
          projectId: context.projectId,
          operation: context.operation,
          providerId: context.providerId
        }
      ]),
      clearComputeGrants: vi.fn().mockResolvedValue(undefined)
    }

    const adapter = createComputePermissionGrantAdapter(registry, legacy)

    await expect(adapter.migrateLegacy()).rejects.toThrow(
      '1 legacy Compute grant owner is unavailable'
    )
    expect(remember).toHaveBeenCalledTimes(2)
    expect(legacy.clearComputeGrants).not.toHaveBeenCalled()

    await expect(adapter.resolve(context)).resolves.toBe('project')
    expect(resolve).toHaveBeenCalledOnce()
    expect(remember).toHaveBeenCalledTimes(2)
    expect(legacy.listComputeGrants).toHaveBeenCalledOnce()
    expect(legacy.clearComputeGrants).not.toHaveBeenCalled()
  })
})

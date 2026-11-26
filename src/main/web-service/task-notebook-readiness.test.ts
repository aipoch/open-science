import { afterEach, expect, it, vi } from 'vitest'
import { readTaskNotebookReadiness } from './task-notebook-readiness'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

const setPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

const environment = {
  pythonReady: true,
  rReady: false,
  version: 1,
  provisioning: false
}

const memory = {
  status: 'healthy' as const,
  source: 'windows-performance-info' as const,
  executionScope: 'windows:host' as const
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
})

it('uses the Windows compatibility probe for ready Notebook isolation', async () => {
  setPlatform('win32')
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'notebook-env:status') return environment
    if (channel === 'settings:get-notebook-network-status')
      return { kind: 'ready', warnings: [] as const }
    if (channel === 'notebook:memory-policy-state') return memory
    throw new Error(`Unexpected channel: ${channel}`)
  })

  await expect(readTaskNotebookReadiness(invoke)).resolves.toMatchObject({
    environment: { status: 'ready', python: { status: 'ready' } },
    dependencies: { status: 'ready' },
    sandbox: { status: 'ready' },
    memoryPolicy: { status: 'ready' }
  })
  expect(invoke).toHaveBeenCalledWith('settings:get-notebook-network-status')
})

it('reports missing Windows protection as blocked instead of unconfirmed', async () => {
  setPlatform('win32')
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'notebook-env:status') return environment
    if (channel === 'settings:get-notebook-network-status') {
      return {
        kind: 'setupRequired',
        platform: 'win32',
        reasons: ['windowsProfileMissing'] as const
      }
    }
    if (channel === 'notebook:memory-policy-state') return memory
    throw new Error(`Unexpected channel: ${channel}`)
  })

  await expect(readTaskNotebookReadiness(invoke)).resolves.toMatchObject({
    dependencies: { status: 'blocked', reason: 'notebook_sandbox_unavailable' },
    sandbox: { status: 'blocked', reason: 'notebook_sandbox_unavailable' }
  })
})

it('retains Windows isolation unconfirmed when the probe cannot classify the result', async () => {
  setPlatform('win32')
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'notebook-env:status') return environment
    if (channel === 'settings:get-notebook-network-status')
      return { kind: 'error', reason: 'runtimeFailure' as const }
    if (channel === 'notebook:memory-policy-state') return memory
    throw new Error(`Unexpected channel: ${channel}`)
  })

  await expect(readTaskNotebookReadiness(invoke)).resolves.toMatchObject({
    dependencies: {
      status: 'unconfirmed',
      reason: 'notebook_windows_isolation_unconfirmed'
    },
    sandbox: { status: 'unconfirmed', reason: 'notebook_windows_isolation_unconfirmed' }
  })
})

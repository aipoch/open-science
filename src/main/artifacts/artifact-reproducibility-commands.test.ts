import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  ArtifactReproducibilityCheckRequest,
  ArtifactReproducibilityCheckState
} from '../../shared/artifact-reproducibility'
import { createCallerContext } from '../caller-context'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { createApplicationCommandRouter } from '../application-command-router'
import {
  dataContentApplicationCommands,
  registerDataContentApplicationCommands,
  type DataContentApplicationCommandDependencies
} from '../data-content-application-commands'
import {
  createArtifactReproducibilityCommands,
  type ArtifactReproducibilityCommandDependencies
} from './artifact-reproducibility-commands'

const request: ArtifactReproducibilityCheckRequest = {
  projectId: 'project',
  appSessionId: 'session',
  artifactId: 'artifact',
  versionId: 'version',
  frontierId: 'original-inputs'
}
const state = { attemptId: 'attempt' } as ArtifactReproducibilityCheckState

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(
  withSessionAvailable: ArtifactReproducibilityCommandDependencies['withSessionAvailable'] = (
    _request,
    work
  ) => work()
) {
  const owner = {
    start: vi.fn(
      (
        _request: ArtifactReproducibilityCheckRequest,
        _id: number,
        report: (state: ArtifactReproducibilityCheckState) => void
      ) => {
        report(state)
        return state
      }
    ),
    cancel: vi.fn(),
    cancelOwner: vi.fn(),
    getCheck: vi.fn(() => state),
    getCheckLog: vi.fn(),
    listReceipts: vi.fn(),
    sessionCommand: vi.fn()
  }
  const report = vi.fn()
  const dependencies: ArtifactReproducibilityCommandDependencies = {
    withSessionAvailable,
    outputStorage: vi.fn(),
    clearOutputs: vi.fn(),
    previewOutput: vi.fn(),
    describeEnvironmentLock: vi.fn(),
    createEnvironmentFromLock: vi.fn(),
    exportEnvironmentLock: vi.fn(),
    importEnvironmentLock: vi.fn(),
    exportReceipt: vi.fn()
  }
  const commands = createArtifactReproducibilityCommands(() => owner, dependencies, report)
  const router = createApplicationCommandRouter()
  registerDataContentApplicationCommands(router.registrar, {
    reproducibility: commands
  } as DataContentApplicationCommandDependencies)
  const leases = new ApplicationCallerLeaseRegistry()
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const caller = (surface: 'electron' | 'web' = 'electron') => {
    const clientId = randomUUID()
    const context = createCallerContext({
      clientId,
      lifecycleClientId: `${surface}:${clientId}`,
      leaseId: clientId,
      surface,
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human'
    })
    const lease = leases.acquire(context)
    return {
      ...lease,
      clientId,
      invocation: { callerContext: context, callerLease: lease.lease, args: [request] as const }
    }
  }
  return { owner, dependencies, commands, router, leases, caller, report }
}

describe('shared reproducibility command ownership', () => {
  it('gives each live Node document one distinct owner and cancels only its work on release', async () => {
    const value = setup()
    const first = value.caller(),
      second = value.caller()
    await value.router.dispatcher.invoke(
      dataContentApplicationCommands.reproducibilityStart,
      first.invocation
    )
    await value.router.dispatcher.invoke(
      dataContentApplicationCommands.reproducibilityStart,
      second.invocation
    )
    const firstId = value.owner.start.mock.calls[0][1],
      secondId = value.owner.start.mock.calls[1][1]
    expect(firstId).toBeLessThan(0)
    expect(secondId).not.toBe(firstId)
    expect(value.report).toHaveBeenCalledWith(first.clientId, state)
    await value.router.dispatcher.invoke(
      dataContentApplicationCommands.reproducibilityGetCheck,
      first.invocation
    )
    expect(value.owner.getCheck).toHaveBeenCalledWith(request, firstId)
    first.release()
    expect(value.owner.cancelOwner).toHaveBeenCalledExactlyOnceWith(firstId)
    value.report.mockClear()
    value.owner.start.mock.calls[0][2](state)
    value.owner.start.mock.calls[1][2](state)
    expect(value.report).toHaveBeenCalledExactlyOnceWith(second.clientId, state)
    value.router.dispose()
    expect(value.owner.cancelOwner).toHaveBeenLastCalledWith(secondId)
    value.leases.dispose()
    expect(value.owner.cancelOwner).toHaveBeenCalledTimes(2)
  })

  it('rechecks the lease after session admission before starting any work', async () => {
    let admit!: () => void
    const admitted = new Promise<void>((resolve) => {
      admit = resolve
    })
    const value = setup(async (_request, work) => {
      await admitted
      return work()
    })
    const caller = value.caller()
    const pending = value.router.dispatcher.invoke(
      dataContentApplicationCommands.reproducibilityStart,
      caller.invocation
    )
    const rejected = expect(pending).rejects.toThrow('owner is unavailable')
    caller.release()
    admit()
    await rejected
    expect(value.owner.start).not.toHaveBeenCalled()
    value.router.dispose()
  })

  it('does not grant browser callers desktop checks or export dialogs', async () => {
    const value = setup()
    const caller = value.caller('web')
    await expect(
      value.router.dispatcher.invoke(
        dataContentApplicationCommands.reproducibilityStart,
        caller.invocation
      )
    ).rejects.toThrow('desktop app')
    await expect(
      value.router.dispatcher.invoke(
        dataContentApplicationCommands.reproducibilityExportEnvironmentLock,
        {
          ...caller.invocation,
          args: [{ ...request, lockChecksum: 'a'.repeat(64) }]
        }
      )
    ).rejects.toThrow('desktop app')
    expect(value.owner.start).not.toHaveBeenCalled()
    expect(value.dependencies.exportEnvironmentLock).not.toHaveBeenCalled()
    value.router.dispose()
    value.leases.dispose()
  })

  it('passes document identity to native exports without persisting a window or socket identity', async () => {
    const value = setup()
    const caller = value.caller()
    const input = { ...request, lockChecksum: 'a'.repeat(64) }
    await value.router.dispatcher.invoke(
      dataContentApplicationCommands.reproducibilityExportEnvironmentLock,
      {
        ...caller.invocation,
        args: [input]
      }
    )
    expect(value.dependencies.exportEnvironmentLock).toHaveBeenCalledExactlyOnceWith(
      caller.clientId,
      input
    )
    value.router.dispose()
    value.leases.dispose()
  })
})

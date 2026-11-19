import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createApplicationCommandRouter } from '../application-command-router'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { createCallerContext } from '../caller-context'
import { beginMigration, clearMigrationPending } from '../storage/migration-state'
import {
  installNotebookApplicationCommands,
  notebookReleaseSessionResourcesCommand
} from './application-commands'
import { withNotebookExecutionIntent } from './execution-intent'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import { createNotebookCommandWorkflows } from './notebook-workflows'
import { NotebookRuntimeService } from './runtime-service'

it
  .skipIf(process.platform === 'win32')
  .each([
    'caller-disconnected',
    'authorization-revoked',
    'application-stopping',
    'application-updating',
    'package-handoff',
    'session-exporting',
    'data-migration'
  ])(
  'does not stop, cancel, or block the displayed original resource when %s changes during authority validation',
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-authority-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy()
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    const entered = Promise.withResolvers<void>()
    const authority = Promise.withResolvers<void>()
    let authorized = true
    let blockedReason: string | undefined
    let exporting = false
    const workflows = createNotebookCommandWorkflows(service, {
      withSessionAvailable: async (_project, _session, operation) => {
        entered.resolve()
        await authority.promise
        return operation()
      },
      isSessionResourceReadable: async () => true,
      assertSessionResourceReleaseAvailable: () => {
        if (exporting) throw new Error('Session export is in progress.')
      }
    })
    const router = createApplicationCommandRouter()
    installNotebookApplicationCommands(router.registrar, {
      workflows,
      resourceReleaseBlockedReason: () => blockedReason,
      readInputPreview: async () => {
        throw new Error('Unexpected preview')
      }
    })
    const callerContext = createCallerContext({
      clientId: 'renderer',
      lifecycleClientId: 'web:renderer',
      leaseId: 'lease',
      surface: 'web',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human',
      isAuthorizationCurrent: () => authorized
    })
    const leases = new ApplicationCallerLeaseRegistry()
    const ownedLease = leases.acquire(callerContext)
    const intent = service.createExecutionIntent(scope)
    try {
      await service.executeControl(
        withNotebookExecutionIntent({ ...scope, code: 'globalThis.kept = 41' }, intent)
      )
      const group = (await service.getProjectResources(scope)).groups[0]
      const release = router.dispatcher.invoke(notebookReleaseSessionResourcesCommand, {
        callerContext,
        callerLease: ownedLease.lease,
        args: [{ ...scope, revision: group.revision }]
      })
      void release.catch(() => undefined)
      await entered.promise
      if (change === 'caller-disconnected') ownedLease.release()
      else if (change === 'authorization-revoked') authorized = false
      else if (change === 'session-exporting') exporting = true
      else if (change === 'data-migration') beginMigration()
      else blockedReason = change
      authority.resolve()
      await expect(release).rejects.toThrow()
      expect(intent.refusalId).toBeUndefined()
      clearMigrationPending()
      await expect(
        service.executeControl(
          withNotebookExecutionIntent({ ...scope, code: 'console.log(kept)' }, intent)
        )
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('41') })
      expect(service.ownedResources(scope).filter(({ group }) => group === 'kernel')).toHaveLength(
        1
      )
    } finally {
      authority.resolve()
      clearMigrationPending()
      leases.dispose()
      router.dispose()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

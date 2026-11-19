import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { inspectOwnedWindowsProcessIds } from '../process-tree-windows'
import type { NotebookRunDocument } from '../../shared/notebook'
import { withNotebookExecutionIntent } from './execution-intent'
import { createWindowsStandardProcessSandbox } from './fixtures/windows-standard-process-sandbox'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import type { NotebookProcessSandbox } from './process-sandbox'
import { NotebookRuntimeService } from './runtime-service'

const requireNative = createRequire(import.meta.url)
const resetOwnership = configureTestRuntimeMetadata()

describe.skipIf(process.platform !== 'win32')(
  'Windows Notebook session release (real owners)',
  () => {
    let root: string
    let sandbox: Awaited<ReturnType<typeof createWindowsStandardProcessSandbox>>
    let port: NotebookProcessSandbox
    let service: NotebookRuntimeService
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'notebook-windows-release-'))
      vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
      sandbox = await createWindowsStandardProcessSandbox()
      port = sandbox.port
      service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'project',
        // Memory pressure is tested separately; this tracer exercises real execution/Job owners.
        memoryPolicy: healthyNotebookMemoryPolicy(),
        processSandbox: port
      })
    })
    afterEach(async () => {
      let disposal: { reaped: boolean } | undefined
      let ownedJobMembers: number[] | undefined
      let sandboxDisposed = false
      let rootRemoved = false
      try {
        try {
          disposal = await service?.dispose()
          expect(disposal).toEqual({ reaped: true })
          ownedJobMembers = inspectOwnedWindowsProcessIds()
          expect(ownedJobMembers).toEqual([])
        } finally {
          try {
            if (sandbox) {
              await sandbox.dispose()
              sandboxDisposed = true
            }
          } finally {
            await resetOwnership()
          }
        }
        if (root) {
          await rm(root, { recursive: true, force: true })
          await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
          rootRemoved = true
        }
      } finally {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        if (root && !rootRemoved)
          console.error('Windows release fixture retained after incomplete cleanup', {
            root,
            disposal,
            ownedJobMembers,
            sandboxDisposed
          })
      }
    })

    it('reaps the confirmed REPL tree, persists termination and preserves another live session', async () => {
      const native: typeof import('@aipoch/process-tree-native') = requireNative(
        '../../../packages/process-tree-native'
      )
      const scope = { projectId: 'project', sessionId: 'released', workspaceCwd: root }
      const other = { ...scope, sessionId: 'retained' }
      const intent = service.createExecutionIntent(scope)
      const first = await service.executeControl(
        withNotebookExecutionIntent(
          {
            ...scope,
            code: `globalThis.kept = 41;
              globalThis.descendant = require('node:child_process').spawn(process.execPath,
                ['-e', 'setTimeout(() => process.exit(0), 30000)'],
                { detached: true, stdio: 'ignore', windowsHide: true });
              descendant.unref();
              console.log(JSON.stringify({ pid: process.pid, descendant: descendant.pid,
                platform: process.platform, arch: process.arch, node: process.version }));`
          },
          intent
        )
      )
      expect(first.status).toBe('completed')
      const workload: {
        pid: number
        descendant: number
        platform: string
        arch: string
        node: string
      } = JSON.parse(first.stdout.trim())
      expect(workload).toMatchObject({
        platform: 'win32',
        arch: process.arch,
        node: process.version
      })
      const originalBirths = [workload.pid, workload.descendant].map((pid) => ({
        pid,
        birth: native.getWindowsProcessCreationTime(pid)
      }))
      expect(originalBirths.every(({ birth }) => birth !== null)).toBe(true)
      await expect(
        service.executeControl(
          withNotebookExecutionIntent({ ...scope, code: 'console.log(++kept)' }, intent)
        )
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('42') })
      const retained = await service.executeControl({
        ...other,
        code: 'globalThis.kept = 73; console.log(process.pid)'
      })
      expect(retained.status).toBe('completed')
      const retainedPid = Number(retained.stdout.trim())
      const retainedBirth = native.getWindowsProcessCreationTime(retainedPid)
      expect(retainedBirth).not.toBeNull()
      expect(inspectOwnedWindowsProcessIds()).toEqual(
        expect.arrayContaining([workload.pid, workload.descendant, retainedPid])
      )

      const displayed = await service.getProjectResources(scope)
      const group = displayed.groups.find(({ sessionId }) => sessionId === scope.sessionId)!
      expect(group.resources).toEqual([
        expect.objectContaining({ group: 'kernel', kind: 'repl', phase: 'idle' })
      ])
      expect((await service.getProjectResources(scope)).groups).toContainEqual(group)
      const before = await service.state(scope)
      const persistedBefore: NotebookRunDocument = JSON.parse(
        await readFile(before.runJsonPath, 'utf8')
      )
      const receiptsRoot = join(root, 'runtime', 'kernel-processes')
      const receipts: Array<{ laneKey: string; windowsJobName: string; pid: number }> =
        await Promise.all(
          (await readdir(receiptsRoot)).map(async (name) =>
            JSON.parse(await readFile(join(receiptsRoot, name), 'utf8'))
          )
        )
      const receipt = receipts.find(({ laneKey }) => JSON.parse(laneKey)[1] === scope.sessionId)!
      expect(receipt.windowsJobName).toMatch(/^Local\\OpenScience\.Notebook\./)
      const hostBirth = native.getWindowsProcessCreationTime(receipt.pid)
      expect(hostBirth).not.toBeNull()
      expect(inspectOwnedWindowsProcessIds()).toContain(receipt.pid)

      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await service.waitForSessionTeardown(scope)
      expect(
        service.getResourceRelease({ ...scope, operationId: operation.operationId })
      ).toMatchObject({
        status: 'released',
        resources: [
          {
            id: group.resources[0].id,
            group: 'kernel',
            kind: 'repl',
            laneKey: expect.any(String),
            status: 'released',
            processesTerminated: true,
            networkClosed: true,
            temporaryResourcesRemoved: true,
            projection: 'complete'
          }
        ]
      })
      for (const original of originalBirths) {
        expect(native.getWindowsProcessCreationTime(original.pid)).not.toBe(original.birth)
        expect(inspectOwnedWindowsProcessIds()).not.toContain(original.pid)
      }
      expect(native.getWindowsProcessCreationTime(receipt.pid)).not.toBe(hostBirth)
      expect(service.ownedResources(scope)).toEqual([])
      const after = await service.state(scope)
      const persistedAfter: NotebookRunDocument = JSON.parse(
        await readFile(after.runJsonPath, 'utf8')
      )
      expect(persistedAfter.version).toBe(1)
      expect(persistedAfter.runs).toEqual(persistedBefore.runs)
      expect(persistedAfter.kernel.terminatedKernelInstances).toContainEqual({ kind: 'repl' })
      expect(after.environments).toContainEqual(
        expect.objectContaining({ processKey: 'repl', status: 'terminated' })
      )
      expect(JSON.stringify(persistedAfter)).not.toContain(
        JSON.stringify(receipt.windowsJobName).slice(1, -1)
      )
      const remainingReceipts = await Promise.all(
        (await readdir(receiptsRoot)).map(async (name) =>
          JSON.parse(await readFile(join(receiptsRoot, name), 'utf8'))
        )
      )
      expect(remainingReceipts).not.toContainEqual(
        expect.objectContaining({ windowsJobName: receipt.windowsJobName })
      )

      const sentinel = join(root, 'must-not-replay')
      await expect(
        service.executeControl(
          withNotebookExecutionIntent(
            {
              ...scope,
              code: `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`
            },
            intent
          )
        )
      ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
      await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await service.state(scope)).runs).toEqual(after.runs)
      expect(native.getWindowsProcessCreationTime(retainedPid)).toBe(retainedBirth)
      await expect(
        service.executeControl({ ...other, code: 'console.log(++kept)' })
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('74') })
      console.info('Windows session release tracer', {
        node: process.version,
        workload,
        originalHostPid: receipt.pid,
        retainedPid,
        retainedHistory: persistedAfter.runs.length,
        release: service.getResourceRelease({ ...scope, operationId: operation.operationId }).status
      })
    }, 30_000)

    it('rejects a stale revision after a real kernel replacement without stopping the replacement', async () => {
      const scope = { projectId: 'project', sessionId: 'replaced', workspaceCwd: root }
      await expect(
        service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      ).resolves.toMatchObject({ status: 'completed' })
      const original = (await service.getProjectResources(scope)).groups[0]
      await service.shutdown(scope)
      await expect(
        service.executeControl({ ...scope, code: 'globalThis.kept = 73' })
      ).resolves.toMatchObject({ status: 'completed' })
      const replacement = (await service.getProjectResources(scope)).groups[0]
      expect(replacement.revision).not.toBe(original.revision)
      expect(replacement.resources[0].id).not.toBe(original.resources[0].id)
      await expect(
        service.releaseSessionResources({ ...scope, revision: original.revision }, () => undefined)
      ).rejects.toThrow(/changed.*refresh|refresh.*changed/i)
      await expect(
        service.executeControl({ ...scope, code: 'console.log(kept)' })
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('73') })
      expect((await service.getProjectResources(scope)).groups[0].revision).toBe(
        replacement.revision
      )
    }, 30_000)

    it('reaps a detached orphan whose intermediate parent has already exited', async () => {
      const native: typeof import('@aipoch/process-tree-native') = requireNative(
        '../../../packages/process-tree-native'
      )
      const scope = { projectId: 'project', sessionId: 'orphan', workspaceCwd: root }
      const ready = join(root, 'orphan.json')
      const intermediateCode = `
        const orphan = require('node:child_process').spawn(process.execPath,
          ['-e', 'setTimeout(() => process.exit(0), 30000)'],
          { detached: true, stdio: 'ignore', windowsHide: true });
        orphan.unref();
        require('node:fs').writeFileSync(${JSON.stringify(ready)},
          JSON.stringify({ intermediate: process.pid, orphan: orphan.pid }));`
      await expect(
        service.executeControl({
          ...scope,
          code: `require('node:child_process').spawn(process.execPath,
            ['-e', ${JSON.stringify(intermediateCode)}],
            { detached: true, stdio: 'ignore', windowsHide: true }).unref()`
        })
      ).resolves.toMatchObject({ status: 'completed' })
      let workload!: { intermediate: number; orphan: number }
      await vi.waitFor(
        async () => {
          workload = JSON.parse(await readFile(ready, 'utf8'))
          expect(native.getWindowsProcessCreationTime(workload.intermediate)).toBeNull()
        },
        { timeout: 5_000 }
      )
      const orphanBirth = native.getWindowsProcessCreationTime(workload.orphan)
      expect(orphanBirth).not.toBeNull()
      expect(inspectOwnedWindowsProcessIds()).toContain(workload.orphan)
      const group = (await service.getProjectResources(scope)).groups[0]
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await service.waitForSessionTeardown(scope)
      expect(
        service.getResourceRelease({ ...scope, operationId: operation.operationId })
      ).toMatchObject({
        status: 'released',
        resources: [expect.objectContaining({ processesTerminated: true, projection: 'complete' })]
      })
      expect(native.getWindowsProcessCreationTime(workload.orphan)).not.toBe(orphanBirth)
      expect(inspectOwnedWindowsProcessIds()).not.toContain(workload.orphan)
    }, 30_000)

    it('retains a failed termination projection and retries the original resource without stopping another session', async () => {
      const native: typeof import('@aipoch/process-tree-native') = requireNative(
        '../../../packages/process-tree-native'
      )
      const scope = { projectId: 'project', sessionId: 'partial', workspaceCwd: root }
      const other = { ...scope, sessionId: 'retained' }
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      const reference = (await service.getSessionReference(scope))!
      const group = (await service.getProjectResources(scope)).groups[0]
      // A directory at the exact private run.json path reproduces a real persistence failure.
      // The Job still uses its original owner; this does not substitute a kill/proof result.
      await rename(reference.runJsonPath, `${reference.runJsonPath}.backup`)
      await mkdir(reference.runJsonPath)
      let restore: (() => Promise<void>) | undefined = async () => {
        await rmdir(reference.runJsonPath)
        await rename(`${reference.runJsonPath}.backup`, reference.runJsonPath)
      }
      try {
        const operation = await service.releaseSessionResources(
          { ...scope, revision: group.revision },
          () => undefined
        )
        const request = { ...scope, operationId: operation.operationId }
        await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
        expect(service.getResourceRelease(request)).toMatchObject({
          status: 'partial',
          resources: [
            expect.objectContaining({
              id: group.resources[0].id,
              status: 'incomplete',
              projection: 'failed'
            })
          ]
        })
        expect(service.ownedResources(scope)).toEqual([
          expect.objectContaining({ phase: 'cleanup-pending' })
        ])
        const retained = await service.executeControl({
          ...other,
          code: 'globalThis.kept = 73; console.log(process.pid)'
        })
        expect(retained.status).toBe('completed')
        const retainedPid = Number(retained.stdout.trim())
        const retainedBirth = native.getWindowsProcessCreationTime(retainedPid)
        expect(retainedBirth).not.toBeNull()
        await restore()
        restore = undefined
        await expect(service.executeControl({ ...scope, code: '1' })).rejects.toThrow(
          /cleanup.*incomplete/i
        )
        await service.retryResourceRelease(request, () => undefined)
        await service.waitForSessionTeardown(scope)
        expect(service.getResourceRelease(request)).toMatchObject({
          status: 'released',
          resources: [
            expect.objectContaining({
              id: group.resources[0].id,
              status: 'released',
              projection: 'complete'
            })
          ]
        })
        expect(service.ownedResources(scope)).toEqual([])
        expect((await service.state(scope)).environments).toContainEqual(
          expect.objectContaining({ processKey: 'repl', status: 'terminated' })
        )
        expect(native.getWindowsProcessCreationTime(retainedPid)).toBe(retainedBirth)
        await expect(
          service.executeControl({ ...other, code: 'console.log(++kept)' })
        ).resolves.toMatchObject({
          status: 'completed',
          stdout: expect.stringContaining('74')
        })
        await service.retryResourceRelease(request, () => undefined)
        expect(native.getWindowsProcessCreationTime(retainedPid)).toBe(retainedBirth)
      } finally {
        await restore?.()
      }
    }, 30_000)

    it('retries incomplete original cleanup without releasing a same-session Shell successor or another session', async () => {
      const native: typeof import('@aipoch/process-tree-native') = requireNative(
        '../../../packages/process-tree-native'
      )
      const scope = { projectId: 'project', sessionId: 'cleanup-owner', workspaceCwd: root }
      const other = { ...scope, sessionId: 'retained' }
      let cleanupAvailable = false
      let injected = false
      const cleanups: Array<{
        proofPath: string
        actual: { processesTerminated: boolean; networkClosed: boolean }
        reported: { processesTerminated: boolean; networkClosed: boolean }
      }> = []
      const wrap = port.wrap
      vi.spyOn(port, 'wrap').mockImplementation(async (invocation) => {
        const wrapped = await wrap(invocation)
        if (invocation.runtime !== 'repl' || invocation.sessionId !== scope.sessionId || injected)
          return wrapped
        injected = true
        const proofPath = wrapped.processTreeProof!.path
        return {
          ...wrapped,
          cleanup: async (reason, outcome) => {
            // Run the real original cleanup first. Withhold only completion of one dependency;
            // never manufacture successful termination proof or replace the Job owner/killer.
            const actual = await wrapped.cleanup(reason, outcome)
            const reported = cleanupAvailable ? actual : { ...actual, networkClosed: false }
            cleanups.push({ proofPath, actual, reported })
            return reported
          }
        }
      })
      try {
        const initial = await service.executeControl({
          ...scope,
          code: `globalThis.kept = 41;
            globalThis.descendant = require('node:child_process').spawn(process.execPath,
              ['-e', 'setTimeout(() => process.exit(0), 30000)'],
              { detached: true, stdio: 'ignore', windowsHide: true });
            descendant.unref();
            console.log(JSON.stringify({ pid: process.pid, descendant: descendant.pid }));`
        })
        expect(initial.status).toBe('completed')
        const workload: { pid: number; descendant: number } = JSON.parse(initial.stdout.trim())
        const originalBirths = [workload.pid, workload.descendant].map((pid) => ({
          pid,
          birth: native.getWindowsProcessCreationTime(pid)
        }))
        expect(originalBirths.every(({ birth }) => birth !== null)).toBe(true)
        expect(inspectOwnedWindowsProcessIds()).toEqual(
          expect.arrayContaining([workload.pid, workload.descendant])
        )
        const originalOwner = service.ownedResources(scope)[0]
        expect(originalOwner).toMatchObject({ group: 'kernel', kind: 'repl', phase: 'idle' })
        expect(originalOwner.kernelEpochId).toEqual(expect.any(String))
        const receiptsRoot = join(root, 'runtime', 'kernel-processes')
        const receipts: Array<{
          laneKey: string
          windowsJobName: string
          kernelEpochId: string
          windowsProcessTreeProof: { path: string }
        }> = await Promise.all(
          (await readdir(receiptsRoot)).map(async (name) =>
            JSON.parse(await readFile(join(receiptsRoot, name), 'utf8'))
          )
        )
        const receipt = receipts.find(({ laneKey }) => JSON.parse(laneKey)[1] === scope.sessionId)!
        expect(receipt.windowsJobName).toMatch(/^Local\\OpenScience\.Notebook\./)
        expect(receipt.kernelEpochId).toBe(originalOwner.kernelEpochId)
        const group = (await service.getProjectResources(scope)).groups[0]
        const operation = await service.releaseSessionResources(
          { ...scope, revision: group.revision },
          () => undefined
        )
        const request = { ...scope, operationId: operation.operationId }
        await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
        expect(service.getResourceRelease(request)).toMatchObject({
          operationId: operation.operationId,
          status: 'partial',
          resources: [
            expect.objectContaining({
              id: group.resources[0].id,
              status: 'incomplete',
              processesTerminated: true,
              networkClosed: false
            })
          ]
        })
        const pending = service.ownedResources(scope)[0]
        expect(pending.identity).toBe(originalOwner.identity)
        expect(pending.kernelEpochId).toBe(originalOwner.kernelEpochId)
        expect(pending.laneKey).toBe(originalOwner.laneKey)
        expect(pending.phase).toBe('cleanup-pending')
        expect(cleanups).toEqual([
          expect.objectContaining({
            proofPath: receipt.windowsProcessTreeProof.path,
            actual: expect.objectContaining({ processesTerminated: true, networkClosed: true }),
            reported: expect.objectContaining({ processesTerminated: true, networkClosed: false })
          })
        ])
        for (const { pid, birth } of originalBirths) {
          expect(native.getWindowsProcessCreationTime(pid)).not.toBe(birth)
          expect(inspectOwnedWindowsProcessIds()).not.toContain(pid)
        }
        // The executor fences the exact process key until its original cleanup completes.
        await expect(
          service.executeControl(
            withNotebookExecutionIntent(
              { ...scope, code: 'globalThis.mustNotStart = 1' },
              service.createExecutionIntent(scope)
            )
          )
        ).rejects.toThrow(/process tree.*stopped|cleanup.*incomplete/i)
        const freshIntent = service.createExecutionIntent(scope)
        const successor = await service.executeShell(
          withNotebookExecutionIntent(
            {
              ...scope,
              shellRuntime: { kind: 'powershell', version: '5.1' },
              command: '$global:kept = 73; [Console]::Write($PID)'
            },
            freshIntent
          )
        )
        expect(successor.exitCode, JSON.stringify(successor)).toBe(0)
        const successorPid = Number(successor.stdout.trim())
        const successorBirth = native.getWindowsProcessCreationTime(successorPid)
        expect(successorBirth).not.toBeNull()
        const successorOwner = service.ownedResources(scope).find(({ group }) => group === 'shell')!
        expect(successorOwner).toMatchObject({ kind: 'powershell', phase: 'idle' })
        expect(successorOwner.identity).not.toBe(originalOwner.identity)
        const retained = await service.executeControl({
          ...other,
          code: 'globalThis.kept = 101; console.log(process.pid)'
        })
        expect(retained.status).toBe('completed')
        const retainedPid = Number(retained.stdout.trim())
        const retainedBirth = native.getWindowsProcessCreationTime(retainedPid)
        expect(retainedBirth).not.toBeNull()
        await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)

        cleanupAvailable = true
        await service.retryResourceRelease(request, () => undefined)
        await service.waitForSessionTeardown(scope)
        expect(service.getResourceRelease(request)).toMatchObject({
          operationId: operation.operationId,
          status: 'released',
          resources: [
            expect.objectContaining({
              id: group.resources[0].id,
              status: 'released',
              processesTerminated: true,
              networkClosed: true,
              temporaryResourcesRemoved: true,
              projection: 'complete'
            })
          ]
        })
        expect(
          cleanups.every(({ proofPath }) => proofPath === receipt.windowsProcessTreeProof.path)
        ).toBe(true)
        expect(service.ownedResources(scope).map(({ identity }) => identity)).toEqual([
          successorOwner.identity
        ])
        expect(native.getWindowsProcessCreationTime(successorPid)).toBe(successorBirth)
        expect(native.getWindowsProcessCreationTime(retainedPid)).toBe(retainedBirth)
        await expect(
          service.executeShell(
            withNotebookExecutionIntent(
              { ...scope, command: '$global:kept += 1; [Console]::Write("$global:kept|$PID")' },
              freshIntent
            )
          )
        ).resolves.toMatchObject({ exitCode: 0, stdout: `74|${successorPid}` })
        const replacement = await service.executeControl({
          ...scope,
          code: 'globalThis.kept = 89; console.log(process.pid)'
        })
        expect(replacement.status).toBe('completed')
        const replacementPid = Number(replacement.stdout.trim())
        const replacementBirth = native.getWindowsProcessCreationTime(replacementPid)
        expect(replacementBirth).not.toBeNull()
        const cleanupCount = cleanups.length
        expect((await service.retryResourceRelease(request, () => undefined)).status).toBe(
          'released'
        )
        expect(cleanups).toHaveLength(cleanupCount)
        expect(native.getWindowsProcessCreationTime(successorPid)).toBe(successorBirth)
        expect(native.getWindowsProcessCreationTime(retainedPid)).toBe(retainedBirth)
        expect(native.getWindowsProcessCreationTime(replacementPid)).toBe(replacementBirth)
        await expect(
          service.executeShell(
            withNotebookExecutionIntent(
              { ...scope, command: '$global:kept += 1; [Console]::Write("$global:kept|$PID")' },
              freshIntent
            )
          )
        ).resolves.toMatchObject({ exitCode: 0, stdout: `75|${successorPid}` })
        await expect(
          service.executeControl({ ...scope, code: 'console.log(++kept)' })
        ).resolves.toMatchObject({
          status: 'completed',
          stdout: expect.stringContaining('90')
        })
        await expect(
          service.executeControl({ ...other, code: 'console.log(++kept)' })
        ).resolves.toMatchObject({
          status: 'completed',
          stdout: expect.stringContaining('102')
        })
        console.info('Windows failed original cleanup isolation tracer', {
          originalResource: group.resources[0].id,
          epoch: originalOwner.kernelEpochId,
          job: receipt.windowsJobName,
          operation: operation.operationId,
          failure: 'injected incomplete network cleanup after real successful Job cleanup',
          cleanupAttempts: cleanups.length,
          successorPid,
          retainedPid,
          replacementPid
        })
      } finally {
        cleanupAvailable = true
      }
    }, 60_000)

    it('cancels confirmed active work through its original owner and retains the cancelled history', async () => {
      const scope = { projectId: 'project', sessionId: 'active', workspaceCwd: root }
      const other = { ...scope, sessionId: 'other' }
      await service.executeControl({ ...other, code: 'globalThis.kept = 73' })
      const intent = service.createExecutionIntent(scope)
      const ready = join((await service.state(scope)).notebookSessionRoot, 'entered')
      const active = service.executeControl(
        withNotebookExecutionIntent(
          {
            ...scope,
            code: `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'entered'); await new Promise(() => {})`
          },
          intent
        )
      )
      void active.catch(() => undefined)
      try {
        await vi.waitFor(() => access(ready), { timeout: 5_000 })
        const group = (await service.getProjectResources(scope)).groups.find(
          ({ sessionId }) => sessionId === scope.sessionId
        )!
        expect(group.resources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ group: 'operation' }),
            expect.objectContaining({ group: 'kernel', phase: 'running' })
          ])
        )
        const operation = await service.releaseSessionResources(
          { ...scope, revision: group.revision },
          () => undefined
        )
        await service.waitForSessionTeardown(scope)
        await expect(active).resolves.toMatchObject({ status: 'cancelled' })
        expect(
          service.getResourceRelease({ ...scope, operationId: operation.operationId })
        ).toMatchObject({
          status: 'released',
          resources: expect.arrayContaining([
            expect.objectContaining({ group: 'operation', status: 'released' }),
            expect.objectContaining({ group: 'kernel', status: 'released', projection: 'complete' })
          ])
        })
        expect(service.ownedResources(scope)).toEqual([])
        expect((await service.state(scope)).runs).toEqual([
          expect.objectContaining({ status: 'cancelled' })
        ])
        await expect(
          service.executeControl(withNotebookExecutionIntent({ ...scope, code: '1' }, intent))
        ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
        await expect(
          service.executeControl({ ...other, code: 'console.log(kept)' })
        ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('73') })
      } finally {
        await service.shutdown(scope)
        await active
      }
    }, 30_000)

    it('drains a confirmed startup without dispatching it after preparation resumes', async () => {
      const scope = { projectId: 'project', sessionId: 'starting', workspaceCwd: root }
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const wrap = port.wrap
      vi.spyOn(port, 'wrap').mockImplementation(async (invocation) => {
        entered.resolve()
        await resume.promise
        return wrap(invocation)
      })
      const intent = service.createExecutionIntent(scope)
      const sentinel = join((await service.state(scope)).notebookSessionRoot, 'must-not-run')
      const starting = service.executeControl(
        withNotebookExecutionIntent(
          {
            ...scope,
            code: `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`
          },
          intent
        )
      )
      void starting.catch(() => undefined)
      try {
        await entered.promise
        const group = (await service.getProjectResources(scope)).groups[0]
        expect(group.resources).toContainEqual(
          expect.objectContaining({ group: 'kernel', phase: 'starting' })
        )
        const operation = await service.releaseSessionResources(
          { ...scope, revision: group.revision },
          () => undefined
        )
        resume.resolve()
        await service.waitForSessionTeardown(scope)
        await expect(starting).resolves.toMatchObject({ status: 'cancelled' })
        expect(
          service.getResourceRelease({ ...scope, operationId: operation.operationId }).status
        ).toBe('released')
        expect(service.ownedResources(scope)).toEqual([])
        expect(inspectOwnedWindowsProcessIds()).toEqual([])
        await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await service.state(scope)).runs).toEqual([
          expect.objectContaining({ status: 'cancelled', kernelDispatched: false })
        ])
        await expect(
          service.executeControl(withNotebookExecutionIntent({ ...scope, code: '1' }, intent))
        ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
      } finally {
        resume.resolve()
        await starting
      }
    }, 30_000)
  }
)

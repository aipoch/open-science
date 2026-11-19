import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import type { NotebookRunDocument } from '../../shared/notebook'
import { MemoryPolicyService, type MemoryPressureLevel } from './memory-policy'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { NotebookRuntimeService } from './runtime-service'

const resetOwnership = configureTestRuntimeMetadata()

it.skipIf(process.platform !== 'darwin')(
  'reclaims the eligible real idle tree while a background Notebook retains its process and namespace',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'notebook-macos-pressure-')))
    const native = await import('@aipoch/process-tree-native')
    // Only wall/policy time and platform pressure facts are controlled. Timers, processes,
    // sandbox, stdio, original teardown and persisted history use the actual macOS owners.
    const startedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    let pressureLevel: MemoryPressureLevel = 'normal'
    let pressureEventSequence = 0
    const policy = new MemoryPolicyService({
      now: Date.now,
      wallNow: Date.now,
      adapter: {
        platform: 'darwin',
        sample: async () => ({
          platform: 'darwin',
          source: 'controlled-macos-pressure-tracer',
          executionScope: 'darwin:host',
          facts: { pressureLevel, pressureEventSequence }
        })
      }
    })
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      temporaryRoot: join(root, 'commands'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const isSessionBusy = vi.fn<(projectId: string, sessionId: string) => boolean>(() => false)
    let exporting = false
    const isSessionExporting = vi.fn(
      (_projectId: string, sessionId: string) => exporting && sessionId === 'idle'
    )
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'macos-pressure',
      memoryPolicy: policy,
      processSandbox: owner,
      backgroundExecutionEnabled: true,
      isSessionBusy,
      isSessionExporting
    })
    const idle = { projectId: 'macos-pressure', sessionId: 'idle', workspaceCwd: root }
    const active = { ...idle, sessionId: 'active' }
    let resume: string | undefined
    let backgroundRunId: string | undefined
    const observedProcesses: Array<{ pid: number; uniqueId: string }> = []
    const idleChecks = (): number =>
      isSessionBusy.mock.calls.filter(([, sessionId]) => sessionId === idle.sessionId).length
    try {
      const seeded = await service.executeControl({
        ...idle,
        code: `globalThis.kept = 41;
          globalThis.descendant = require('node:child_process').spawn(process.execPath,
            ['-e', 'setTimeout(() => process.exit(0), 120000)'],
            { detached: true, stdio: 'ignore' });
          descendant.unref();
          console.log(JSON.stringify({ pid: process.pid, descendant: descendant.pid, kept }));`
      })
      expect(seeded.status, JSON.stringify(seeded)).toBe('completed')
      const workload: { pid: number; descendant: number; kept: number } = JSON.parse(
        seeded.stdout.trim()
      )
      expect(workload.kept).toBe(41)
      const originals = [workload.pid, workload.descendant].map((pid) => ({
        pid,
        identity: native.getDarwinProcess(pid)
      }))
      for (const original of originals) {
        expect(original.identity).toMatchObject({ pid: original.pid, uniqueId: expect.any(String) })
        expect(original.identity?.uniqueId).not.toBe('0')
      }
      expect(originals[1].identity?.parentUniqueId).toBe(originals[0].identity?.uniqueId)
      const idleHost = native.getDarwinProcess(originals[0].identity!.ppid)
      expect(idleHost?.uniqueId).toBe(originals[0].identity!.parentUniqueId)
      observedProcesses.push(idleHost!, ...originals.map(({ identity }) => identity!))
      const before = await service.state(idle)
      const rejected = { ...idle, sessionId: 'rejected' }
      const rejectedState = await service.state(rejected)
      const rejectedSentinel = join(rejectedState.dataRoot, 'must-not-replay')
      const persistedBefore: NotebookRunDocument = JSON.parse(
        await readFile(before.runJsonPath, 'utf8')
      )
      const idleGroup = (await service.getProjectResources(idle)).groups.find(
        ({ sessionId }) => sessionId === idle.sessionId
      )!
      expect(idleGroup.resources).toEqual([
        expect.objectContaining({ group: 'kernel', kind: 'repl', phase: 'idle' })
      ])
      const beforeIdle = idleChecks()
      service.noteSessionActivity(idle.sessionId)
      await vi.waitFor(() => expect(idleChecks()).toBeGreaterThan(beforeIdle))

      const activeSeed = await service.executeControl({
        ...active,
        code: 'globalThis.kept = 73; console.log(process.pid)'
      })
      expect(activeSeed.status).toBe('completed')
      const activePid = Number(activeSeed.stdout.trim())
      const activeIdentity = native.getDarwinProcess(activePid)
      expect(activeIdentity).toMatchObject({ pid: activePid, uniqueId: expect.any(String) })
      const activeHost = native.getDarwinProcess(activeIdentity!.ppid)
      expect(activeHost?.uniqueId).toBe(activeIdentity!.parentUniqueId)
      observedProcesses.push(activeIdentity!, activeHost!)
      const activeState = await service.state(active)
      const ready = join(activeState.dataRoot, 'background-ready.json')
      resume = join(activeState.dataRoot, 'background-resume')
      const receipt = await service.executeControlBackground({
        ...active,
        background: true,
        code: `require('node:fs').writeFileSync(${JSON.stringify(ready)},
            JSON.stringify({ pid: process.pid, kept }));
          while (!require('node:fs').existsSync(${JSON.stringify(resume)})) {
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          console.log(JSON.stringify({ pid: process.pid, kept: ++kept }));`
      })
      backgroundRunId = receipt.runId
      await vi.waitFor(
        async () => {
          const current = await service.getBackgroundRun({ ...active, runId: receipt.runId })
          expect(current.run.status, JSON.stringify(current.run)).toBe('running')
          expect(existsSync(ready)).toBe(true)
        },
        { timeout: 10_000 }
      )
      expect(JSON.parse(await readFile(ready, 'utf8'))).toEqual({ pid: activePid, kept: 73 })
      const activeGroup = (await service.getProjectResources(active)).groups.find(
        ({ sessionId }) => sessionId === active.sessionId
      )!
      const activeKernel = activeGroup.resources.find(({ group }) => group === 'kernel')!
      expect(activeKernel).toMatchObject({ group: 'kernel', kind: 'repl', phase: 'running' })

      clock.mockReturnValue(startedAt + 5 * 60_000 - 1)
      pressureLevel = 'warning'
      pressureEventSequence = 1
      expect(await policy.getState({ force: true })).toMatchObject({
        status: 'pressured',
        reason: { code: 'mac-memory-warning', pressureScope: 'host' }
      })
      const beforeThresholdCheck = idleChecks()
      service.noteSessionActivity('refresh-without-renewing-idle')
      await vi.waitFor(() => expect(idleChecks()).toBeGreaterThan(beforeThresholdCheck))
      const beforeThreshold = await service.getProjectResources(idle)
      const beforeThresholdIdle = beforeThreshold.groups.find(
        ({ sessionId }) => sessionId === idle.sessionId
      )!
      expect(beforeThresholdIdle).toMatchObject({ revision: idleGroup.revision })
      expect(beforeThresholdIdle.resources).toEqual([
        expect.objectContaining({ id: idleGroup.resources[0].id, phase: 'idle' })
      ])
      for (const original of originals)
        expect(native.getDarwinProcess(original.pid)?.uniqueId).toBe(original.identity!.uniqueId)

      await expect(
        service.executeControl({
          ...rejected,
          code: `require('node:fs').writeFileSync(${JSON.stringify(rejectedSentinel)}, 'ran')`
        })
      ).rejects.toMatchObject({
        code: 'NOTEBOOK_MEMORY_PRESSURE',
        recovery: { execution: 'not-started' }
      })
      expect(existsSync(rejectedSentinel)).toBe(false)

      // The existing export hold protects a real idle tree without renewing its idle age.
      exporting = true
      const idleHoldChecks = (): number =>
        isSessionExporting.mock.calls.filter(([, sessionId]) => sessionId === idle.sessionId).length
      const beforeHold = idleHoldChecks()
      clock.mockReturnValue(startedAt + 5 * 60_000)
      await policy.getState({ force: true })
      service.noteSessionActivity('refresh-without-renewing-idle')
      await vi.waitFor(() => expect(idleHoldChecks()).toBeGreaterThan(beforeHold))
      expect(
        (await service.getProjectResources(idle)).groups.find(
          ({ sessionId }) => sessionId === idle.sessionId
        )?.resources
      ).toContainEqual(expect.objectContaining({ id: idleGroup.resources[0].id, phase: 'idle' }))
      for (const original of originals)
        expect(native.getDarwinProcess(original.pid)?.uniqueId).toBe(original.identity!.uniqueId)
      expect((await service.state(idle)).runs).toEqual(before.runs)
      exporting = false
      service.noteSessionActivity('refresh-without-renewing-idle')
      await vi.waitFor(
        async () =>
          expect((await service.getProjectResources(idle)).groups).not.toContainEqual(
            expect.objectContaining({ sessionId: idle.sessionId })
          ),
        { timeout: 10_000 }
      )
      await service.waitForSessionTeardown(idle)
      for (const original of originals) {
        expect(native.getDarwinProcess(original.pid)?.uniqueId).not.toBe(
          original.identity!.uniqueId
        )
        expect(() => process.kill(original.pid, 0)).toThrow()
      }
      expect(native.getDarwinProcess(idleHost!.pid)?.uniqueId).not.toBe(idleHost!.uniqueId)
      const after = await service.state(idle)
      const persistedAfter: NotebookRunDocument = JSON.parse(
        await readFile(after.runJsonPath, 'utf8')
      )
      expect(persistedAfter.version).toBe(1)
      expect(persistedAfter.runs).toEqual(persistedBefore.runs)
      expect(persistedAfter.kernel.terminatedKernelInstances).toContainEqual({ kind: 'repl' })
      expect(after.environments).toContainEqual(
        expect.objectContaining({ processKey: 'repl', status: 'terminated' })
      )
      expect(native.getDarwinProcess(activePid)?.uniqueId).toBe(activeIdentity!.uniqueId)
      expect(
        (await service.getProjectResources(active)).groups.find(
          ({ sessionId }) => sessionId === active.sessionId
        )?.resources
      ).toContainEqual(
        expect.objectContaining({
          id: activeKernel.id,
          group: 'kernel',
          kind: 'repl',
          phase: 'running',
          laneKey: activeKernel.laneKey,
          startedAt: activeKernel.startedAt
        })
      )
      expect(await service.getBackgroundRun({ ...active, runId: receipt.runId })).toMatchObject({
        run: { status: 'running' }
      })

      pressureLevel = 'normal'
      expect(await policy.getState({ force: true })).toMatchObject({
        status: 'pressured',
        reason: { code: 'mac-memory-recovering' }
      })
      // Advance within the sampler's freshness window until the configured normal hold elapses.
      for (let elapsed = 5_000; elapsed <= 20_000; elapsed += 5_000) {
        clock.mockReturnValue(startedAt + 5 * 60_000 + elapsed)
        await policy.getState({ force: true })
      }
      expect(policy.currentState()).toMatchObject({ status: 'healthy' })
      expect(existsSync(rejectedSentinel)).toBe(false)
      expect((await service.state(idle)).runs).toEqual(after.runs)
      expect((await service.state(rejected)).runs).toEqual([])
      await writeFile(resume, 'continue explicitly')
      await service.waitForBackgroundRun(receipt.runId)
      expect(await service.getBackgroundRun({ ...active, runId: receipt.runId })).toMatchObject({
        run: {
          status: 'completed',
          text: { stdout: `${JSON.stringify({ pid: activePid, kept: 74 })}\n` }
        }
      })
      expect(native.getDarwinProcess(activePid)?.uniqueId).toBe(activeIdentity!.uniqueId)
      await expect(
        service.executeControl({
          ...active,
          code: 'console.log(JSON.stringify({ pid: process.pid, kept: ++kept }))'
        })
      ).resolves.toMatchObject({
        status: 'completed',
        stdout: `${JSON.stringify({ pid: activePid, kept: 75 })}\n`
      })
      expect(existsSync(rejectedSentinel)).toBe(false)
      console.info(
        'macOS Notebook pressure reclamation tracer',
        JSON.stringify({
          node: process.version,
          arch: process.arch,
          controlled: 'Date.now, MemoryPolicy clock and darwin host-warning sample',
          idleOriginals: originals,
          idleHost,
          activeIdentity,
          activeHost,
          activeRun: receipt.runId,
          retainedHistory: persistedAfter.runs.length
        })
      )
    } finally {
      let disposal: { reaped: boolean } | undefined
      let ownerDisposed = false
      let rootRemoved = false
      try {
        try {
          if (resume) await writeFile(resume, 'cleanup')
          if (backgroundRunId) await service.waitForBackgroundRun(backgroundRunId)
        } finally {
          try {
            disposal = await service.dispose()
            expect(disposal).toEqual({ reaped: true })
          } finally {
            try {
              await owner.dispose()
              ownerDisposed = true
            } finally {
              await resetOwnership()
            }
          }
        }
        for (const original of observedProcesses)
          expect(native.getDarwinProcess(original.pid)?.uniqueId).not.toBe(original.uniqueId)
        await rm(root, { recursive: true, force: true })
        expect(existsSync(root)).toBe(false)
        rootRemoved = true
      } finally {
        clock.mockRestore()
        if (!rootRemoved)
          console.error('macOS pressure tracer fixture retained after incomplete cleanup', {
            root,
            disposal,
            ownerDisposed,
            originalProcesses: observedProcesses
          })
      }
    }
  },
  60_000
)

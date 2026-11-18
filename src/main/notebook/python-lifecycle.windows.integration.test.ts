import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { inspectOwnedWindowsProcessIds } from '../process-tree-windows'
import type { NotebookRunDocument } from '../../shared/notebook'
import type { NotebookMemoryPolicyPort } from './execution-admission'
import { withNotebookExecutionIntent } from './execution-intent'
import { createWindowsStandardProcessSandbox } from './fixtures/windows-standard-process-sandbox'
import { MemoryPolicyService, type MemoryPolicyObservation } from './memory-policy'
import type { NotebookSandboxCleanupResult, NotebookSandboxInvocation } from './process-sandbox'
import { NotebookRuntimeService } from './runtime-service'

const requireNative = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const resetOwnership = configureTestRuntimeMetadata()

describe.skipIf(process.platform !== 'win32')('Windows Python lifecycle (real owners)', () => {
  let python: string
  let pythonVersion: string
  let native: typeof import('@aipoch/process-tree-native')
  let root: string
  let sandbox: Awaited<ReturnType<typeof createWindowsStandardProcessSandbox>>
  let service: NotebookRuntimeService
  let observation: MemoryPolicyObservation
  let policy: NotebookMemoryPolicyPort
  let beforeDispatch: (() => void) | undefined
  let afterMemoryCheck: (() => void) | undefined
  let executions: number
  let preparations: number
  let rejections: MemoryPolicyObservation[]
  let cleanups: Array<{
    runtime: NotebookSandboxInvocation['runtime']
    sessionId: string
    proofPath?: string
    result: NotebookSandboxCleanupResult
  }>

  beforeAll(async () => {
    // Resolve an existing interpreter only. Never provision an environment or install packages.
    const { stdout } = await execFileAsync(
      process.env.OPEN_SCIENCE_TEST_PY_ENV ?? 'python',
      [
        '-I',
        '-c',
        'import json, struct, sys; print(json.dumps(dict(executable=sys.executable, version=sys.version.split()[0], platform=sys.platform, bits=struct.calcsize("P") * 8)))'
      ],
      { timeout: 10_000, windowsHide: true }
    )
    const discovered: { executable: string; version: string; platform: string; bits: number } =
      JSON.parse(stdout)
    expect(discovered).toMatchObject({ platform: 'win32', bits: 64 })
    python = await realpath(discovered.executable)
    pythonVersion = discovered.version
    native = requireNative('../../../packages/process-tree-native')
    console.info('Existing Windows Python owner fixture', { ...discovered, node: process.version })
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notebook-windows-python-'))
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
    sandbox = await createWindowsStandardProcessSandbox()
    observation = {
      status: 'healthy',
      reason: { code: 'healthy' },
      source: 'controlled-test-observation',
      executionScope: 'windows-python-test:host'
    }
    policy = { getState: async () => observation, currentState: () => observation }
    beforeDispatch = undefined
    afterMemoryCheck = undefined
    executions = 0
    preparations = 0
    rejections = []
    cleanups = []
    const wrap = sandbox.port.wrap
    sandbox.port.wrap = async (invocation) => {
      preparations++
      const wrapped = await wrap(invocation)
      return {
        ...wrapped,
        cleanup: async (reason, outcome) => {
          const result = await wrapped.cleanup(reason, outcome)
          cleanups.push({
            runtime: invocation.runtime,
            sessionId: invocation.sessionId,
            proofPath: wrapped.processTreeProof?.path,
            result
          })
          return result
        },
        beginExecution: (request) => {
          const end = wrapped.beginExecution?.(request)
          executions++
          beforeDispatch?.()
          return () => end?.()
        }
      }
    }
    service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      callbacks: { onMemoryPolicyRejected: (_context, state) => rejections.push(state) },
      processSandbox: sandbox.port,
      memoryPolicy: {
        getState: async (request) => {
          const state = await policy.getState(request)
          afterMemoryCheck?.()
          return state
        },
        currentState: (request) => policy.currentState(request),
        dispose: () => policy.dispose?.()
      },
      discoverRuntimes: async (language) =>
        language === 'python'
          ? [
              {
                language: 'python',
                provenance: 'user-own',
                envId: python,
                interpreterPath: python,
                label: 'existing Windows test interpreter',
                version: pythonVersion,
                runnable: true
              }
            ]
          : [],
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: { enabled: { [python]: true }, installAuthorized: {} },
          manualInterpreters: [],
          packageMirror: {}
        })
      }
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
        expect(
          cleanups.every(
            ({ result }) =>
              result.processesTerminated && result.networkClosed && result.temporaryResourcesRemoved
          )
        ).toBe(true)
      } finally {
        try {
          await sandbox?.dispose()
          sandboxDisposed = true
        } finally {
          await resetOwnership()
        }
      }
      if (root) {
        const cleanupRoot = await realpath(root)
        expect(dirname(cleanupRoot).toLowerCase()).toBe((await realpath(tmpdir())).toLowerCase())
        expect(basename(cleanupRoot)).toMatch(/^notebook-windows-python-/)
        await rm(cleanupRoot, { recursive: true, force: true })
        await expect(access(cleanupRoot)).rejects.toMatchObject({ code: 'ENOENT' })
        rootRemoved = true
        console.info('Windows Python fixture cleaned', { root: cleanupRoot, ownedJobMembers })
      }
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      if (root && !rootRemoved)
        console.error('Windows Python fixture retained after incomplete cleanup', {
          root,
          disposal,
          ownedJobMembers,
          sandboxDisposed,
          cleanups
        })
    }
  })

  const stdoutFor = async (
    scope: Parameters<NotebookRuntimeService['state']>[0],
    runId: string
  ): Promise<string> => {
    const run = (await service.state(scope)).runs.find((candidate) => candidate.runId === runId)
    expect(run).toBeDefined()
    return run!.text.stdout
  }

  const kernelReceipts = async (): Promise<string[]> => {
    const directory = join(root, 'runtime', 'kernel-processes')
    return Promise.all(
      (await readdir(directory)).sort().map((name) => readFile(join(directory, name), 'utf8'))
    )
  }

  it('refuses initial pressure and reused unavailable sampling without replaying Python code', async () => {
    const scope = { projectId: 'project', sessionId: 'python-admission', workspaceCwd: root }
    await service.bindRuntime({ ...scope, language: 'python', runtimeId: python })
    const intent = service.createExecutionIntent(scope)
    const sentinel = join(root, 'must-not-replay')
    const code = `kept = 999; __import__('pathlib').Path(${JSON.stringify(sentinel)}).write_text('ran')`
    observation = { ...observation, status: 'pressured', reason: { code: 'windows-physical-low' } }
    await expect(
      service.execute(withNotebookExecutionIntent({ ...scope, code }, intent))
    ).rejects.toMatchObject({
      code: 'NOTEBOOK_MEMORY_PRESSURE',
      recovery: { execution: 'not-started' }
    })
    expect(preparations).toBe(0)
    expect(executions).toBe(0)
    expect(inspectOwnedWindowsProcessIds()).toEqual([])
    expect(service.ownedResources(scope)).toEqual([])
    expect((await service.state(scope)).runs).toEqual([])
    observation = { ...observation, status: 'healthy', reason: { code: 'healthy' } }
    await service.getMemoryPolicyState({})
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(preparations).toBe(0)
    await expect(
      service.execute(withNotebookExecutionIntent({ ...scope, code }, intent))
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
    const warmIntent = service.createExecutionIntent(scope)
    const first = await service.execute(
      withNotebookExecutionIntent(
        {
          ...scope,
          code: 'import os, sys, json; kept = 41; print(json.dumps(dict(pid=os.getpid(), executable=sys.executable, kept=kept)))'
        },
        warmIntent
      )
    )
    expect(first.status, JSON.stringify(first)).toBe('completed')
    const workload: { pid: number; executable: string; kept: number } = JSON.parse(
      await stdoutFor(scope, first.runId)
    )
    expect(workload.kept).toBe(41)
    expect(await realpath(workload.executable)).toBe(python)
    const birth = native.getWindowsProcessCreationTime(workload.pid)
    expect(birth).not.toBeNull()
    const members = inspectOwnedWindowsProcessIds()
    expect(members).toContain(workload.pid)
    const before = await service.state(scope)
    observation = { ...observation, status: 'unavailable', reason: { code: 'sample-failed' } }
    await expect(
      service.execute(withNotebookExecutionIntent({ ...scope, code }, warmIntent))
    ).rejects.toMatchObject({
      code: 'NOTEBOOK_MEMORY_UNAVAILABLE',
      recovery: { execution: 'not-started' }
    })
    expect((await service.state(scope)).runs).toEqual(before.runs)
    expect(preparations).toBe(1)
    expect(executions).toBe(1)
    expect(native.getWindowsProcessCreationTime(workload.pid)).toBe(birth)
    expect(inspectOwnedWindowsProcessIds()).toEqual(members)
    observation = { ...observation, status: 'healthy', reason: { code: 'healthy' } }
    await service.getMemoryPolicyState({})
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(executions).toBe(1)
    expect((await service.state(scope)).runs).toEqual(before.runs)
    await expect(
      service.execute(withNotebookExecutionIntent({ ...scope, code }, warmIntent))
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
    const continued = await service.execute(
      withNotebookExecutionIntent(
        { ...scope, code: 'kept += 1; print(json.dumps(dict(pid=os.getpid(), kept=kept)))' },
        service.createExecutionIntent(scope)
      )
    )
    expect(continued.status).toBe('completed')
    expect(JSON.parse(await stdoutFor(scope, continued.runId))).toEqual({
      pid: workload.pid,
      kept: 42
    })
    expect(native.getWindowsProcessCreationTime(workload.pid)).toBe(birth)
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    console.info('Windows Python initial/reuse admission tracer', {
      python,
      workload,
      birth,
      jobMembers: members,
      memory: 'controlled-test-observation',
      refusals: rejections.map(({ status, reason }) => ({ status, reason })),
      executions
    })
  }, 60_000)

  it.each([
    { label: 'physical pressure', status: 'pressured', reason: 'windows-physical-low' },
    { label: 'unavailable sampling', status: 'unavailable', reason: 'sample-failed' },
    { label: 'expired sample', status: 'unavailable', reason: 'sample-expired' }
  ] as const)(
    'refuses $label immediately before Python dispatch without changing its namespace or Job',
    async ({ status, reason }) => {
      let monotonicNow = 0
      if (reason === 'sample-expired') {
        // Only the policy clock/sample is controlled; Python, supervisor and Job stay real.
        policy = new MemoryPolicyService({
          adapter: {
            platform: 'win32',
            sample: async () => ({
              platform: 'win32',
              source: 'controlled-test-sample',
              executionScope: 'windows-python-test:host',
              facts: {
                totalBytes: 1000,
                availableBytes: 800,
                committedBytes: 200,
                commitLimitBytes: 1000
              }
            })
          },
          now: () => monotonicNow,
          wallNow: () => 1_000_000 + monotonicNow
        })
      }
      const scope = { projectId: 'project', sessionId: 'python-final', workspaceCwd: root }
      await service.bindRuntime({ ...scope, language: 'python', runtimeId: python })
      const intent = service.createExecutionIntent(scope)
      const first = await service.execute(
        withNotebookExecutionIntent(
          { ...scope, code: 'import os, json; kept = 41; print(os.getpid())' },
          intent
        )
      )
      expect(first.status).toBe('completed')
      const pid = Number((await stdoutFor(scope, first.runId)).trim())
      const birth = native.getWindowsProcessCreationTime(pid)
      expect(birth).not.toBeNull()
      const reused = await service.execute(
        withNotebookExecutionIntent({ ...scope, code: 'kept += 1; print(kept)' }, intent)
      )
      expect(reused.status).toBe('completed')
      expect((await stdoutFor(scope, reused.runId)).trim()).toBe('42')
      const members = inspectOwnedWindowsProcessIds()
      expect(members).toContain(pid)
      const memberBirths = members.map((member) => native.getWindowsProcessCreationTime(member))
      expect(memberBirths.every((value) => value !== null)).toBe(true)
      const receipts = await kernelReceipts()
      expect(receipts).toHaveLength(1)
      expect(JSON.parse(receipts[0])).toMatchObject({
        processKey: expect.stringMatching(/^python:/),
        windowsJobName: expect.stringMatching(/^Local\\OpenScience\.Notebook\./)
      })
      const sentinel = join(root, 'must-not-dispatch')
      beforeDispatch = () => {
        if (reason === 'sample-expired') {
          // prepare('dispatch') may resample. Expire only after that final async read returns.
          afterMemoryCheck = () => {
            monotonicNow += 2001
            afterMemoryCheck = undefined
          }
        } else observation = { ...observation, status, reason: { code: reason } }
      }
      const refused = await service.execute(
        withNotebookExecutionIntent(
          {
            ...scope,
            code: `kept = 999; __import__('pathlib').Path(${JSON.stringify(sentinel)}).write_text('ran')`
          },
          intent
        )
      )
      expect(refused).toMatchObject({ status: 'failed', recovery: { execution: 'not-started' } })
      expect(rejections).toEqual([expect.objectContaining({ status, reason: { code: reason } })])
      const afterRefusal = await service.state(scope)
      expect(afterRefusal.runs.at(-1)).toMatchObject({
        status: 'failed',
        kernelDispatched: false,
        executionStarted: false,
        recovery: { execution: 'not-started' }
      })
      expect(executions).toBe(3)
      expect(inspectOwnedWindowsProcessIds()).toEqual(members)
      expect(members.map((member) => native.getWindowsProcessCreationTime(member))).toEqual(
        memberBirths
      )
      await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })

      beforeDispatch = undefined
      observation = { ...observation, status: 'healthy', reason: { code: 'healthy' } }
      await service.getMemoryPolicyState({})
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect((await service.state(scope)).runs).toEqual(afterRefusal.runs)
      expect(executions).toBe(3)
      await expect(
        service.execute(withNotebookExecutionIntent({ ...scope, code: 'kept = 999' }, intent))
      ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
      const continued = await service.execute(
        withNotebookExecutionIntent(
          { ...scope, code: 'kept += 1; print(json.dumps(dict(pid=os.getpid(), kept=kept)))' },
          service.createExecutionIntent(scope)
        )
      )
      expect(continued.status).toBe('completed')
      expect(JSON.parse(await stdoutFor(scope, continued.runId))).toEqual({ pid, kept: 43 })
      expect(executions).toBe(4)
      expect(preparations).toBe(1)
      await expect(
        service.execute(withNotebookExecutionIntent({ ...scope, code: 'kept = 999' }, intent))
      ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
      expect(native.getWindowsProcessCreationTime(pid)).toBe(birth)
      expect(inspectOwnedWindowsProcessIds()).toEqual(members)
      expect(members.map((member) => native.getWindowsProcessCreationTime(member))).toEqual(
        memberBirths
      )
      expect(await kernelReceipts()).toEqual(receipts)
      await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
      console.info('Windows Python final dispatch tracer', {
        python,
        pid,
        birth,
        jobMembers: members,
        job: JSON.parse(receipts[0]).windowsJobName,
        memory: reason === 'sample-expired' ? 'controlled-test-sample/clock' : observation.source,
        refusal: reason,
        refusedRun: {
          status: refused.status,
          kernelDispatched: refused.kernelDispatched,
          executionStarted: refused.executionStarted,
          recovery: refused.recovery
        },
        executions
      })
    },
    60_000
  )

  it('releases one confirmed Python/REPL/PowerShell session through its original owners and retains another Python', async () => {
    const scope = { projectId: 'project', sessionId: 'mixed-release', workspaceCwd: root }
    const other = { ...scope, sessionId: 'retained-python' }
    await service.bindRuntime({ ...scope, language: 'python', runtimeId: python })
    const intent = service.createExecutionIntent(scope)
    const data = await service.execute(
      withNotebookExecutionIntent(
        {
          ...scope,
          code: `import os, sys, json, subprocess
kept = 41
descendant = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(120)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(json.dumps(dict(pid=os.getpid(), descendant=descendant.pid)))`
        },
        intent
      )
    )
    expect(data.status).toBe('completed')
    const pythonWorkload: { pid: number; descendant: number } = JSON.parse(
      await stdoutFor(scope, data.runId)
    )
    const control = await service.executeControl(
      withNotebookExecutionIntent(
        {
          ...scope,
          code: `globalThis.kept = 51;
globalThis.descendant = require('node:child_process').spawn(process.execPath,
  ['-e', 'setTimeout(() => process.exit(0), 120000)'],
  { detached: true, stdio: 'ignore', windowsHide: true });
descendant.unref();
console.log(JSON.stringify({ pid: process.pid, descendant: descendant.pid }));`
        },
        intent
      )
    )
    expect(control.status).toBe('completed')
    const nodeWorkload: { pid: number; descendant: number } = JSON.parse(control.stdout.trim())
    const shell = await service.executeShell(
      withNotebookExecutionIntent(
        {
          ...scope,
          shellRuntime: { kind: 'powershell', version: '5.1' },
          command:
            '$global:kept = 61; [Console]::Write("$PID|$($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor)")'
        },
        intent
      )
    )
    expect(shell.exitCode, JSON.stringify(shell)).toBe(0)
    const [shellPid, shellVersion] = shell.stdout.trim().split('|')
    expect(shellVersion).toBe('5.1')
    // Shell has a separate native supervisor, outside the kernel launchers' opaque Job handles.
    // Root this read-only snapshot at its exact receipt host, excluding shared analysis workers.
    // Only the original owners authorize cleanup; this snapshot cannot release any process.
    const shellReceiptsRoot = join(root, 'shell-process-ownership')
    const shellReceipts: Array<{ sessionId: string; pid: number; receiptId: string }> =
      await Promise.all(
        (await readdir(shellReceiptsRoot)).map(async (name) =>
          JSON.parse(await readFile(join(shellReceiptsRoot, name), 'utf8'))
        )
      )
    expect(shellReceipts).toHaveLength(1)
    const shellReceipt = shellReceipts[0]
    expect(shellReceipt.sessionId).toBe(scope.sessionId)
    expect(native.getWindowsProcessCommandLine(shellReceipt.pid)).toContain(shellReceipt.receiptId)
    const shellMembers = new Set([shellReceipt.pid])
    const snapshot = native.listWindowsProcesses()
    let added: boolean
    do {
      added = false
      for (const { pid, ppid } of snapshot)
        if (shellMembers.has(ppid) && !shellMembers.has(pid)) {
          shellMembers.add(pid)
          added = true
        }
    } while (added)
    expect([...shellMembers]).toContain(Number(shellPid))
    const members = [...new Set([...inspectOwnedWindowsProcessIds(), ...shellMembers])]
    expect(members).toEqual(
      expect.arrayContaining([
        pythonWorkload.pid,
        pythonWorkload.descendant,
        nodeWorkload.pid,
        nodeWorkload.descendant,
        Number(shellPid)
      ])
    )
    const receipts: Array<{
      laneKey: string
      processKey: string
      pid: number
      windowsJobName: string
    }> = (await kernelReceipts()).map((contents) => JSON.parse(contents))
    expect(receipts).toHaveLength(2)
    for (const receipt of receipts) {
      expect(JSON.parse(receipt.laneKey)[1]).toBe(scope.sessionId)
      expect(receipt.windowsJobName).toMatch(/^Local\\OpenScience\.Notebook\./)
      expect(members).toContain(receipt.pid)
    }

    const processRoles = new Map<number, string>([
      ...receipts.map(({ pid, processKey }) => [pid, processKey + ' launcher'] as const),
      [pythonWorkload.pid, 'python'],
      [pythonWorkload.descendant, 'python descendant'],
      [nodeWorkload.pid, 'repl'],
      [nodeWorkload.descendant, 'repl descendant'],
      [shellReceipt.pid, 'shell supervisor'],
      [Number(shellPid), 'powershell']
    ])
    const memberBirths = members.map((pid) => {
      const process = snapshot.find((entry) => entry.pid === pid)
      return {
        pid,
        birth: native.getWindowsProcessCreationTime(pid),
        role: processRoles.get(pid) ?? (shellMembers.has(pid) ? 'shell descendant' : 'job member'),
        parentPid: process?.ppid,
        image: process?.executablePath && basename(process.executablePath)
      }
    })
    expect(memberBirths.filter(({ birth }) => birth === null)).toEqual([])

    await service.bindRuntime({ ...other, language: 'python', runtimeId: python })
    const retained = await service.execute({
      ...other,
      code: 'import os, json; kept = 73; print(os.getpid())'
    })
    expect(retained.status).toBe('completed')
    const retainedPid = Number((await stdoutFor(other, retained.runId)).trim())
    const retainedBirth = native.getWindowsProcessCreationTime(retainedPid)
    expect(retainedBirth).not.toBeNull()
    expect(members).not.toContain(retainedPid)
    const retainedMembers = inspectOwnedWindowsProcessIds().filter((pid) => !members.includes(pid))
    expect(retainedMembers).toContain(retainedPid)
    const retainedBirths = retainedMembers.map((pid) => native.getWindowsProcessCreationTime(pid))
    expect(retainedBirths.every((birth) => birth !== null)).toBe(true)
    const retainedReceipt = (await kernelReceipts()).find(
      (contents) => JSON.parse(JSON.parse(contents).laneKey)[1] === other.sessionId
    )!
    expect(retainedReceipt).toBeDefined()
    const group = (await service.getProjectResources(scope)).groups.find(
      ({ sessionId }) => sessionId === scope.sessionId
    )!
    expect(group.resources).toHaveLength(3)
    expect(group.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: 'kernel', kind: 'python', phase: 'idle' }),
        expect.objectContaining({ group: 'kernel', kind: 'repl', phase: 'idle' }),
        expect.objectContaining({ group: 'shell', kind: 'powershell', phase: 'idle' })
      ])
    )
    const environment = group.resources.find(({ kind }) => kind === 'python')!.environment!
    expect(environment).toEqual(expect.any(String))
    expect((await service.getProjectResources(scope)).groups).toContainEqual(
      expect.objectContaining({
        sessionId: scope.sessionId,
        revision: group.revision,
        resources: group.resources.map(({ id }) => expect.objectContaining({ id }))
      })
    )
    const before = await service.state(scope)
    const releaseStartedAt = performance.now()
    const operation = await service.releaseSessionResources(
      { ...scope, revision: group.revision },
      () => undefined
    )
    await service.waitForSessionTeardown(scope)
    const released = service.getResourceRelease({ ...scope, operationId: operation.operationId })
    expect(released).toMatchObject({ status: 'released', revision: group.revision })
    expect(released.resources).toHaveLength(3)
    expect(cleanups).toHaveLength(3)
    expect(cleanups.map(({ runtime }) => runtime).sort()).toEqual(['bash', 'python', 'repl'])
    for (const cleanup of cleanups)
      expect(cleanup).toMatchObject({
        sessionId: scope.sessionId,
        proofPath: expect.any(String),
        result: {
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: true
        }
      })
    for (const resource of group.resources) {
      expect(released.resources).toContainEqual(
        expect.objectContaining({ id: resource.id, group: resource.group, status: 'released' })
      )
      if (resource.group === 'kernel') {
        expect(released.resources).toContainEqual(
          expect.objectContaining({
            id: resource.id,
            processesTerminated: true,
            networkClosed: true,
            temporaryResourcesRemoved: true,
            projection: 'complete'
          })
        )
      }
    }
    const remainingMembers = inspectOwnedWindowsProcessIds()
    const survivors = memberBirths.filter(
      ({ pid, birth }) =>
        native.getWindowsProcessCreationTime(pid) === birth || remainingMembers.includes(pid)
    )
    expect(
      survivors,
      JSON.stringify({
        session: scope.sessionId,
        elapsedMs: performance.now() - releaseStartedAt,
        release: released,
        remainingMembers
      })
    ).toEqual([])
    expect(service.ownedResources(scope)).toEqual([])
    expect(await readdir(shellReceiptsRoot)).toEqual([])
    const after = await service.state(scope)
    const persistedAfter: NotebookRunDocument = JSON.parse(
      await readFile(after.runJsonPath, 'utf8')
    )
    expect([1, 2]).toContain(persistedAfter.version)
    expect(after.runs).toEqual(before.runs)
    expect(persistedAfter.kernel.terminatedKernelInstances).toEqual(
      expect.arrayContaining([{ kind: 'python', environment }, { kind: 'repl' }])
    )
    expect(after.environments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'python', environment, status: 'terminated' }),
        expect.objectContaining({ kind: 'repl', status: 'terminated' })
      ])
    )
    for (const receipt of receipts)
      expect(JSON.stringify(persistedAfter)).not.toContain(
        JSON.stringify(receipt.windowsJobName).slice(1, -1)
      )
    expect(await kernelReceipts()).toEqual([retainedReceipt])
    const sentinel = join(root, 'must-not-rebuild')
    await expect(
      service.execute(
        withNotebookExecutionIntent(
          {
            ...scope,
            code: `__import__('pathlib').Path(${JSON.stringify(sentinel)}).write_text('ran')`
          },
          intent
        )
      )
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await service.state(scope)).runs).toEqual(after.runs)
    expect(service.ownedResources(scope)).toEqual([])
    expect(inspectOwnedWindowsProcessIds()).toEqual(retainedMembers)
    expect(retainedMembers.map((pid) => native.getWindowsProcessCreationTime(pid))).toEqual(
      retainedBirths
    )
    const continued = await service.execute({
      ...other,
      code: 'kept += 1; print(json.dumps(dict(pid=os.getpid(), kept=kept)))'
    })
    expect(continued.status).toBe('completed')
    expect(JSON.parse(await stdoutFor(other, continued.runId))).toEqual({
      pid: retainedPid,
      kept: 74
    })
    expect(native.getWindowsProcessCreationTime(retainedPid)).toBe(retainedBirth)
    expect(await kernelReceipts()).toEqual([retainedReceipt])
    console.info(
      'Windows mixed interpreter release tracer',
      JSON.stringify({
        python,
        pythonWorkload,
        nodeWorkload,
        shell: { pid: Number(shellPid), version: shellVersion },
        confirmed: { revision: group.revision, resources: group.resources },
        originalMembers: memberBirths,
        jobs: receipts.map(({ windowsJobName }) => windowsJobName),
        originalCleanups: cleanups,
        release: released,
        retained: { pid: retainedPid, birth: retainedBirth, members: retainedMembers, kept: 74 },
        runDocumentVersion: persistedAfter.version,
        retainedHistory: persistedAfter.runs.length
      })
    )
  }, 90_000)
})

import { test, expect } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import type { ElectronApplication } from 'playwright'
import { promisify } from 'node:util'
import {
  closeElectronApplicationForCleanup,
  disconnectFixtureServiceConnection,
  hasFixtureReconnected,
  launchOpenScience,
  launchEnvironment,
  removeTreeForCleanup
} from './fixtures/electron-app'
import {
  captureFixtureAgents,
  captureFixtureProcess,
  captureFixtureRoot,
  captureFixtureService,
  cleanupFixtureAgent,
  cleanupFixtureProcess,
  cleanupFixtureService,
  runFixtureCleanup,
  remainingFixtureAgentReceipts,
  makeCapturedFixtureDirectoriesWritable,
  type CapturedFixtureAgent,
  type CapturedFixtureProcess,
  type CapturedService
} from './fixtures/local-service-cleanup'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'
import { isRuntimeProcessAlive } from '../src/main/runtime-stop-confirmation'
import { acquireRuntimeDirectorySync } from '../src/main/runtime-ownership'
import { processBirthIdentity } from '../src/main/process-birth-identity'
import { readProcessTree } from '../scripts/performance/process-snapshot'
import { DelegatedProcessOwnership } from '../src/main/delegation/process-ownership'
import { proveRecordedPosixLeaderGone } from '../src/main/process-tree'

const evidence = resolve('.scratch/local-service-lifecycle-implementation/e2e')
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function launchFixture(stalled = false) {
  // Ordinary source-build regressions record their checkout automatically. An external
  // packaged executable still requires explicit provenance because it may differ from HEAD.
  const sourceRevision = process.env.OPEN_SCIENCE_E2E_EXECUTABLE
    ? undefined
    : (await promisify(execFile)('git', ['rev-parse', 'HEAD'])).stdout.trim()
  const baseline = process.env.OPEN_SCIENCE_E2E_BASELINE?.trim() ?? sourceRevision
  const buildId =
    process.env.OPEN_SCIENCE_E2E_BUILD_ID?.trim() ??
    (sourceRevision ? `source-${sourceRevision}` : undefined)
  if (
    !baseline ||
    !/^[a-f\d]{40}$/i.test(baseline) ||
    !buildId ||
    ['unrecorded', 'unknown'].includes(buildId)
  )
    throw new Error(
      'Lifecycle acceptance requires an exact OPEN_SCIENCE_E2E_BASELINE and OPEN_SCIENCE_E2E_BUILD_ID before launching any process.'
    )
  await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'open-science-lifecycle-acceptance-'))
  const capturedRoot = await captureFixtureRoot(root)
  const roots = {
    storageRoot: join(root, 'config'),
    userDataRoot: join(root, 'profile'),
    fakeAgentBinRoot: join(root, 'bin'),
    fakeRemoteItRoot: join(root, 'remote'),
    fakeRemoteItState: join(root, 'remote.json')
  }
  await mkdir(roots.storageRoot)
  await mkdir(roots.fakeAgentBinRoot)
  const launcher = join(
    roots.fakeAgentBinRoot,
    process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
  )
  await writeFile(
    launcher,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${resolve('e2e/fixtures/fake-opencode.mjs')}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('e2e/fixtures/fake-opencode.mjs'))} "$@"\n`
  )
  await chmod(launcher, 0o755)
  await writeFile(
    join(roots.storageRoot, 'settings.json'),
    JSON.stringify({
      version: 1,
      opencodePath: launcher,
      opencodeVersion: '1.0.0',
      agentFramework: 'opencode',
      localePreference: 'en',
      sessionDetailsModel: { mode: 'disabled' }
    })
  )
  let app: ElectronApplication | undefined
  let desktopProcess: CapturedFixtureProcess | undefined
  let target: CapturedService | undefined
  const processes: CapturedFixtureProcess[] = []
  const agents: CapturedFixtureAgent[] = []
  const retainedReceipts = new Map<string, { path: string; source: string }>()
  const trackAgents = (service: CapturedService): CapturedFixtureAgent[] => {
    const captured = captureFixtureAgents(service)
    for (const agent of captured)
      if (!agents.some((entry) => entry.pid === agent.pid && entry.birthToken === agent.birthToken))
        agents.push(agent)
    return captured
  }
  const trackProcess = (child: ReturnType<typeof spawn>): CapturedFixtureProcess | undefined => {
    const captured = captureFixtureProcess(child)
    if (captured) processes.push(captured)
    return captured
  }
  const cleanup = async (failure?: unknown): Promise<void> => {
    let current: CapturedService | undefined
    let cleanupFailure: unknown
    const original: { pid: number; birthToken: string; alive: boolean; sameIdentity: boolean }[] =
      []
    let remainingReceipts: ReturnType<typeof remainingFixtureAgentReceipts> = []
    let receiptEvidence: 'unknown' | 'unresolved' | 'clear' = 'unknown'
    const rememberOriginal = (): void => {
      for (const { pid, birthToken } of [...processes, ...agents])
        if (!original.some((entry) => entry.pid === pid && entry.birthToken === birthToken))
          original.push({
            pid,
            birthToken,
            alive: isRuntimeProcessAlive(pid),
            sameIdentity: processBirthIdentity(pid) === birthToken
          })
    }
    try {
      await runFixtureCleanup(
        [
          async () => {
            current = await captureFixtureService(roots.storageRoot)
            if (current ?? target) trackAgents((current ?? target)!)
          },
          async () => {
            rememberOriginal()
          },
          async () => {
            if (
              !app ||
              !desktopProcess ||
              desktopProcess.child.exitCode !== null ||
              desktopProcess.child.signalCode !== null
            )
              return
            await closeElectronApplicationForCleanup(
              {
                close: () => app!.close(),
                forceClose: () => cleanupFixtureProcess(desktopProcess)
              },
              { gracefulTimeoutMs: 5000, forcedTimeoutMs: 25_000 }
            )
          },
          () => cleanupFixtureService(current),
          () => cleanupFixtureService(target),
          async () => {
            if (current ?? target) trackAgents((current ?? target)!)
            rememberOriginal()
          },
          () => runFixtureCleanup(agents.map((entry) => () => cleanupFixtureAgent(entry))),
          ...processes.map((entry) => () => cleanupFixtureProcess(entry)),
          async () => {
            remainingReceipts = remainingFixtureAgentReceipts(roots.storageRoot)
            receiptEvidence = remainingReceipts.length ? 'unresolved' : 'clear'
            for (const { path, source } of retainedReceipts.values())
              expect(await readFile(path, 'utf8')).toBe(source)
            if (
              remainingReceipts.some(
                (receipt) =>
                  receipt.namespace !== 'main-agent-process-ownership' ||
                  !retainedReceipts.has(receipt.receiptId)
              )
            )
              throw new Error(
                'Fixture agent tree/Job cleanup remains unconfirmed; preserve the root and receipts.'
              )
          }
        ],
        failure
      )
    } catch (error) {
      cleanupFailure = error
    }
    await runFixtureCleanup(
      [
        async () => {
          await writeFile(
            join(evidence, `${basename(root)}-cleanup.json`),
            JSON.stringify(
              {
                root,
                baseline,
                buildId,
                remainingReceipts,
                receiptEvidence,
                original,
                cleanupComplete: cleanupFailure === undefined,
                after: [...processes, ...agents].map(({ pid, birthToken }) => ({
                  pid,
                  birthToken,
                  alive: isRuntimeProcessAlive(pid),
                  sameIdentity: processBirthIdentity(pid) === birthToken
                }))
              },
              null,
              2
            )
          )
        }
      ],
      cleanupFailure
    )
    if (cleanupFailure !== undefined) throw cleanupFailure
    if (failure === undefined && retainedReceipts.size === 0) {
      await makeCapturedFixtureDirectoriesWritable(capturedRoot)
      await removeTreeForCleanup(root)
    }
  }
  try {
    if (stalled) {
      const server = spawn(
        process.execPath,
        [resolve('out/backend/index.cjs'), '--development', '--desktop', '--serve=0'],
        {
          env: {
            ...launchEnvironment(roots.storageRoot, roots.fakeAgentBinRoot),
            OPEN_SCIENCE_USER_DATA: roots.userDataRoot,
            NODE_OPTIONS: [
              ...(process.platform === 'darwin'
                ? [resolve('e2e/fixtures/mock-node-credentials.cjs')]
                : []),
              resolve('e2e/fixtures/runtime-relaunch-stall.cjs')
            ]
              .map((path) => `--require=${JSON.stringify(path)}`)
              .join(' ')
          },
          stdio: 'ignore'
        }
      )
      server.on('error', () => undefined)
      trackProcess(server)
      await expect
        .poll(
          async () => {
            if (server.exitCode !== null)
              throw new Error(`Fixture backend exited ${server.exitCode}: ${root}`)
            try {
              const state = JSON.parse(
                await readFile(join(roots.storageRoot, 'web-service.json'), 'utf8')
              )
              const token = (await readFile(join(roots.storageRoot, 'web-token'), 'utf8')).trim()
              return (
                await fetch(`http://127.0.0.1:${state.port}/api/bootstrap`, {
                  headers: { authorization: `Bearer ${token}` },
                  signal: AbortSignal.timeout(1000)
                })
              ).ok
            } catch {
              return false
            }
          },
          { timeout: 30000 }
        )
        .toBe(true)
    }
    app = await launchOpenScience(roots, true, false, roots.fakeRemoteItRoot, 'normal', false)
    desktopProcess = trackProcess(app.process())
    if (!desktopProcess) throw new Error('Fixture desktop child was not captured')
    const page = await app.firstWindow({ timeout: 30_000 })
    await expect
      .poll(() => page.evaluate(() => window.api.databaseStartup.getState()))
      .toMatchObject({ phase: 'ready' })
    target = await captureFixtureService(roots.storageRoot)
    if (!target) throw new Error(`Missing service identity: ${root}`)
    await app.evaluate(({ dialog }) => {
      const errors: string[] = []
      Object.assign(globalThis, { lifecycleErrors: errors })
      dialog.showErrorBox = (_title, message) => {
        errors.push(message)
      }
    })
    await page.evaluate(async () => {
      await window.api.settings.markOnboardingComplete()
      const snapshot = await window.api.settings.upsertProvider({
        type: 'custom',
        name: 'Lifecycle fixture',
        apiEndpoints: ['chat-completions'],
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'e2e-model',
        key: 'e2e-key'
      })
      const provider = snapshot.providers.find((entry) => entry.name === 'Lifecycle fixture')!
      await window.api.settings.setActiveProvider({ id: provider.id, model: 'e2e-model' })
      await window.api.settings.setAgentFramework({ id: 'opencode' })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await createProjectViaUi(page, 'Local service acceptance')
    const env = {
      ...launchEnvironment(roots.storageRoot),
      OPEN_SCIENCE_USER_DATA: roots.userDataRoot
    }
    const cli = (...args: string[]): Promise<{ stdout: string; stderr: string }> =>
      promisify(execFile)(
        process.execPath,
        [resolve('cli/index.mjs'), ...args, '--config-root', roots.storageRoot],
        { env, timeout: 40_000 }
      )
    const build = await app.evaluate(({ app }) => ({
      applicationVersion: app.getVersion(),
      executable: process.execPath,
      appPath: app.getAppPath()
    }))
    return {
      app,
      desktopProcess: desktopProcess.child,
      page,
      root,
      roots,
      target,
      env,
      cli,
      trackProcess,
      trackAgents,
      retainedReceipts,
      restart: async () => {
        app = await launchOpenScience(roots, true, false, roots.fakeRemoteItRoot, 'normal', false)
        desktopProcess = trackProcess(app.process())
        if (!desktopProcess) throw new Error('Restarted fixture desktop child was not captured')
        const page = await app.firstWindow({ timeout: 30_000 })
        await expect
          .poll(() => page.evaluate(() => window.api.databaseStartup.getState()))
          .toMatchObject({ phase: 'ready' })
        target = await captureFixtureService(roots.storageRoot)
        if (!target) throw new Error('Restarted fixture service identity was not captured')
        return { app, page, target }
      },
      cleanup,
      build: {
        baseline,
        buildId,
        ...build
      }
    }
  } catch (error) {
    await cleanup(error)
    throw error
  }
}

for (const stalled of [false, true]) {
  test(`last App quit interrupts App and CLI tasks and releases the service directory (stalled=${stalled})`, async () => {
    test.setTimeout(150_000)
    test.skip(
      stalled && Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE),
      'Shutdown fault preload exercises the source Node entry.'
    )
    const acceptanceStartedAt = Date.now()
    const f = await launchFixture(stalled)
    let failure: unknown
    try {
      await submitPromptViaUi(f.page, 'Hold the turn outcome fixture. App task A')
      await expect(
        f.page.getByText('Turn outcome cancellation checkpoint.', { exact: false })
      ).toBeVisible()
      const project = (await f.page.evaluate(() => window.api.projects.list()))[0]
      const readRuns = async (): Promise<{ id: string; projectId: string; status: string }[]> => {
        const source = await readFile(join(f.roots.storageRoot, 'task-runs.json'), 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return '{"runs":[]}'
            throw error
          }
        )
        return JSON.parse(source).runs
      }
      const existingRuns = new Set((await readRuns()).map((run) => run.id))
      const control = f.trackProcess(
        spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          env: f.env,
          stdio: 'ignore'
        })
      )
      if (!control) throw new Error('Control process failed to start')
      let spawnFailure: Error | undefined
      const cli = spawn(
        process.execPath,
        [
          resolve('cli/index.mjs'),
          'run',
          '--project',
          project.id,
          '--prompt',
          'Hold the turn outcome fixture. CLI task B',
          '--wait',
          '--json',
          '--config-root',
          f.roots.storageRoot
        ],
        { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      cli.on('error', (error) => {
        spawnFailure = error
      })
      f.trackProcess(cli)
      let stdout = ''
      let stderr = ''
      cli.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      cli.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      let cliRunId: string | undefined
      await expect
        .poll(async () => {
          if (spawnFailure) throw spawnFailure
          if (cli.exitCode !== null || cli.signalCode !== null)
            throw new Error(
              `CLI exited before the wait scenario was established (code=${cli.exitCode}, signal=${cli.signalCode}).`
            )
          const runs = (await readRuns()).filter(
            (run) =>
              !existingRuns.has(run.id) && run.projectId === project.id && run.status === 'running'
          )
          if (runs.length === 1) cliRunId = runs[0].id
          return runs.length
        })
        .toBe(1)
      const providerPromptPath = join(
        f.roots.storageRoot,
        'e2e-handoff-captures',
        'provider-prompts.jsonl'
      )
      const readProviderPrompts = async (): Promise<{ sessionId: string; prompt: string }[]> =>
        (await readFile(providerPromptPath, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      // A running TaskRun is published before its first ACP prompt reaches the Agent. Wait for
      // both original submissions so a delayed initial CLI prompt cannot look like restart replay.
      await expect
        .poll(async () => {
          const prompts = await readProviderPrompts()
          return ['App task A', 'CLI task B'].map(
            (task) =>
              prompts.filter((entry) =>
                entry.prompt.includes(`Hold the turn outcome fixture. ${task}`)
              ).length
          )
        })
        .toEqual([1, 1])
      const originalProviderPrompts = await readProviderPrompts()
      expect(originalProviderPrompts).toHaveLength(2)
      const agents = f.trackAgents(f.target)
      const injectLegacyCleanup = process.platform === 'darwin' && !stalled
      const legacyReceipts = injectLegacyCleanup
        ? new DelegatedProcessOwnership(f.roots.storageRoot, 'main-agent-process-ownership')
            .receipts()
            .filter((receipt) => receipt.phase === 'owned' && receipt.ownership?.leader?.birthToken)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 2)
        : []
      if (injectLegacyCleanup) expect(legacyReceipts).toHaveLength(2)
      expect(processBirthIdentity(f.target.pid)).toBe(f.target.birthToken)
      const processTree = await readProcessTree(f.target.pid)
      expect(processTree.complete).toBe(true)
      const knownProcesses = processTree.processes.map(({ pid, parentPid, kind }) => {
        const birthToken = processBirthIdentity(pid)
        if (!birthToken)
          throw new Error(`Known fixture process identity is unreadable (PID ${pid}).`)
        return { pid, parentPid, kind, birthToken }
      })
      await f.page.screenshot({
        animations: 'disabled',
        path: join(evidence, `active-app-cli-tasks-${stalled}.png`)
      })
      let activeShutdownStartedAt: number | undefined
      const shutdownStates: { observedAt: number; epoch: number; phase: string }[] = []
      await f.page.exposeFunction(
        'recordLifecycleShutdownProgress',
        (state: { epoch: number; phase: string }) => {
          const observedAt = Date.now()
          activeShutdownStartedAt ??= observedAt
          shutdownStates.push({ observedAt, epoch: state.epoch, phase: state.phase })
        }
      )
      await f.page.evaluate(() => {
        const record = (
          window as unknown as {
            recordLifecycleShutdownProgress(state: { epoch: number; phase: string }): Promise<void>
          }
        ).recordLifecycleShutdownProgress
        window.api.desktopRuntime!.onStateChanged((state) => {
          if (state.shutdownProgress)
            void record({ epoch: state.epoch, phase: state.phase }).catch(() => undefined)
        })
      })
      const quitRequestedAt = Date.now()
      await f.app.evaluate(({ app }) => app.quit())
      await expect(
        f.page.getByRole('button', { name: 'Stop tasks and quit', exact: true })
      ).toBeVisible()
      await f.page.screenshot({
        animations: 'disabled',
        path: join(evidence, `whole-service-quit-confirmation-${stalled}.png`)
      })
      const started = Date.now()
      const confirmedAt = started
      await f.page.getByRole('button', { name: 'Stop tasks and quit', exact: true }).click()
      if (stalled) {
        await expect(f.page.getByText('Closing Open-Science…', { exact: true })).toBeVisible({
          timeout: 5000
        })
        await f.page.screenshot({
          animations: 'disabled',
          path: join(evidence, 'stalled-active-shutdown-progress.png')
        })
      }
      await expect
        .poll(() => f.desktopProcess.exitCode !== null || f.desktopProcess.signalCode !== null, {
          timeout: 30_000
        })
        .toBe(true)
      const desktopExitObservedAt = Date.now()
      await expect.poll(() => isRuntimeProcessAlive(f.target.pid), { timeout: 25_000 }).toBe(false)
      const serviceExitObservedAt = Date.now()
      acquireRuntimeDirectorySync(f.roots.storageRoot).release()
      await expect
        .poll(() => cli.exitCode !== null || cli.signalCode !== null, { timeout: 35_000 })
        .toBe(true)
      if (spawnFailure) throw spawnFailure
      expect(cli.signalCode).toBeNull()
      const code = cli.exitCode
      const cliExitObservedAt = Date.now()
      const processEvidence = knownProcesses.map((entry) => {
        const alive = isRuntimeProcessAlive(entry.pid)
        const birthToken = alive ? processBirthIdentity(entry.pid) : undefined
        const state = !alive
          ? 'exited'
          : !birthToken
            ? 'unknown'
            : birthToken === entry.birthToken
              ? 'running'
              : 'replaced'
        return { ...entry, state, exited: state === 'exited' || state === 'replaced' }
      })
      const residualReceipts = remainingFixtureAgentReceipts(f.roots.storageRoot)
      const controlAlive =
        isRuntimeProcessAlive(control.pid) &&
        processBirthIdentity(control.pid) === control.birthToken
      await writeFile(
        join(evidence, `app-cli-quit-${stalled}.json`),
        JSON.stringify(
          {
            root: f.root,
            build: f.build,
            stalled,
            target: f.target,
            cliRunId,
            agents,
            residualReceipts,
            knownProcesses: processEvidence,
            unrelatedControl: {
              pid: control.pid,
              birthToken: control.birthToken,
              alive: controlAlive
            },
            timings: {
              acceptanceStartedAt,
              quitRequestedAt,
              confirmedAt,
              desktopExitObservedAt,
              serviceExitObservedAt,
              cliExitObservedAt,
              preflightAndConfirmationMs: confirmedAt - quitRequestedAt,
              confirmationToServiceExitMs: serviceExitObservedAt - confirmedAt,
              confirmationToCliExitMs: cliExitObservedAt - confirmedAt,
              activeShutdownStartedAt: activeShutdownStartedAt ?? null,
              activeShutdownTimingEvidence:
                activeShutdownStartedAt === undefined
                  ? 'missing'
                  : 'renderer-state.shutdownProgress observed by Node Date.now',
              confirmationToActiveStartMs:
                activeShutdownStartedAt === undefined
                  ? null
                  : activeShutdownStartedAt - confirmedAt,
              activeToDesktopExitMs:
                activeShutdownStartedAt === undefined
                  ? null
                  : desktopExitObservedAt - activeShutdownStartedAt,
              activeToServiceExitMs:
                activeShutdownStartedAt === undefined
                  ? null
                  : serviceExitObservedAt - activeShutdownStartedAt,
              shutdownStates,
              totalMs: cliExitObservedAt - acceptanceStartedAt
            },
            elapsedMs: Date.now() - started,
            cliExit: code,
            stdout,
            stderr,
            processExited: true,
            directoryLockReleased: true
          },
          null,
          2
        )
      )
      expect(code).not.toBe(0)
      expect(f.build.buildId).not.toBe('unrecorded')
      expect(
        Math.max(desktopExitObservedAt, serviceExitObservedAt, cliExitObservedAt) - confirmedAt
      ).toBeLessThan(27_000)
      expect(residualReceipts).toEqual([])
      if (activeShutdownStartedAt !== undefined)
        expect(
          Math.max(desktopExitObservedAt, serviceExitObservedAt) - activeShutdownStartedAt
        ).toBeLessThan(22_000)
      if (stalled) expect(activeShutdownStartedAt).toBeDefined()
      expect(controlAlive).toBe(true)
      expect(processEvidence.every((entry) => entry.exited)).toBe(true)
      // Node may emit environment warnings on stderr before the CLI JSON result.
      const channel = stdout.trim().startsWith('{') ? stdout : stderr
      const output = JSON.parse(channel.slice(channel.indexOf('{')))
      expect(output.error?.runId ?? output.id).toBe(cliRunId)
      expect(output.error?.completionStatus ?? output.status).toMatch(
        /unconfirmed|cancelled|failed/
      )
      if (stalled) {
        expect(
          await readFile(join(f.roots.storageRoot, 'relaunch-control-close-stalled'), 'utf8')
        ).toBe('stalled')
        expect(Date.now() - started).toBeGreaterThan(15_000)
        expect(Date.now() - started).toBeLessThan(27_000)
      }
      {
        // Recreate the two old, count-only diagnostic receipts from the actual owned launches.
        // Their leaders have exited through the real Stop tasks and quit path. No user records
        // or historical candidate identities are invented, deleted, or used as signal authority.
        for (const [index, original] of legacyReceipts.entries()) {
          expect(
            await proveRecordedPosixLeaderGone(
              original.ownership!.leader!,
              original.ownership!.token,
              original.createdAt,
              undefined,
              undefined,
              { terminateLive: false }
            )
          ).toBe('gone')
          const receipt = {
            ...original,
            phase: 'cleanup-pending',
            cleanupDiagnostics: {
              failureCategory: 'ownership-candidate-unresolved',
              recovery: 'stronger-ownership-proof-required',
              ownedIdentityCount: 5,
              ambiguousIdentityCount: index + 1
            }
          }
          const path = join(
            f.roots.storageRoot,
            'main-agent-process-ownership',
            receipt.projectId,
            receipt.sessionId,
            `${receipt.receiptId}.json`
          )
          const source = `${JSON.stringify(receipt)}\n`
          await writeFile(path, source, { flag: 'wx', mode: 0o600 })
          f.retainedReceipts.set(receipt.receiptId, { path, source })
        }
        const strictOwner = new DelegatedProcessOwnership(
          f.roots.storageRoot,
          'main-agent-process-ownership'
        )
        const assertLegacyCleanupBlocked = async (): Promise<void> => {
          for (const receipt of legacyReceipts) {
            const scope = {
              projectId: receipt.projectId,
              sessionId: receipt.sessionId,
              frameId: receipt.frameId,
              attemptId: receipt.attemptId
            }
            await expect(strictOwner.recover(scope)).rejects.toThrow(
              'Delegated process recovery is incomplete'
            )
            expect(() => strictOwner.assertClear(scope)).toThrow(
              'Delegated process cleanup is unconfirmed'
            )
          }
        }
        await assertLegacyCleanupBlocked()
        const restarted = await f.restart()
        expect(restarted.target.generation).not.toBe(f.target.generation)
        const restartObservedAt = Date.now()
        await expect
          .poll(
            async () => {
              expect(await readProviderPrompts()).toEqual(originalProviderPrompts)
              return Date.now() - restartObservedAt >= 1500
            },
            { timeout: 5000, intervals: [100, 250] }
          )
          .toBe(true)
        const interrupted = (
          await restarted.page.evaluate(() => window.api.sessions.loadAll())
        ).sessions.filter((session) =>
          session.messages.some(
            (message) =>
              message.role === 'user' && message.content.includes('Hold the turn outcome fixture.')
          )
        )
        expect(interrupted).toHaveLength(2)
        const recovered: { sessionId: string; providerSessionId: string }[] = []
        for (const session of interrupted) {
          const prompt = session.messages.find((message) => message.role === 'user')!.content
          await restarted.page
            .getByRole('region', { name: 'Recent sessions' })
            .getByRole('button', { name: prompt })
            .click()
          const before = await readProviderPrompts()
          expect(before).toHaveLength(originalProviderPrompts.length + recovered.length)
          await restarted.page.getByRole('button', { name: 'Resume session', exact: true }).click()
          await expect(
            restarted.page.getByText('Turn outcome resumed successfully.', { exact: false })
          ).toBeVisible({ timeout: 30_000 })
          await expect(restarted.page.getByTestId('resume-operation-error')).toHaveCount(0)
          const after = await readProviderPrompts()
          expect(after).toHaveLength(before.length + 1)
          const originalProvider = originalProviderPrompts.find((entry) =>
            entry.prompt.includes(prompt)
          )!
          expect(after.at(-1)!.sessionId).toBe(originalProvider.sessionId)
          expect(after.at(-1)!.prompt).toContain(
            'Continue the interrupted turn from where it stopped.'
          )
          const restored = (
            await restarted.page.evaluate(() => window.api.sessions.loadAll())
          ).sessions.find((entry) => entry.id === session.id)!
          expect(restored.providerSessionId).toBe(session.providerSessionId)
          const userTurns = (
            messages: typeof session.messages
          ): { id: string; content: string }[] =>
            messages
              .filter((message) => message.role === 'user')
              .map(({ id, content }) => ({ id, content }))
          expect(userTurns(restored.messages)).toEqual(userTurns(session.messages))
          recovered.push({ sessionId: session.id, providerSessionId: originalProvider.sessionId })
          await restarted.page.getByRole('button', { name: 'All projects', exact: true }).click()
        }
        await assertLegacyCleanupBlocked()
        for (const { path, source } of f.retainedReceipts.values())
          expect(await readFile(path, 'utf8')).toBe(source)
        await writeFile(
          join(evidence, `app-cli-restart-resume-${stalled}.json`),
          JSON.stringify(
            {
              root: f.root,
              build: f.build,
              previousGeneration: f.target.generation,
              restartedGeneration: restarted.target.generation,
              recovered,
              originalProviderPrompts,
              providerPrompts: await readProviderPrompts(),
              retainedReceiptIds: [...f.retainedReceipts.keys()],
              strictCleanupBlocked: legacyReceipts.length > 0
            },
            null,
            2
          )
        )
      }
    } catch (error) {
      failure = error
      throw error
    } finally {
      await f.cleanup(failure)
    }
  })
}

test('identityless historical cleanup blocks only old context restoration while fresh conversations remain usable', async () => {
  test.setTimeout(150_000)
  const f = await launchFixture()
  let failure: unknown
  try {
    const prompt = 'Hold the turn outcome fixture. Identityless'
    await submitPromptViaUi(f.page, prompt)
    await expect(
      f.page.getByText('Turn outcome cancellation checkpoint.', { exact: false })
    ).toBeVisible()
    f.trackAgents(f.target)
    const receipts = new DelegatedProcessOwnership(
      f.roots.storageRoot,
      'main-agent-process-ownership'
    ).receipts()
    const original = receipts.find((receipt) => receipt.phase === 'owned')
    expect(original?.ownership?.token).toBeTruthy()
    if (process.platform !== 'win32') expect(original?.ownership?.leader?.birthToken).toBeTruthy()
    if (!original) throw new Error('Fixture did not publish an owned agent receipt')
    const providerPromptPath = join(
      f.roots.storageRoot,
      'e2e-handoff-captures',
      'provider-prompts.jsonl'
    )
    const readProviderPrompts = async (): Promise<{ sessionId: string; prompt: string }[]> =>
      (await readFile(providerPromptPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    const beforeQuitPrompts = await readProviderPrompts()
    await f.app.evaluate(({ app }) => app.quit())
    await f.page.getByRole('button', { name: 'Stop tasks and quit', exact: true }).click()
    await expect
      .poll(() => f.desktopProcess.exitCode !== null || f.desktopProcess.signalCode !== null, {
        timeout: 30_000
      })
      .toBe(true)
    await expect.poll(() => isRuntimeProcessAlive(f.target.pid), { timeout: 25_000 }).toBe(false)
    acquireRuntimeDirectorySync(f.roots.storageRoot).release()
    expect(remainingFixtureAgentReceipts(f.roots.storageRoot)).toEqual([])

    // Reproduce a crash between durable starting publication and process identity publication.
    // This record carries no signal authority. Keep it byte-for-byte; never invent a PID or
    // remove evidence merely to let recovery or fixture cleanup pass.
    const retained = { ...original, phase: 'starting', ownership: undefined }
    const path = join(
      f.roots.storageRoot,
      'main-agent-process-ownership',
      retained.projectId,
      retained.sessionId,
      `${retained.receiptId}.json`
    )
    const source = `${JSON.stringify(retained)}\n`
    await writeFile(path, source, { flag: 'wx', mode: 0o600 })
    f.retainedReceipts.set(retained.receiptId, { path, source })

    const restarted = await f.restart()
    expect(restarted.target.generation).not.toBe(f.target.generation)
    await expect
      .poll(() => restarted.page.evaluate(() => window.api.desktopRuntime!.getState()))
      .toMatchObject({ phase: 'connected' })
    expect(await readProviderPrompts()).toEqual(beforeQuitPrompts)
    const historical = (
      await restarted.page.evaluate(() => window.api.sessions.loadAll())
    ).sessions.find((session) =>
      session.messages.some((message) => message.role === 'user' && message.content === prompt)
    )
    if (!historical) throw new Error('Interrupted fixture Session was not persisted')
    await restarted.page
      .getByRole('region', { name: 'Recent sessions' })
      .getByRole('button', { name: prompt })
      .click()
    for (let attempt = 0; attempt < 2; attempt++) {
      await restarted.page.getByRole('button', { name: 'Resume session', exact: true }).click()
      await expect(restarted.page.getByTestId('resume-operation-error')).toContainText(
        'Previous agent cleanup could not be confirmed. Your conversation is preserved. You can start a new conversation or retry Resume.'
      )
      expect(await readProviderPrompts()).toEqual(beforeQuitPrompts)
      expect(await readFile(path, 'utf8')).toBe(source)
    }
    const unchanged = (
      await restarted.page.evaluate(() => window.api.sessions.loadAll())
    ).sessions.find((session) => session.id === historical.id)!
    expect(unchanged.providerSessionId).toBe(historical.providerSessionId)
    expect(unchanged.messages.filter((message) => message.role === 'user')).toEqual(
      historical.messages.filter((message) => message.role === 'user')
    )

    await restarted.page.getByRole('button', { name: 'All projects', exact: true }).click()
    await createProjectViaUi(restarted.page, 'Fresh conversation with retained cleanup evidence')
    await submitPromptViaUi(restarted.page, 'Summarize the deterministic fixture.')
    await expect(
      restarted.page.getByText('Deterministic reply: Summarize the deterministic fixture.', {
        exact: false
      })
    ).toBeVisible({ timeout: 30_000 })
    const after = await readProviderPrompts()
    expect(after).toHaveLength(beforeQuitPrompts.length + 1)
    expect(after.at(-1)!.sessionId).not.toBe(beforeQuitPrompts[0].sessionId)
    expect(after.at(-1)!.prompt).toContain('Summarize the deterministic fixture.')
    expect(await readFile(path, 'utf8')).toBe(source)
    await writeFile(
      join(evidence, 'identityless-receipt-restart-isolation.json'),
      JSON.stringify(
        {
          root: f.root,
          build: f.build,
          previousGeneration: f.target.generation,
          restartedGeneration: restarted.target.generation,
          historicalSessionId: historical.id,
          historicalProviderSessionId: historical.providerSessionId,
          retainedReceiptIds: [...f.retainedReceipts.keys()],
          beforeQuitPrompts,
          providerPrompts: after,
          explicitResumeRejections: 2,
          freshConversationSucceeded: true,
          retainedEvidenceUnchanged: true
        },
        null,
        2
      )
    )
  } catch (error) {
    failure = error
    throw error
  } finally {
    await f.cleanup(failure)
  }
})

test('repeated disconnects preserve drafts; force stop never automatically revives the service', async () => {
  test.setTimeout(150_000)
  const f = await launchFixture()
  let failure: unknown
  try {
    const composer = f.page.getByRole('textbox', { name: 'Ask anything' })
    await composer.fill('Unsent lifecycle acceptance draft')
    const reconnectTransitions: {
      beforeEpoch: number
      afterEpoch: number
      generation: string
      pipe: { url: string; destroyed: boolean }
    }[] = []
    for (let round = 0; round < 3; round++) {
      const before = await f.page.evaluate(() => window.api.desktopRuntime!.getState())
      expect(before.phase).toBe('connected')
      const serviceBefore = await captureFixtureService(f.roots.storageRoot)
      expect(serviceBefore?.generation).toBe(f.target.generation)
      await composer.focus()
      const pipe = await f.app.evaluate(disconnectFixtureServiceConnection)
      expect(pipe).toMatchObject({ url: 'ws://localhost/desktop', destroyed: true })
      await expect
        .poll(
          async () => {
            const after = await f.page.evaluate(() => window.api.desktopRuntime!.getState())
            const current = await captureFixtureService(f.roots.storageRoot)
            return hasFixtureReconnected(before, after, f.target.generation, current?.generation)
          },
          { timeout: 18_000 }
        )
        .toBe(true)
      const after = await f.page.evaluate(() => window.api.desktopRuntime!.getState())
      const current = await captureFixtureService(f.roots.storageRoot)
      expect(hasFixtureReconnected(before, after, f.target.generation, current?.generation)).toBe(
        true
      )
      reconnectTransitions.push({
        beforeEpoch: before.epoch,
        afterEpoch: after.epoch,
        generation: current!.generation,
        pipe
      })
      await expect(composer).toHaveText('Unsent lifecycle acceptance draft')
      await expect(composer).toBeFocused()
      expect(
        await f.app.evaluate(
          () => (globalThis as unknown as { lifecycleErrors: string[] }).lifecycleErrors
        )
      ).toEqual([])
    }
    const start = await f.cli('start', '--no-open')
    const status = await f.cli('status', '--json')
    expect(JSON.parse(status.stdout).lifetime.explicit).toBe(true)
    const revoke = await f.cli('stop', '--json')
    expect(JSON.parse(revoke.stdout).result).toBe('keep-alive-revoked')
    expect(isRuntimeProcessAlive(f.target.pid)).toBe(true)
    f.trackAgents(f.target)
    const force = await f.cli('stop', '--force', '--json')
    await expect(f.page.getByTestId('local-service-recovery')).toBeVisible()
    await expect(f.page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible({
      timeout: 18_000
    })
    await f.page.screenshot({
      animations: 'disabled',
      path: join(evidence, 'force-stop-recovery-notice.png')
    })
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
    expect(isRuntimeProcessAlive(f.target.pid)).toBe(false)
    expect(await f.page.evaluate(() => window.api.desktopRuntime!.getState())).toMatchObject({
      phase: 'unavailable'
    })
    await writeFile(
      join(evidence, 'disconnect-force-stop.json'),
      JSON.stringify(
        {
          root: f.root,
          build: f.build,
          target: f.target,
          reconnects: reconnectTransitions.length,
          reconnectTransitions,
          nativeErrors: await f.app.evaluate(
            () => (globalThis as unknown as { lifecycleErrors: string[] }).lifecycleErrors
          ),
          start,
          status,
          revoke,
          force,
          processExited: true
        },
        null,
        2
      )
    )
  } catch (error) {
    failure = error
    throw error
  } finally {
    await f.cleanup(failure)
  }
})

test('restarts after proven service exit and stops automatic recovery on the third crash', async () => {
  test.setTimeout(150_000)
  const f = await launchFixture()
  let failure: unknown
  try {
    const composer = f.page.getByRole('textbox', { name: 'Ask anything' })
    await composer.fill('Draft kept across service restart')
    const generations: string[] = []
    const restartTransitions: {
      fromGeneration: string
      toGeneration: string
      pid: number
      beforeEpoch: number
      afterEpoch: number
    }[] = []
    for (let crash = 1; crash <= 3; crash++) {
      const target = await captureFixtureService(f.roots.storageRoot)
      if (!target) throw new Error('Fixture service disappeared before crash injection')
      generations.push(target.generation)
      const before = await f.page.evaluate(() => window.api.desktopRuntime!.getState())
      expect(before.phase).toBe('connected')
      await composer.focus()
      expect(processBirthIdentity(target.pid)).toBe(target.birthToken)
      f.trackAgents(target)
      process.kill(target.pid, 'SIGKILL')
      await expect.poll(() => isRuntimeProcessAlive(target.pid)).toBe(false)
      if (crash < 3) {
        let replacement: CapturedService | undefined
        await expect
          .poll(
            async () => {
              const next = await captureFixtureService(f.roots.storageRoot)
              if (!next || next.generation === target.generation) return false
              replacement = next
              return true
            },
            { timeout: 20000 }
          )
          .toBe(true)
        if (!replacement) throw new Error('New fixture service was not captured after crash')
        const next = replacement
        let after = before
        await expect
          .poll(
            async () => {
              after = await f.page.evaluate(() => window.api.desktopRuntime!.getState())
              return (
                after.phase === 'connected' &&
                after.epoch > before.epoch &&
                after.restartedGeneration === next.generation
              )
            },
            { timeout: 20000 }
          )
          .toBe(true)
        expect((await captureFixtureService(f.roots.storageRoot))?.generation).toBe(next.generation)
        restartTransitions.push({
          fromGeneration: target.generation,
          toGeneration: next.generation,
          pid: next.pid,
          beforeEpoch: before.epoch,
          afterEpoch: after.epoch
        })
      } else {
        await expect(f.page.getByTestId('local-service-recovery')).toBeVisible()
        await expect
          .poll(() => f.page.evaluate(() => window.api.desktopRuntime!.getState()), {
            timeout: 20000
          })
          .toMatchObject({ phase: 'unavailable' })
        await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
        expect(await captureFixtureService(f.roots.storageRoot)).toBeUndefined()
      }
      await expect(composer).toHaveText('Draft kept across service restart')
      await expect(composer).toBeFocused()
    }
    await f.page.screenshot({
      animations: 'disabled',
      path: join(evidence, 'third-crash-recovery.png')
    })
    const nativeErrors = await f.app.evaluate(
      () => (globalThis as unknown as { lifecycleErrors: string[] }).lifecycleErrors
    )
    expect(nativeErrors).toEqual([])
    await writeFile(
      join(evidence, 'crash-recovery.json'),
      JSON.stringify(
        {
          root: f.root,
          build: f.build,
          generations,
          restarts: restartTransitions.length,
          restartTransitions,
          nativeErrors
        },
        null,
        2
      )
    )
  } catch (error) {
    failure = error
    throw error
  } finally {
    await f.cleanup(failure)
  }
})

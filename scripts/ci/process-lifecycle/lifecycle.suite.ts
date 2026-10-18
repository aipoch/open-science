/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import { LifecycleObserver, identityKey } from './observer.mjs'
import { runVerificationProcess } from '../../../src/main/update/verification-process'
import { DelegatedProcessOwnership } from '../../../src/main/delegation/process-ownership'
import {
  registerOwnedPosixProcessGroup,
  terminateProcessTree
} from '../../../src/main/process-tree'
import { KernelProcessLifecycleOwner } from '../../../src/main/notebook/kernel-process-lifecycle.windows-posix'
import { ShellProcessOwnershipRegistry } from '../../../src/main/notebook/shell-process-ownership.windows-posix'
import { startOrAttachDesktopBackend } from '../../../src/main/desktop-runtime-launcher'
import { connectDesktopRuntime } from '../../../src/main/desktop-runtime-client'
import {
  ConnectorSettingsWorkflows,
  type ConnectorSettingsWorkflowStore,
  type ConnectorSettingsWorkflowEffects
} from '../../../src/main/settings/workflows/connectors'

// The dedicated configuration discovers this suite; the runner supplies Python and validates
// all scenario evidence. Accidental direct execution must fail instead of reporting skipped tests.
if (process.env.RUN_PROCESS_LIFECYCLE !== '1' || !process.env.LIFECYCLE_RUN_ID) {
  throw new Error('Run lifecycle checks with node scripts/ci/process-lifecycle/run.mjs core')
}

async function scenario(
  name: string,
  body: (context: { root: string; observer: LifecycleObserver }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-'))
  const observer = new LifecycleObserver(name)
  let failure: unknown
  try {
    await observer.start()
    await body({ root, observer })
  } catch (error) {
    failure = error
  } finally {
    try {
      await observer.finish(failure !== undefined)
    } catch (error) {
      failure ??= error
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  if (failure !== undefined) throw failure
}

async function fixture(root: string, code: string, name = 'workload') {
  const entry = join(root, `${name}.cjs`),
    ready = join(root, `${name}.ready`),
    release = join(root, `${name}.release`)
  await writeFile(
    entry,
    `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
const waiting = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(waiting);
  ${code}
}, 20);
`
  )
  return {
    entry,
    async observe(observer: LifecycleObserver, pid?: number, minimum = 1, ownership = 'owned') {
      await vi.waitFor(
        async () => expect(Number(await readFile(ready, 'utf8'))).toBeGreaterThan(0),
        { timeout: 10000 }
      )
      const actual = Number(await readFile(ready, 'utf8'))
      const identity = await observer.observe(pid ?? actual, ownership, minimum)
      expect([...observer.seen.values()].some((record) => record.pid === actual)).toBe(true)
      return identity
    },
    release: () => writeFile(release, '')
  }
}

describe('scheduled source process lifecycle', () => {
  for (const mode of ['normal', 'failure', 'cancel', 'timeout'] as const) {
    it(
      `verification-${mode}`,
      () =>
        scenario(`verification-${mode}`, async ({ root, observer }) => {
          const target = await fixture(
            root,
            mode === 'normal'
              ? 'process.exit(0)'
              : mode === 'failure'
                ? 'process.exit(7)'
                : 'setInterval(() => {}, 1000)'
          )
          const controller = new AbortController()
          const pending = runVerificationProcess(process.execPath, [target.entry], {
            signal: controller.signal,
            timeoutMs: mode === 'timeout' ? 3000 : 15000
          }).then(
            (value) => ({ value }),
            (error) => ({ error })
          )
          await target.observe(observer)
          await target.release()
          if (mode === 'cancel') controller.abort(new Error('lifecycle-cancel'))
          const result = await pending
          if (mode === 'normal') expect(result).toHaveProperty('value')
          else
            expect(String('error' in result ? result.error : '')).toContain(
              mode === 'failure' ? 'exit 7' : mode === 'cancel' ? 'lifecycle-cancel' : 'time limit'
            )
          await observer.checkpoint('product-stop')
        }),
      30000
    )
  }

  for (const mode of ['normal', 'cancel', 'timeout'] as const) {
    it(
      `mcp-${mode}`,
      () =>
        scenario(`mcp-${mode}`, async ({ root, observer }) => {
          const target = await fixture(
            root,
            mode === 'normal'
              ? `
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (!('id' in request)) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`
              : 'setInterval(() => {}, 1000)'
          )
          const workflow = new ConnectorSettingsWorkflows(
            {
              getConnectors: async () => ({
                customMcpServers: [
                  {
                    id: 'fixture',
                    name: 'fixture',
                    displayName: 'Fixture',
                    enabled: false,
                    transport: 'stdio',
                    command: process.execPath,
                    args: [target.entry]
                  }
                ]
              }),
              saveCustomServerOAuthState: vi.fn()
            } as unknown as ConnectorSettingsWorkflowStore,
            {} as ConnectorSettingsWorkflowEffects
          )
          const controller = new AbortController()
          const pending = workflow.testCustomServer({ id: 'fixture' }, controller.signal)
          await target.observe(observer)
          await target.release()
          if (mode === 'cancel') controller.abort()
          expect(await pending).toMatchObject({
            success: mode === 'normal',
            code: mode === 'normal' ? 'ok' : mode === 'cancel' ? 'cancelled' : 'timeout'
          })
          // Diagnostic completion promises cleanup; a grace period here would hide the pending
          // stdio close race. The manager must join pending connection and transport cleanup.
          await observer.checkpoint('diagnostic-returned', { timeoutMs: 0 })
        }),
      30000
    )
  }

  for (const recovery of [false, true]) {
    const name = recovery ? 'agent-recovery' : 'agent-stop'
    it(
      name,
      () =>
        scenario(name, async ({ root, observer }) => {
          const descendant = await fixture(root, 'setInterval(() => {}, 1000)', 'descendant')
          const target = await fixture(
            root,
            `require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant.entry)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
          )
          const owner = new DelegatedProcessOwnership(root)
          const scope = {
            projectId: 'project',
            sessionId: 'session',
            frameId: 'frame',
            attemptId: 'attempt',
            frameworkId: 'codex'
          }
          const child = owner.spawn(scope, process.execPath, [target.entry], {
            stdio: 'pipe',
            env: process.env,
            windowsHide: true
          })
          await target.observe(observer, child.pid)
          await target.release()
          await descendant.observe(observer, child.pid, 2)
          await descendant.release()
          if (recovery) await new DelegatedProcessOwnership(root).recover(scope, true)
          else expect(await terminateProcessTree(child)).toMatchObject({ reaped: true })
          await observer.checkpoint('agent-tree-stopped')
        }),
      30000
    )
  }

  it(
    'kernel-host-stop',
    () =>
      scenario('kernel-host-stop', async ({ root, observer }) => {
        const target = await fixture(root, 'process.exit(0)')
        const owner = new KernelProcessLifecycleOwner({ storageRoot: root })
        const intent = owner.beginSpawn({
          laneKey: 'lane',
          processKey: 'repl',
          kernelEpochId: 'epoch'
        })
        const host = spawn(
          process.execPath,
          [
            resolve('resources/notebook/kernel_process_host.js'),
            intent.path,
            intent.record.receiptId,
            process.execPath,
            target.entry
          ],
          { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
        )
        await target.observe(observer, host.pid, 2)
        await target.release()
        await observer.checkpoint('kernel-host-and-workload-exited')
      }),
    30000
  )

  it(
    'shell-recovery',
    () =>
      scenario('shell-recovery', async ({ root, observer }) => {
        const target = await fixture(root, 'setInterval(() => {}, 1000)')
        const registry = new ShellProcessOwnershipRegistry(root)
        const launch = registry.beginLaunch({
          runId: 'run',
          projectId: 'project',
          sessionId: 'session',
          platform: process.platform,
          hosted: process.platform === 'win32'
        })
        const host = launch.host
        const child = host
          ? spawn(
              process.execPath,
              [host.path, host.pendingPath, host.receiptId, process.execPath, target.entry],
              { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
            )
          : spawn(
              '/bin/sh',
              ['-c', '"$1" "$2"', 'lifecycle-shell', process.execPath, target.entry],
              { detached: true, stdio: 'ignore' }
            )
        if (!host) {
          registerOwnedPosixProcessGroup(child)
          launch.claim(child, process.platform)
        }
        await target.observe(observer, child.pid)
        await target.release()
        await new ShellProcessOwnershipRegistry(root).recover()
        await observer.checkpoint('shell-recovered')
      }),
    30000
  )

  it(
    'backend-startup-failure',
    () =>
      scenario('backend-startup-failure', async ({ root, observer }) => {
        const target = await fixture(root, 'process.exit(7)')
        const pending = startOrAttachDesktopBackend({
          configRoot: root,
          profilePath: join(root, 'profile'),
          version: 'test',
          command: process.execPath,
          entry: target.entry,
          packaged: false,
          timeoutMs: 15000
        }).catch((error) => error)
        await target.observe(observer)
        await target.release()
        expect(await pending).toBeInstanceOf(Error)
        await observer.checkpoint('failed-start-exited')
      }),
    30000
  )

  for (const borrowed of [false, true]) {
    const name = borrowed ? 'runtime-borrowed' : 'runtime-owned-generations'
    it(
      name,
      () =>
        scenario(name, async ({ root, observer }) => {
          const endpointFile = join(root, 'endpoint.json'),
            stopFile = join(root, 'owner-stop')
          const entry = join(root, 'runtime.cjs')
          await build({
            stdin: {
              contents: `
import { startDesktopRuntimeTransport } from './src/main/desktop-runtime-transport';
import { ApplicationEventHub } from './src/main/application-events';
import { writeRuntimeExit } from './src/main/runtime-stop-confirmation';
import { randomUUID } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
async function main() {
  const generation = randomUUID(), configRoot = ${JSON.stringify(root)};
  const stop = async () => { await host.close(); await writeRuntimeExit(configRoot, {generation, pid: process.pid, outcome: 'clean'}); process.exit(0); };
  const host = await startDesktopRuntimeTransport({ version: 'test', generation, startupOptions: {configRoot, dataRoot: configRoot, profilePath: configRoot, host: '127.0.0.1', port: 0, credentialStore: 'os'}, launch: ${JSON.stringify(borrowed ? 'cli' : 'desktop')}, events: new ApplicationEventHub(), commands: { commandNames: () => ['ping'], invoke: async () => 'pong' }, requestShutdown: () => { void stop(); } });
  writeFileSync(${JSON.stringify(endpointFile)}, JSON.stringify({pid: process.pid, endpoint: host.endpoint}));
  setInterval(() => { if (existsSync(${JSON.stringify(stopFile)})) void stop(); }, 50);
} main().catch(() => process.exit(1));`,
              resolveDir: process.cwd()
            },
            outfile: entry,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            packages: 'external',
            banner: {
              js: `require = require('node:module').createRequire(${JSON.stringify(resolve('package.json'))});`
            }
          })
          const generations = borrowed ? 1 : 2
          for (let generation = 0; generation < generations; generation++) {
            await rm(endpointFile, { force: true })
            const child = spawn(process.execPath, [entry], { stdio: 'ignore' })
            const identity = await observer.observe(child.pid, borrowed ? 'borrowed' : 'owned')
            await vi.waitFor(
              async () =>
                expect(JSON.parse(await readFile(endpointFile, 'utf8')).pid).toBe(child.pid),
              { timeout: 10000 }
            )
            const { endpoint } = JSON.parse(await readFile(endpointFile, 'utf8'))
            const client = await connectDesktopRuntime({
              endpoint,
              desktopInstanceId: randomUUID(),
              onEvent: vi.fn(),
              onDisconnect: vi.fn()
            })
            try {
              expect(await client.invoke(randomUUID(), 'ping', [])).toBe('pong')
              const lease = await client.quit()
              lease?.release()
              if (borrowed) {
                await observer.checkpoint('borrowed-survives-detach', {
                  surviving: [identityKey(identity)]
                })
                const next = await connectDesktopRuntime({
                  endpoint,
                  onEvent: vi.fn(),
                  onDisconnect: vi.fn()
                })
                try {
                  expect(await next.invoke(randomUUID(), 'ping', [])).toBe('pong')
                } finally {
                  next.close()
                }
                await writeFile(stopFile, '') // The fixture owner, after the survival assertion.
              }
              await observer.checkpoint(`generation-${generation}-exited`)
            } finally {
              client.close()
            }
          }
        }),
      30000
    )
  }
})

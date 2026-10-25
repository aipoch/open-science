import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import { createDevSession } from './dev-session.mjs'
import { inspectDevProcess, signalDevProcess } from './dev-process-identity.mjs'
import { acquireRuntimeDirectorySync } from '../src/main/runtime-ownership'
import { joinDevSession } from '../src/main/dev-runtime-session'

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; buildId: string; entry: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dev-owned-backend-')))
  roots.push(root)
  const buildId = randomUUID()
  const entry = join(root, 'out/backend/index.cjs')
  await mkdir(join(root, 'out/backend'), { recursive: true })
  await writeFile(
    join(root, 'out/backend/dev-build.json'),
    JSON.stringify({ buildId, workspaceRoot: root })
  )
  await build({
    stdin: {
      contents: `
        import { joinDevSession, readDevSession } from './src/main/dev-runtime-session';
        import { acquireRuntimeDirectorySync } from './src/main/runtime-ownership';
        import { writeFileSync, existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { randomUUID } from 'node:crypto';
        const configRoot = ${JSON.stringify(join(root, 'config'))};
        const generation = randomUUID();
        const lease = acquireRuntimeDirectorySync(configRoot);
        const hold = setInterval(() => {}, 1000);
        let session;
        const stop = async () => {
            if (process.env.FIXTURE_MODE === 'hung') return new Promise(() => {});
            if (process.env.FIXTURE_MODE === 'save-guard' && !existsSync(join(configRoot, 'saved')))
              throw new Error('Backend stopped before desktop saved.');
            writeFileSync(join(configRoot, 'runtime-exit.json'), JSON.stringify({ pid: process.pid, generation, outcome: process.env.FIXTURE_MODE === 'failed' ? 'failed' : 'clean' }));
            lease.release(); clearInterval(hold); session?.close();
        };
        const registrationGate = process.env.FIXTURE_MODE === 'wait-registration'
          ? new Promise(resolve => process.once('message', resolve)) : Promise.resolve();
        registrationGate.then(() => joinDevSession({
          session: readDevSession(true), build: ${JSON.stringify({ buildId, workspaceRoot: root })}, configRoot, generation, stop
        })).then(value => {
          session = value;
          console.log('READY');
          if (process.env.FIXTURE_MODE === 'self-stop') setTimeout(stop, 100);
          if (process.env.FIXTURE_MODE === 'blocked') while (true) {}
        }).catch(error => { console.error(error); lease.release(); clearInterval(hold); process.exitCode = 1; });
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: entry
  })
  return { root, buildId, entry }
}

async function start(entry: string, environment: string, mode = 'clean'): Promise<ChildProcess> {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    env: { ...process.env, OPEN_SCIENCE_DEV_SESSION: environment, FIXTURE_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(child)
  let errors = ''
  child.stderr!.on('data', (chunk) => {
    errors += chunk.toString()
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) resolve()
    })
    child.once('exit', () => reject(new Error(`Fixture exited before readiness: ${errors}`)))
    child.once('error', reject)
  })
  return child
}

async function desktopFixture(root: string): Promise<void> {
  await build({
    stdin: {
      contents: `
        import { joinDevSession, readDevSession } from './src/main/dev-runtime-session';
        const hold = setInterval(() => {}, 1000);
        let connection;
        joinDevSession({
          session: readDevSession(true),
          desktopOnly: true,
          stop: async () => {
            if (process.env.FIXTURE_MODE === 'hung') return new Promise(() => {});
            clearInterval(hold); connection?.close();
          }
        }).then(value => { connection = value; console.log('READY'); })
          .catch(error => { console.error(error); process.exit(1); });
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(root, 'index.js')
  })
}

it.each(['clean', 'hung'])(
  'stops a %s startup desktop during rebuild without owning the conflicting backend',
  async (mode) => {
    const { root, entry } = await fixture()
    await desktopFixture(root)
    const foreign = await createDevSession({ root, graceMs: 1000, log: () => {} })
    const current = await createDevSession({ root, graceMs: 300, settleMs: 2000, log: () => {} })
    try {
      const backend = await start(entry, foreign.environment)
      await rm(join(root, 'out/backend/dev-build.json'))
      const desktop = await start(root, current.environment, mode)
      expect(await current.stop()).toEqual({ clean: mode === 'clean', stopped: 0 })
      expect(await inspectDevProcess(desktop.pid)).toBeUndefined()
      expect(await inspectDevProcess(backend.pid)).toBeDefined()
    } finally {
      await current.stop()
      await foreign.stop()
    }
  }
)

it.each(['clean', 'failed', 'hung', 'blocked'])(
  'stops a real detached backend after %s cleanup',
  async (mode) => {
    const { root, entry } = await fixture()
    const session = await createDevSession({ root, graceMs: 250, settleMs: 2000, log: () => {} })
    try {
      const child = await start(entry, session.environment, mode)
      const result = await session.stop()
      expect(await inspectDevProcess(child.pid)).toBeUndefined()
      const lease = acquireRuntimeDirectorySync(join(root, 'config'))
      lease.release()
      expect(result).toEqual({ clean: mode === 'clean', stopped: 1 })
      expect(session.stop()).toBe(session.stop())
    } finally {
      await session.stop()
    }
  }
)

it('does not signal a PID whose birth identity changed', async () => {
  const { root, entry } = await fixture()
  const session = await createDevSession({ root, graceMs: 1000, log: () => {} })
  try {
    const child = await start(entry, session.environment)
    expect(
      await signalDevProcess(child.pid, 'old-birth', 'SIGKILL', async () => ({
        birth: 'new-birth'
      }))
    ).toBe(false)
    expect(child.exitCode).toBeNull()
    await session.stop()
  } finally {
    await session.stop()
  }
})

it('tracks a spawned backend before it initializes ownership or its lifetime connection', async () => {
  const { root, entry, buildId } = await fixture()
  await writeFile(entry, 'setInterval(() => {}, 1000)')
  const session = await createDevSession({ root, graceMs: 150, settleMs: 2000, log: () => {} })
  const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' })
  children.push(child)
  try {
    await once(child, 'spawn')
    const notification = await joinDevSession({
      session: JSON.parse(session.environment),
      build: { buildId, workspaceRoot: root },
      configRoot: join(root, 'config'),
      backendPid: child.pid,
      stop: async () => {}
    })
    notification.close()
    expect(await session.stop()).toEqual({ stopped: 1, clean: false })
    expect(await inspectDevProcess(child.pid)).toBeUndefined()
  } finally {
    await session.stop()
  }
})

it('does not lose backend lifetime registration when the spawn notification arrives later', async () => {
  const { root, entry, buildId } = await fixture()
  const session = await createDevSession({ root, graceMs: 1000, log: () => {} })
  try {
    const child = await start(entry, session.environment)
    const notification = await joinDevSession({
      session: JSON.parse(session.environment),
      build: { buildId, workspaceRoot: root },
      configRoot: join(root, 'config'),
      backendPid: child.pid,
      stop: async () => {}
    })
    notification.close()
    expect(await session.stop()).toEqual({ stopped: 1, clean: true })
  } finally {
    await session.stop()
  }
})

it('merges concurrent spawn and backend registrations without losing the lifetime connection', async () => {
  const { root, entry, buildId } = await fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let inspecting!: () => void
  const inspected = new Promise<void>((resolve) => {
    inspecting = resolve
  })
  let blocked = false
  const session = await createDevSession({
    root,
    graceMs: 1500,
    log: () => {},
    inspect: async (pid: number) => {
      if (pid !== process.pid && !blocked) {
        blocked = true
        inspecting()
        await gate
      }
      return inspectDevProcess(pid)
    }
  })
  const child = spawn(process.execPath, [entry], {
    detached: true,
    env: {
      ...process.env,
      OPEN_SCIENCE_DEV_SESSION: session.environment,
      FIXTURE_MODE: 'wait-registration'
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  children.push(child)
  const ready = new Promise<void>((resolve) => {
    child.stdout!.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) resolve()
    })
  })
  try {
    const notification = joinDevSession({
      session: JSON.parse(session.environment),
      build: { buildId, workspaceRoot: root },
      configRoot: join(root, 'config'),
      backendPid: child.pid,
      stop: async () => {}
    })
    await inspected
    child.send('register')
    // Without serialization the backend can be admitted while the spawn inspection is
    // paused; releasing it then overwrites the already registered lifetime socket/generation.
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 1000))])
    release()
    const desktop = await notification
    await ready
    child.disconnect()
    desktop.close()
    expect(await session.stop()).toEqual({ clean: true, stopped: 1 })
  } finally {
    release()
    await session.stop()
  }
})

async function startRunner(root: string): Promise<{ runner: ChildProcess; environment: string }> {
  const serverModule = new URL('./dev-session.mjs', import.meta.url).href
  const runner = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createDevSession } from ${JSON.stringify(serverModule)};
    const session = await createDevSession({ root: ${JSON.stringify(root)} });
    process.on('SIGTERM', async () => {
      const result = await session.stop(); process.exit(result.clean ? 0 : 1);
    });
    process.stdout.write(session.environment + '\\n');
  `
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  children.push(runner)
  const environment = await new Promise<string>((resolve, reject) => {
    let value = ''
    runner.stdout!.on('data', (chunk) => {
      value += chunk
      if (value.includes('\n')) resolve(value.trim())
    })
    runner.once('exit', () => reject(new Error('Runner fixture exited early.')))
  })
  return { runner, environment }
}

it('stops only its startup desktop when the runner PID alone receives SIGTERM', async () => {
  const { root, entry } = await fixture()
  await desktopFixture(root)
  const foreign = await createDevSession({ root, graceMs: 1000, log: () => {} })
  try {
    const backend = await start(entry, foreign.environment)
    const { runner, environment } = await startRunner(root)
    const desktop = await start(root, environment)
    const exited = once(runner, 'exit')
    runner.kill('SIGTERM')
    expect(await exited).toEqual(process.platform === 'win32' ? [null, 'SIGTERM'] : [0, null])
    await vi.waitFor(async () => expect(await inspectDevProcess(desktop.pid)).toBeUndefined(), {
      timeout: 5000
    })
    expect(await inspectDevProcess(backend.pid)).toBeDefined()
  } finally {
    await foreign.stop()
  }
})

it('stops on loss of the runner even when no Electron process remains', async () => {
  const { root, entry } = await fixture()
  const { runner, environment } = await startRunner(root)
  const child = await start(entry, environment)
  const exited = once(child, 'exit')
  runner.kill('SIGKILL')
  await exited
  expect(await inspectDevProcess(child.pid)).toBeUndefined()
  expect(JSON.parse(await readFile(join(root, 'config/runtime-exit.json'), 'utf8')).outcome).toBe(
    'clean'
  )
})

it('does not affect a detached backend belonging to another live session', async () => {
  const first = await fixture()
  const second = await fixture()
  const a = await createDevSession({ root: first.root, graceMs: 1000, log: () => {} })
  const b = await createDevSession({ root: second.root, graceMs: 1000, log: () => {} })
  try {
    const childA = await start(first.entry, a.environment)
    const childB = await start(second.entry, b.environment)
    await a.stop()
    expect(await inspectDevProcess(childA.pid)).toBeUndefined()
    expect(await inspectDevProcess(childB.pid)).toBeDefined()
  } finally {
    await Promise.all([a.stop(), b.stop()])
  }
})

it('preserves clean exit evidence across two backend generations in the same dev invocation', async () => {
  const { root, entry } = await fixture()
  const session = await createDevSession({ root, graceMs: 1000, log: () => {} })
  try {
    const first = await start(entry, session.environment, 'self-stop')
    await once(first, 'exit')
    await start(entry, session.environment)
    expect(await session.stop()).toEqual({ clean: true, stopped: 2 })
  } finally {
    await session.stop()
  }
})

it.each([false, true])(
  'lets Desktop finish a slow save after replacement=%s',
  async (replace) => {
    const { root, entry, buildId } = await fixture()
    const desktopEntry = join(root, 'desktop.cjs')
    await build({
      stdin: {
        contents: `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { joinDevSession, readDevSession } from './src/main/dev-runtime-session';
      (async () => {
      const session = readDevSession(true);
      const replacementPid = Number(process.env.REPLACEMENT_BACKEND_PID);
      await joinDevSession({ session, desktopOnly: true,
        stop: async () => {
          await new Promise(resolve => setTimeout(resolve, 5200));
          writeFileSync(${JSON.stringify(join(root, 'config/saved'))}, 'saved');
          process.exit(0);
        }
      });
      const child = replacementPid ? undefined : spawn(process.execPath, [${JSON.stringify(entry)}], {
        detached: true, stdio: ['ignore','pipe','inherit'],
        env: { ...process.env, OPEN_SCIENCE_DEV_SESSION: JSON.stringify(session), FIXTURE_MODE: 'save-guard' }
      });
      child?.stdout.on('data', chunk => process.stdout.write(chunk));
      if (child) {
        writeFileSync(${JSON.stringify(join(root, 'backend-pid'))}, String(child.pid));
        const notification = await joinDevSession({ session,
          build: ${JSON.stringify({ buildId, workspaceRoot: root })},
          configRoot: ${JSON.stringify(join(root, 'config'))}, backendPid: child.pid,
          stop: async () => { throw new Error('Spawn notification must not own Desktop shutdown'); }
        });
        notification.close();
      } else console.log('READY');
      setInterval(() => {}, 1000);
      })().catch(error => { console.error(error); process.exit(1); });
    `,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: desktopEntry
    })
    const session = await createDevSession({ root, graceMs: 12_000, log: () => {} })
    const desktop = spawn(process.execPath, [desktopEntry, root], {
      env: { ...process.env, OPEN_SCIENCE_DEV_SESSION: session.environment },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    children.push(desktop)
    try {
      await new Promise<void>((resolve, reject) => {
        desktop.stdout!.on('data', (chunk) => {
          if (chunk.toString().includes('READY')) resolve()
        })
        desktop.once('exit', () => reject(new Error('Desktop exited before readiness.')))
      })
      if (replace) {
        const backendPid = Number(await readFile(join(root, 'backend-pid'), 'utf8'))
        const exited = once(desktop, 'exit')
        desktop.kill('SIGKILL')
        await exited
        expect(await inspectDevProcess(backendPid)).toBeDefined()
        const replacement = spawn(process.execPath, [desktopEntry, root], {
          env: {
            ...process.env,
            OPEN_SCIENCE_DEV_SESSION: session.environment,
            REPLACEMENT_BACKEND_PID: String(backendPid)
          },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        children.push(replacement)
        await new Promise<void>((resolve, reject) => {
          replacement.stdout!.on('data', (chunk) => {
            if (chunk.toString().includes('READY')) resolve()
          })
          replacement.once('exit', () =>
            reject(new Error('Replacement Desktop exited before readiness.'))
          )
        })
      }
      expect(await session.stop()).toEqual({ clean: true, stopped: 1 })
      expect(await readFile(join(root, 'config/saved'), 'utf8')).toBe('saved')
    } finally {
      await session.stop()
    }
  },
  20_000
)

it('cleans the owned backend when the dev command receives SIGTERM', async () => {
  const { root, entry, buildId } = await fixture()
  await mkdir(join(root, 'scripts'))
  for (const name of [
    'build-dev-packages',
    'native-components',
    'build-backend',
    'stage-node-runtime'
  ])
    await writeFile(join(root, `scripts/${name}.mjs`), '')
  await writeFile(
    join(root, 'scripts/build-backend.mjs'),
    `
    import { writeFileSync } from 'node:fs';
    writeFileSync('out/backend/dev-build.json', ${JSON.stringify(JSON.stringify({ buildId, workspaceRoot: root }))});
  `
  )
  await mkdir(join(root, 'node_modules/electron-vite/bin'), { recursive: true })
  await writeFile(
    join(root, 'node_modules/electron-vite/bin/electron-vite.js'),
    `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, [${JSON.stringify(entry)}], { detached: true, stdio: ['ignore','pipe','inherit'], env: process.env });
    writeFileSync(${JSON.stringify(join(root, 'backend-pid'))}, String(child.pid));
    child.stdout.on('data', data => process.stdout.write(data));
    setInterval(() => {}, 1000);
  `
  )
  const runner = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { runDev } from ${JSON.stringify(new URL('./dev.mjs', import.meta.url).href)};
    await runDev({ root: ${JSON.stringify(root)}, args: [] });
  `
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  children.push(runner)
  await new Promise<void>((resolve, reject) => {
    runner.stdout!.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) resolve()
    })
    runner.once('exit', () => reject(new Error('Dev fixture exited before readiness.')))
  })
  const pid = Number(await readFile(join(root, 'backend-pid'), 'utf8'))
  const exited = once(runner, 'exit')
  runner.kill('SIGTERM')
  await exited
  // On Windows SIGTERM kills the runner directly; the backend then observes socket loss.
  await expect.poll(async () => inspectDevProcess(pid), { timeout: 5000 }).toBeUndefined()
  const lease = acquireRuntimeDirectorySync(join(root, 'config'))
  lease.release()
}, 15_000)

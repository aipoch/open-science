import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireRuntimeDirectorySync } from '../../src/main/runtime-ownership'
import { waitForRuntimeStopped } from '../../src/main/runtime-stop-confirmation'
import { startUpdateServer } from './server.mjs'

it('a source-owned real hard link refuses production stop proof and releasing only the link permits recovery proof', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shutdown-fault-proof-')))
  const configRoot = join(root, 'config')
  const resourceRoot = join(root, 'source-resources')
  await mkdir(configRoot)
  await mkdir(resourceRoot)
  const generation = randomUUID()
  const entry = join(root, 'runtime.cjs')
  await build({
    stdin: {
      contents: `
        import { acquireRuntimeDirectorySync } from ${JSON.stringify(resolve('src/main/runtime-ownership.ts'))};
        import { writeRuntimeExit } from ${JSON.stringify(resolve('src/main/runtime-stop-confirmation.ts'))};
        const root = process.argv[2], generation = process.argv[3];
        const lease = acquireRuntimeDirectorySync(root);
        process.stdout.write('ready');
        process.stdin.resume();
        process.stdin.once('end', async () => {
          await writeRuntimeExit(root, { generation, pid: process.pid, outcome: 'clean' });
          lease.release();
        });
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22'
  })
  const child = spawn(process.execPath, [entry, configRoot, generation], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let exited = false
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      exited = true
      code === 0 ? resolve() : reject(new Error(`Fixture runtime exited ${code}`))
    })
  })
  let server: Awaited<ReturnType<typeof startUpdateServer>> | undefined
  try {
    await once(child.stdout!, 'data')
    await writeFile(join(root, 'B.zip'), 'artifact')
    server = await startUpdateServer({
      artifact: { directory: root, files: [{ name: 'B.zip', size: 8, sha512: 'fixture' }] },
      versionA: '0.0.1',
      versionB: '0.0.2',
      scenario: 'shutdown-failure',
      eventsPath: join(root, 'server-events.jsonl'),
      shutdownFault: { runRoot: root, configRoot, resourceRoot }
    })
    const lock = join(configRoot, '.open-science-runtime.sqlite')
    const original = await lstat(lock)
    expect((await lstat(lock)).nlink).toBe(1)
    await fetch(`${server.origin}/latest-mac.yml`)
    expect((await lstat(lock)).nlink).toBe(2)
    const proof = { configRoot, generation, pid: child.pid!, timeoutMs: 1000 }
    // Only this miniature test runtime receives its own explicit shutdown input. No app is started.
    child.stdin!.end()
    await exit
    await expect(waitForRuntimeStopped(proof)).rejects.toThrow('Unsafe runtime lock file')
    expect(JSON.parse(await readFile(join(configRoot, 'runtime-exit.json'), 'utf8'))).toEqual({
      generation,
      pid: child.pid,
      outcome: 'clean'
    })
    const page = await (await fetch(server.repairUrl!)).text()
    const action = /action="([^"]+)"/.exec(page)![1]
    expect(
      (await fetch(`${server.origin}${action}`, { method: 'POST', redirect: 'manual' })).status
    ).toBe(403)
    const repair = await fetch(`${server.origin}${action}`, {
      method: 'POST',
      headers: { Origin: server.origin },
      redirect: 'manual'
    })
    expect(repair.status).toBe(303)
    const repaired = await lstat(lock)
    expect({ ino: repaired.ino, dev: repaired.dev, nlink: repaired.nlink }).toEqual({
      ino: original.ino,
      dev: original.dev,
      nlink: 1
    })
    const lease = await waitForRuntimeStopped(proof)
    expect(() => acquireRuntimeDirectorySync(configRoot)).toThrow('already using')
    lease.release()
    acquireRuntimeDirectorySync(configRoot).release()
    expect(await readFile(join(root, 'server-events.jsonl'), 'utf8')).toContain(
      '"reason":"user-request"'
    )
  } finally {
    if (!exited) {
      child.stdin!.end()
      await exit
    }
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

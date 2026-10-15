import { afterEach, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { connectDesktopRuntime } from './desktop-runtime-client'
import type { DesktopEndpoint } from './desktop-connection'
import { acquireRuntimeDirectorySync } from './runtime-ownership'
let child: ChildProcess | undefined
let root: string | undefined
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit')
    child.kill('SIGKILL')
    await exit
  }
  if (root) await rm(root, { recursive: true, force: true })
})
it('adopts a separate process without its launch handle, excludes another Desktop, and confirms clean quit', async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-adoption-'))
  const entry = join(root, 'fixture.ts')
  const output = join(root, 'fixture.cjs')
  const main = resolve('src/main')
  await writeFile(
    entry,
    `
import {startDesktopRuntimeTransport} from ${JSON.stringify(join(main, 'desktop-runtime-transport.ts'))};
import {acquireRuntimeDirectorySync} from ${JSON.stringify(join(main, 'runtime-ownership.ts'))};
import {writeRuntimeExit} from ${JSON.stringify(join(main, 'runtime-stop-confirmation.ts'))};
const root=process.argv[2];const lease=acquireRuntimeDirectorySync(root);
async function main(){const server=await startDesktopRuntimeTransport({version:'test',launch:'desktop',entryPath:__filename,startupOptions:{configRoot:root,dataRoot:root,profilePath:root,port:0,host:'127.0.0.1',credentialStore:'os'},commands:{commandNames:()=>[],invoke:async()=>null},events:{subscribe:()=>()=>{}},requestShutdown:()=>{void (async()=>{await server.close();await writeRuntimeExit(root,{generation:server.endpoint.generation,pid:process.pid,outcome:'clean'});lease.release()})()}});process.send(server.endpoint)}main();
`
  )
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    logLevel: 'silent'
  })
  child = spawn(process.execPath, [output, root], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_PATH: resolve('node_modules') }
  })
  const endpoint = (await once(child, 'message'))[0] as DesktopEndpoint
  // IPC is only the isolated fixture's discovery channel, never the ownership proof.
  child.disconnect()
  const client = await connectDesktopRuntime({
    endpoint,
    desktopInstanceId: randomUUID(),
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  const competitor = await connectDesktopRuntime({
    endpoint,
    desktopInstanceId: randomUUID(),
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  expect(client.ownsRuntime()).toBe(true)
  expect(competitor.ownsRuntime()).toBe(false)
  competitor.close()
  const lease = await client.quit()
  expect(lease).toBeDefined()
  expect(() => acquireRuntimeDirectorySync(root!)).toThrow('already using')
  lease!.release()
  acquireRuntimeDirectorySync(root).release()
}, 20_000)

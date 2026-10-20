import { afterEach, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireRuntimeDirectorySync } from './runtime-ownership'
import { waitForRuntimeStopped, writeRuntimeExit } from './runtime-stop-confirmation'
const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit')
      child.kill('SIGKILL')
      await exit
    }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture() {
  const configRoot = await mkdtemp(join(tmpdir(), 'runtime-stop-'))
  roots.push(configRoot)
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');process.stdout.write('ready');process.stdin.once('data',()=>{db.close();process.exit(0)})`,
      join(configRoot, '.open-science-runtime.sqlite')
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  children.push(child)
  await once(child.stdout!, 'data')
  return { child, configRoot, pid: child.pid!, generation: randomUUID() }
}
it('confirms a real process exit and returns an exclusive lease that can be released for restart', async () => {
  const f = await fixture()
  await writeRuntimeExit(f.configRoot, { generation: f.generation, pid: f.pid, outcome: 'clean' })
  const stopped = waitForRuntimeStopped(f)
  f.child.stdin!.write('stop')
  const lease = await stopped
  expect(() => acquireRuntimeDirectorySync(f.configRoot)).toThrow('already using')
  lease.release()
  acquireRuntimeDirectorySync(f.configRoot).release()
})
it.each(['missing', 'failed', 'wrong-generation'] as const)(
  'refuses %s evidence and releases its temporary lock',
  async (kind) => {
    const f = await fixture()
    if (kind !== 'missing')
      await writeFile(
        join(f.configRoot, 'runtime-exit.json'),
        JSON.stringify({
          generation: kind === 'wrong-generation' ? randomUUID() : f.generation,
          pid: f.pid,
          outcome: kind === 'failed' ? 'failed' : 'clean'
        })
      )
    const exit = once(f.child, 'exit')
    f.child.stdin!.write('stop')
    await exit
    await expect(waitForRuntimeStopped(f)).rejects.toMatchObject({
      code: 'runtime-stop-unclean',
      evidence: { processExited: true, lockHeld: false }
    })
    acquireRuntimeDirectorySync(f.configRoot).release()
  }
)
it('times out while the original process remains alive without sending a signal', async () => {
  const f = await fixture()
  await expect(waitForRuntimeStopped({ ...f, timeoutMs: 60 })).rejects.toMatchObject({
    code: 'runtime-stop-timeout',
    evidence: { processExited: false, lockHeld: false }
  })
  expect(f.child.exitCode).toBeNull()
})

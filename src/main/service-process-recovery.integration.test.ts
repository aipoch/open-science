import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DelegatedProcessOwnership } from './delegation/process-ownership'
import { terminateProcessTree } from './process-tree'
import { acquireRuntimeDirectorySync, type RuntimeDirectoryLease } from './runtime-ownership'
import { recoverStoppedServiceProcesses } from './service-process-recovery'

const children: ChildProcess[] = []
let root: string | undefined
let lease: RuntimeDirectoryLease | undefined
afterEach(async (context) => {
  await Promise.all(children.splice(0).map((child) => terminateProcessTree(child)))
  lease?.release()
  lease = undefined
  if (root && context.task.result?.state !== 'fail')
    await rm(root, { recursive: true, force: true })
  root = undefined
})

it.skipIf(process.platform === 'win32')(
  'reaps persisted owned main/delegated groups while an unrelated control process survives',
  async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'stopped-service-owned-groups-')))
    const dataRoot = join(root, 'data')
    await mkdir(dataRoot)
    lease = acquireRuntimeDirectorySync(root)
    const main = new DelegatedProcessOwnership(root, 'main-agent-process-ownership')
    const delegated = new DelegatedProcessOwnership(dataRoot)
    const scope = {
      projectId: 'fixture-project',
      sessionId: 'fixture-session',
      frameId: 'fixture-frame',
      attemptId: 'fixture-attempt',
      frameworkId: 'fixture-framework'
    }
    const script = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"
    const a = main.spawn(scope, process.execPath, ['-e', script], {
      stdio: 'pipe',
      env: process.env
    })
    const b = delegated.spawn(scope, process.execPath, ['-e', script], {
      stdio: 'pipe',
      env: process.env
    })
    const control = spawn(process.execPath, ['-e', script], { stdio: 'pipe', detached: true })
    children.push(a, b, control)
    await Promise.all([a, b, control].map((child) => once(child.stdout!, 'data')))
    await recoverStoppedServiceProcesses({
      configRoot: root,
      dataRoot,
      lease,
      deadlineAt: Date.now() + 10000
    })
    expect(a.exitCode !== null || a.signalCode !== null).toBe(true)
    expect(b.exitCode !== null || b.signalCode !== null).toBe(true)
    expect(control.exitCode).toBeNull()
    expect(control.signalCode).toBeNull()
    expect(main.receipts()).toHaveLength(0)
    expect(delegated.receipts()).toHaveLength(0)
  },
  15000
)

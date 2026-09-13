import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { terminateProcessTree } from '../process-tree'
import { createProductionFrameWorkspace } from './frame-workspace'
import { createDeterministicDelegateExecution } from './deterministic-execution'
import { DelegatedProcessOwnership } from './process-ownership'

const scope = {
  projectId: 'project-a',
  sessionId: 'session-a',
  frameId: 'frame-a',
  attemptId: 'attempt-a',
  frameworkId: 'codex'
}
let directory: string | undefined
const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => terminateProcessTree(child)))
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})
const setup = async (): Promise<DelegatedProcessOwnership> => {
  directory = await mkdtemp(join(tmpdir(), 'delegated-process-ownership-'))
  return new DelegatedProcessOwnership(directory)
}

describe('durable delegated process ownership', () => {
  it.each(['deleteSession', 'deleteProject', 'prepare'] as const)(
    'preserves real files after reconstruction before %s',
    async (operation) => {
      const owner = await setup()
      owner.recordFailure(scope)
      const workspaceRoot = join(directory!, 'delegation')
      const frame = join(workspaceRoot, scope.projectId, scope.sessionId, 'frames', scope.frameId)
      await mkdir(frame, { recursive: true })
      const evidence = join(frame, 'evidence.txt')
      await writeFile(evidence, 'keep')
      const reopened = new DelegatedProcessOwnership(directory!)
      const workspace = createProductionFrameWorkspace({
        root: workspaceRoot,
        ownership: reopened,
        resolveInput: async () => {
          throw new Error('unexpected input')
        }
      })
      const result =
        operation === 'deleteSession'
          ? workspace.deleteSession(scope)
          : operation === 'deleteProject'
            ? workspace.deleteProject(scope.projectId)
            : workspace.prepare(scope, scope.frameId, [])
      await expect(result).rejects.toThrow()
      expect(await readFile(evidence, 'utf8')).toBe('keep')
      expect(reopened.receipts(scope)).toHaveLength(1)
    }
  )

  it('does not block an unrelated Project or historical receipt-free workspace', async () => {
    const owner = await setup()
    owner.recordFailure(scope)
    const other = { projectId: 'project-b', sessionId: 'session-b' }
    const workspace = createProductionFrameWorkspace({
      root: join(directory!, 'delegation'),
      ownership: owner,
      resolveInput: async () => {
        throw new Error('unexpected input')
      }
    })
    await expect(workspace.prepare(other, 'frame-b', [])).resolves.toHaveProperty('cwd')
    await expect(workspace.deleteProject(other.projectId)).resolves.toBeUndefined()
    expect(owner.receipts(scope)).toHaveLength(1)
  })

  it.each(['corrupt', 'unknown-version', 'scope-mismatch', 'torn-promotion'] as const)(
    'fails closed on %s storage',
    async (problem) => {
      const owner = await setup()
      owner.recordFailure(scope)
      const receipt = owner.receipts(scope)[0]
      const path = join(
        directory!,
        'delegation-process-ownership',
        scope.projectId,
        scope.sessionId,
        `${receipt.receiptId}.json`
      )
      if (problem === 'corrupt') await writeFile(path, '{')
      if (problem === 'unknown-version')
        await writeFile(path, JSON.stringify({ ...receipt, version: 999 }))
      if (problem === 'scope-mismatch')
        await writeFile(path, JSON.stringify({ ...receipt, sessionId: 'other-session' }))
      if (problem === 'torn-promotion') await writeFile(`${path}.pending`, '{')
      expect(() => new DelegatedProcessOwnership(directory!).assertClear(scope)).toThrow(
        'could not be read'
      )
      await expect(owner.recover(scope)).rejects.toThrow()
    }
  )

  it('rejects a symlinked ownership root without touching its target', async () => {
    const owner = await setup()
    const target = join(directory!, 'outside')
    await mkdir(target)
    await symlink(
      target,
      join(directory!, 'delegation-process-ownership'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(() => owner.recordFailure(scope)).toThrow()
    expect(await readdir(target)).toEqual([])
  })

  it('rejects unsafe cross-platform resource identities', async () => {
    const owner = await setup()
    for (const projectId of ['../outside', '..\\outside', 'C:outside', 'NUL', 'trailing.']) {
      expect(() => owner.recordFailure({ ...scope, projectId })).toThrow()
    }
  })

  it('restores quarantined capacity once at the Session execution owner', async () => {
    const owner = await setup()
    owner.recordFailure(scope)
    const execution = createDeterministicDelegateExecution(2)
    const reopened = new DelegatedProcessOwnership(directory!)
    const guarded = reopened.protectExecution(execution, scope, 'codex')
    const reservation = await guarded.reserve(1)
    await expect(guarded.reserve(1)).rejects.toThrow()
    await reservation.releaseAll()
    const next = await guarded.reserve(1)
    expect(next.slotIds).toHaveLength(1)
    await next.releaseAll()
  })

  it('publishes ownership before ACP IO and clears it only after whole-tree teardown', async () => {
    const owner = await setup()
    const child = owner.spawn(
      scope,
      process.execPath,
      ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
      { stdio: 'pipe', env: process.env, windowsHide: true }
    )
    children.push(child)
    const receipt = owner.receipts(scope)[0]
    expect(receipt).toMatchObject({
      phase: 'owned',
      attemptId: scope.attemptId,
      ownership: { platform: process.platform }
    })
    const [output] = await once(child.stdout, 'data')
    expect(output.toString()).toBe('ready')
    expect(() => new DelegatedProcessOwnership(directory!).assertClear(scope)).toThrow()
    await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
    expect(owner.receipts(scope)).toEqual([])
    await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
    expect(owner.receipts(scope)).toEqual([])
  })

  it('does not launch when the durable intent cannot be written', async () => {
    const owner = await setup()
    await writeFile(join(directory!, 'delegation-process-ownership'), 'not a directory')
    const marker = join(directory!, 'must-not-exist')
    expect(() =>
      owner.spawn(
        scope,
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched')`],
        { stdio: 'pipe', env: process.env }
      )
    ).toThrow()
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains identity-less launch intent across recovery instead of guessing from PID absence', async () => {
    const owner = await setup()
    owner.recordFailure(scope)
    const recovery = vi.fn(() => owner.recover(scope))
    await expect(recovery()).rejects.toThrow()
    await expect(new DelegatedProcessOwnership(directory!).recover(scope)).rejects.toThrow()
    expect(owner.receipts(scope)).toHaveLength(1)
  })
})

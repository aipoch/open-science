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

  it.each(['corrupt', 'unknown-version', 'scope-mismatch'] as const)(
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
      expect(() => new DelegatedProcessOwnership(directory!).assertClear(scope)).toThrow(
        'could not be read'
      )
      await expect(owner.recover(scope)).rejects.toThrow()
    }
  )

  it('silently skips a torn .json.pending file left by a crashed phase update', async () => {
    // A .json.pending is produced only during a phase update (write → rename).
    // The underlying .json is the committed state; skipping the pending file is correct.
    const owner = await setup()
    owner.recordFailure(scope)
    const receipt = owner.receipts(scope)[0]
    const dir = join(directory!, 'delegation-process-ownership', scope.projectId, scope.sessionId)
    await writeFile(join(dir, `${receipt.receiptId}.json.pending`), '{')
    // receipts() must silently skip the torn file and return the committed receipt.
    expect(new DelegatedProcessOwnership(directory!).receipts(scope)).toHaveLength(1)
  })

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

  // ── D4: .DS_Store and torn writes ───────────────────────────────────────────────────────────

  it('ignores .DS_Store in the ownership directory without throwing', async () => {
    const owner = await setup()
    owner.recordFailure(scope)
    // Place a .DS_Store next to the receipt and a desktop.ini in the project directory.
    const root = join(directory!, 'delegation-process-ownership')
    await writeFile(join(root, scope.projectId, scope.sessionId, '.DS_Store'), 'macOS sidecar')
    await writeFile(join(root, scope.projectId, 'desktop.ini'), 'Windows sidecar')
    await writeFile(join(root, '.DS_Store'), 'root sidecar')
    // receipts() must still enumerate the real receipt without throwing.
    expect(owner.receipts(scope)).toHaveLength(1)
    expect(() => new DelegatedProcessOwnership(directory!).receipts()).not.toThrow()
  })

  it('ignores torn .json.pending files left by a crash-interrupted write', async () => {
    const owner = await setup()
    owner.recordFailure(scope)
    const receipt = owner.receipts(scope)[0]
    const dir = join(directory!, 'delegation-process-ownership', scope.projectId, scope.sessionId)
    // Simulate a crash between write and rename — the .pending file was never renamed.
    await writeFile(join(dir, `${receipt.receiptId}.json.pending`), '{}')
    // receipts() must still return the committed receipt, not throw on the pending file.
    expect(owner.receipts(scope)).toHaveLength(1)
  })

  // ── D3: recordFailure now captures boot session ──────────────────────────────────────────────

  it('recordFailure receipt carries an ownership field with the current boot session', async () => {
    const owner = await setup()
    owner.recordFailure(scope)
    const [receipt] = owner.receipts(scope)
    // Must have an ownership block so reboot-proof can clear it later.
    expect(receipt.ownership).toBeDefined()
    expect(receipt.ownership?.platform).toBe(process.platform)
    // Token is always present; bootId may be undefined on platforms with no boot-identity read.
    expect(receipt.ownership?.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })

  // ── D1: cold-receipt cleared when the recorded POSIX leader is provably dead ────────────────

  it('clears a cold non-live receipt after a POSIX spawn whose leader has since exited', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const owner = await setup()
    // Spawn a short-lived process and wait for it to exit so the leader pid is free.
    const child = owner.spawn(scope, process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'pipe',
      env: process.env,
      windowsHide: true
    })
    children.push(child)
    await once(child, 'close')
    // The live tracker already has the handle; force it into a non-live simulated cold-restart
    // by building a fresh DelegatedProcessOwnership from disk with the receipt still present.
    await terminateProcessTree(child)
    // Give the tracker a moment to write cleanup-pending if needed.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const [receipt] = owner.receipts(scope)
    if (!receipt) return // already cleared by live tracker — acceptable
    // Simulate a cold restart: new instance reading receipts from disk.
    const cold = new DelegatedProcessOwnership(directory!)
    // recover() must succeed (not throw) because the leader's pid is absent or reused.
    await expect(cold.recover(scope)).resolves.toBeUndefined()
    // Receipt must be cleared.
    expect(cold.receipts(scope)).toHaveLength(0)
  })

  // ── D1: reboot-proof clears receipts with a matching boot-session id ─────────────────────────

  it('clears a cold receipt when the recorded boot session differs from the current one', async () => {
    const owner = await setup()
    owner.recordFailure(scope)
    const [receipt] = owner.receipts(scope)
    // Patch the receipt to have a fake boot session from a "previous boot".
    const dir = join(directory!, 'delegation-process-ownership', scope.projectId, scope.sessionId)
    const path = join(dir, `${receipt.receiptId}.json`)
    const stale = {
      ...receipt,
      ownership: {
        ...receipt.ownership,
        bootId: '00000000-0000-0000-0000-000000000001'
      }
    }
    await writeFile(path, JSON.stringify(stale) + '\n')
    // Only runs on platforms that actually provide a boot session id.
    const cold = new DelegatedProcessOwnership(directory!)
    if (process.platform === 'linux' || process.platform === 'darwin') {
      // recover() should clear the receipt because the recorded boot session is "old".
      await expect(cold.recover(scope)).resolves.toBeUndefined()
      expect(cold.receipts(scope)).toHaveLength(0)
    }
  })

  // ── D2: blocked receipt must not propagate into the global shutdown aggregate ────────────────

  it('recover() throws DelegateExecutionCleanupError for an unresolvable receipt', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const owner = await setup()
    // A receipt without a leader and with the current boot session cannot be cleared.
    owner.recordFailure(scope)
    const [receipt] = owner.receipts(scope)
    // Overwrite with no bootId so the reboot-proof path is not triggered.
    const dir = join(directory!, 'delegation-process-ownership', scope.projectId, scope.sessionId)
    const path = join(dir, `${receipt.receiptId}.json`)
    const noProof = {
      ...receipt,
      ownership: { platform: receipt.ownership?.platform, token: receipt.ownership?.token }
    }
    await writeFile(path, JSON.stringify(noProof) + '\n')
    const cold = new DelegatedProcessOwnership(directory!)
    await expect(cold.recover(scope)).rejects.toMatchObject({ name: 'AggregateError' })
    // The error message must identify it as a cleanup-confirmation problem, not a read error.
    const err = await cold.recover(scope).catch((e: AggregateError) => e)
    expect((err as AggregateError).errors?.[0]?.name).toBe('DelegateExecutionCleanupError')
  })
})

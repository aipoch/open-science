import { processBirthIdentity } from '../process-birth-identity'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  defaultController,
  KernelProcessLifecycleOwner,
  type KernelProcessSpawnIntent
} from './kernel-process-lifecycle.windows-posix'
import { readProcessStartToken } from '@aipoch/environment'
import {
  capturePosixProcessTreeIdentity,
  trackOwnedPosixProcessTree,
  terminateProcessTree
} from '../process-tree'

const windowsProcessIsAlive = vi.hoisted(() => vi.fn<(pid: number) => boolean>(() => true))
const reapWindowsOwnedJob = vi.hoisted(() => vi.fn<(name: string) => Promise<boolean>>())

vi.mock('../process-tree-windows', () => ({ reapWindowsOwnedJob }))

vi.mock('../windows-process-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../windows-process-query')>()
  windowsProcessIsAlive.mockImplementation(actual.windowsProcessIsAlive)
  return { ...actual, windowsProcessIsAlive }
})

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const BOOT_TOKEN = '11111111-1111-4111-8111-111111111111'

describe('KernelProcessLifecycleOwner', () => {
  const bootA = '11111111-1111-4111-8111-111111111111'
  const bootB = '22222222-2222-4222-8222-222222222222'
  let root: string | undefined
  const trackedChildren: ChildProcess[] = []

  afterEach(async () => {
    await Promise.all(trackedChildren.splice(0).map((child) => terminateProcessTree(child)))
    vi.restoreAllMocks()
    windowsProcessIsAlive.mockClear()
    reapWindowsOwnedJob.mockReset()
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('does not fence admission on unpublished temporary records left by a failed write', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-temporary-'))
    const owner = new KernelProcessLifecycleOwner({ storageRoot: root })
    const scope = { laneKey: 'lane', processKey: 'python:default-python', kernelEpochId: 'epoch' }
    const intent = owner.beginSpawn(scope)
    await writeFile(`${intent.path}.123-test.tmp`, JSON.stringify(intent.record))
    owner.abandonSpawn(intent)
    const restarted = new KernelProcessLifecycleOwner({ storageRoot: root })
    await restarted.ensureReady()
    const retried = restarted.beginSpawn(scope)
    expect(retried.record.processKey).toBe('python:default-python')
    expect(() => restarted.beginSpawn(scope)).toThrow('KERNEL_STARTUP_FENCE')
  })

  it('allows the real process host to publish its receipt and execute code', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-host-execution-'))
    const owner = new KernelProcessLifecycleOwner({ storageRoot: root })
    const intent = owner.beginSpawn({
      laneKey: 'lane',
      processKey: 'python:default-python',
      kernelEpochId: 'epoch'
    })
    const host = spawn(
      process.execPath,
      [
        join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
        intent.path,
        intent.record.receiptId,
        process.execPath,
        '-e',
        'process.stdout.write("42")'
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }
    )
    let output = ''
    host.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      host.once('error', reject)
      host.once('close', resolve)
    })
    expect(exitCode).toBe(0)
    expect(output).toBe('42')
    const record = JSON.parse(await readFile(intent.activePath(host.pid!), 'utf8'))
    expect(record.pid).toBe(host.pid)
  })

  it('forwards the contained kernel executable and arguments through the process host', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-host-forwarding-'))
    const owner = new KernelProcessLifecycleOwner({ storageRoot: root })
    const intent = owner.beginSpawn({
      laneKey: 'lane',
      processKey: 'repl',
      kernelEpochId: 'epoch'
    })
    const marker = join(root, 'forwarded.json')
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(1), electron: process.env.ELECTRON_RUN_AS_NODE }))`
    ].join('')
    const host = spawn(
      process.execPath,
      [
        join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
        intent.path,
        intent.record.receiptId,
        process.execPath,
        '-e',
        script,
        'kernel-forwarded-a',
        'kernel-forwarded-b'
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }
    )
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      host.once('error', reject)
      host.once('close', resolve)
    })

    expect(exitCode).toBe(0)
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
      argv: ['kernel-forwarded-a', 'kernel-forwarded-b'],
      electron: '1'
    })
    const record = JSON.parse(await readFile(intent.activePath(host.pid!), 'utf8'))
    expect(record.commandIdentityMarker).toBe(intent.record.receiptId)
  })

  it('reaps a verified stale owner before opening process admission', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-owner-'))
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a',
      controller: {
        probe: vi.fn(async () => 'owned' as const),
        terminate: vi.fn(async () => ({ reaped: true }))
      }
    })
    await first.ensureReady()
    const intent = first.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'python:default-python',
      kernelEpochId: 'epoch-a'
    })
    first.recordSpawned(intent, {
      pid: 4242,
      posixBirthToken: 'fixture-birth',
      processStartToken: '100',
      commandIdentityMarker: 'marker-a'
    })

    const terminate = vi.fn(async () => ({ reaped: true }))
    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b',
      controller: { probe: vi.fn(async () => 'owned' as const), terminate }
    })
    await restarted.ensureReady()

    expect(terminate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerInstanceId: 'owner-a',
        kernelEpochId: 'epoch-a',
        laneKey: '["project-1","session-1","root",null,null]',
        processKey: 'python:default-python',
        pid: 4242
      }),
      ...(process.platform === 'darwin' ? [expect.any(Function)] : [])
    )
    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
  })

  it.each([
    { probe: 'owned', reaped: true, draft: 'matching', removed: true },
    { probe: 'dead', reaped: false, draft: 'matching', removed: true },
    { probe: 'reused', reaped: false, draft: 'matching', removed: true },
    { probe: 'owned', reaped: false, draft: 'matching', removed: false },
    { probe: 'unknown', reaped: false, draft: 'matching', removed: false },
    { probe: 'owned', reaped: true, draft: 'foreign', removed: false },
    { probe: 'owned', reaped: true, draft: 'empty', removed: false },
    { probe: 'owned', reaped: true, draft: 'partial', removed: false },
    { probe: 'unknown', reaped: false, draft: 'partial', removed: false }
  ] as const)(
    'handles interrupted host receipt writes after recovery ($probe, reaped=$reaped, draft=$draft)',
    async ({ probe, reaped, draft, removed }) => {
      root = await mkdtemp(join(tmpdir(), 'kernel-process-interrupted-receipt-'))
      const first = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-a'
      })
      await first.ensureReady()
      const intent = first.beginSpawn({
        laneKey: 'lane',
        processKey: 'repl',
        kernelEpochId: 'epoch-interrupted'
      })
      const receipt = first.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })
      const temporary = `${receipt.path}.4242.tmp`
      const contents = await readFile(receipt.path, 'utf8')
      const draftContents = {
        matching: contents,
        foreign: JSON.stringify({ ...JSON.parse(contents), ownerToken: 'different-owner' }),
        empty: '',
        partial: contents.slice(0, contents.indexOf('ownerToken'))
      }[draft]
      await writeFile(temporary, draftContents)
      // The host publishes the active filename before persisting its PID in the receipt.
      await writeFile(receipt.path, JSON.stringify(intent.record))
      const terminate = vi.fn(async () => {
        expect(await readFile(temporary, 'utf8')).toBe(draftContents)
        return { reaped }
      })
      const restarted = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-b',
        controller: { probe: async () => probe, terminate }
      })
      if (probe === 'unknown' || (probe === 'owned' && !reaped)) {
        await expect(restarted.ensureReady()).rejects.toThrow('KERNEL_STARTUP_FENCE')
      } else {
        await restarted.ensureReady()
        const next = restarted.beginSpawn({
          laneKey: intent.record.laneKey,
          processKey: intent.record.processKey,
          kernelEpochId: 'next-epoch'
        })
        restarted.abandonSpawn(next)
      }
      expect(terminate).toHaveBeenCalledTimes(probe === 'owned' ? 1 : 0)
      if (removed) {
        await expect(readFile(temporary, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(await readFile(temporary, 'utf8')).toBe(draftContents)
      }
    }
  )

  it('retains an unverified old writer and keeps admission fenced', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-fence-'))
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a',
      controller: {
        probe: vi.fn(async () => 'unknown' as const),
        terminate: vi.fn(async () => ({ reaped: false }))
      }
    })
    await first.ensureReady()
    const intent = first.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'repl',
      kernelEpochId: 'epoch-repl'
    })
    first.recordSpawned(intent, {
      pid: 5252,
      posixBirthToken: 'fixture-birth',
      commandIdentityMarker: 'marker-repl'
    })

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b',
      controller: {
        probe: vi.fn(async () => 'unknown' as const),
        terminate: vi.fn(async () => ({ reaped: false }))
      }
    })

    await expect(restarted.ensureReady()).rejects.toThrow('KERNEL_STARTUP_FENCE')
    const [entry] = await readdir(join(root, 'runtime', 'kernel-processes'))
    expect(
      JSON.parse(await readFile(join(root, 'runtime', 'kernel-processes', entry!), 'utf8'))
    ).toMatchObject({
      ownerInstanceId: 'owner-a',
      processKey: 'repl',
      pid: 5252
    })
  })

  it('keeps an exact process fence while tolerant recovery admits unrelated kernels', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-scoped-recovery-'))
    const scope = {
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'r:default-r',
      kernelEpochId: 'epoch-r'
    }
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a',
      controller: {
        probe: vi.fn(async () => 'unknown' as const),
        terminate: vi.fn(async () => ({ reaped: false }))
      }
    })
    await first.ensureReady()
    const intent = first.beginSpawn(scope)
    first.recordSpawned(intent, { pid: 5252, posixBirthToken: 'fixture-birth' })

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b',
      controller: {
        probe: vi.fn(async () => 'unknown' as const),
        terminate: vi.fn(async () => ({ reaped: false }))
      }
    })

    await expect(restarted.recover({ allowUnverifiedReceipts: true })).resolves.toBeUndefined()
    const unrelated = restarted.beginSpawn({
      ...scope,
      processKey: 'repl',
      kernelEpochId: 'epoch-repl'
    })
    restarted.abandonSpawn(unrelated)
    expect(() => restarted.beginSpawn(scope)).toThrow('KERNEL_STARTUP_FENCE')
  })

  it('skips probes for receipts outside the recovering lane', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-scoped-probes-'))
    const target = {
      laneKey: 'target-lane',
      processKey: 'r:default-r',
      kernelEpochId: 'epoch-target'
    }
    const unrelated = {
      laneKey: 'unrelated-lane',
      processKey: 'python:default-python',
      kernelEpochId: 'epoch-unrelated'
    }
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a'
    })
    await first.ensureReady()
    first.recordSpawned(first.beginSpawn(target), { pid: 5252, posixBirthToken: 'target-birth' })
    first.recordSpawned(first.beginSpawn(unrelated), {
      pid: 6262,
      posixBirthToken: 'unrelated-birth'
    })

    const probe = vi.fn(async () => 'unknown' as const)
    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b',
      controller: { probe, terminate: vi.fn(async () => ({ reaped: false })) }
    })

    await restarted.ensureReadyForLane(target.laneKey)

    expect(probe).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ laneKey: target.laneKey }),
      ...(process.platform === 'darwin' ? [expect.any(Function)] : [])
    )
    expect(() => restarted.beginSpawn(target)).toThrow('KERNEL_STARTUP_FENCE')
  })

  it('reuses completed lane recovery until that lane publishes a new receipt', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-scoped-cache-'))
    const probe = vi.fn(async () => 'dead' as const)
    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-restarted',
      controller: {
        probe,
        terminate: vi.fn(async () => ({ reaped: true }))
      }
    })
    const lane = 'target-lane'

    await restarted.ensureReadyForLane(lane)
    await restarted.ensureReadyForLane(lane)
    expect(probe).not.toHaveBeenCalled()

    const other = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-other'
    })
    const external = other.beginSpawn({
      laneKey: lane,
      processKey: 'python:default-python',
      kernelEpochId: 'epoch-external'
    })
    other.recordSpawned(external, { pid: 5252, posixBirthToken: 'external-birth' })

    await restarted.ensureReadyForLane(lane)
    expect(probe).toHaveBeenCalledOnce()
  })

  it('does not cancel a pending startup while tolerant recovery scans another lane', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-pending-recovery-'))
    const owner = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a'
    })
    const intent = owner.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'r:default-r',
      kernelEpochId: 'epoch-r'
    })
    await owner.ensureReadyForLane('["project-2","session-2","root",null,null]')
    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toContain(
      intent.path.split(/[\\/]/).pop()!
    )

    const receipt = owner.recordSpawned(intent, { pid: 5252, posixBirthToken: 'fixture-birth' })
    owner.complete(receipt, true)
  })

  it('cleans a pending startup left by a crashed owner before admitting that lane', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-stale-pending-'))
    const scope = {
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'r:default-r',
      kernelEpochId: 'epoch-r'
    }
    const crashed = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a'
    })
    crashed.beginSpawn(scope)

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b'
    })
    await restarted.ensureReadyForLane(scope.laneKey)

    const retry = restarted.beginSpawn(scope)
    restarted.abandonSpawn(retry)
  })

  it('admits another lane when a pending host promotes its receipt during recovery', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-promoted-pending-'))
    const previous = new KernelProcessLifecycleOwner({ storageRoot: root })
    const intents = ['lane-a', 'lane-b']
      .map((laneKey) =>
        previous.beginSpawn({ laneKey, processKey: 'r:default-r', kernelEpochId: 'epoch-r' })
      )
      .sort((left, right) => left.path.localeCompare(right.path))
    const [active, pending] = intents
    previous.recordSpawned(active!, { pid: 4242, posixBirthToken: 'fixture-birth' })
    const probe = vi.fn(async () => {
      // Recovery already captured both filenames. A host publishes the pending receipt while
      // recovery awaits the preceding active process probe, before it reads the pending path.
      previous.recordSpawned(pending!, { pid: 5252, posixBirthToken: 'fixture-birth' })
      return 'unknown' as const
    })
    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      controller: { probe, terminate: vi.fn(async () => ({ reaped: false })) }
    })

    await expect(restarted.ensureReadyForLane('lane-a')).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledOnce()
    const unrelated = restarted.beginSpawn({
      laneKey: 'unrelated-lane',
      processKey: 'repl',
      kernelEpochId: 'epoch-repl'
    })
    restarted.abandonSpawn(unrelated)
    expect(() => restarted.beginSpawn(pending!.record)).toThrow('KERNEL_STARTUP_FENCE')
  })

  it('keeps tolerant recovery fail-closed for a receipt whose scope cannot be trusted', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-invalid-receipt-'))
    const directory = join(root, 'runtime', 'kernel-processes')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'unparseable.json'), '{"processKey":"r:default-r"}')
    const restarted = new KernelProcessLifecycleOwner({ storageRoot: root })

    await expect(restarted.recover({ allowUnverifiedReceipts: true })).rejects.toThrow(
      'KERNEL_STARTUP_FENCE'
    )
  })

  it('drops a reboot-stale POSIX group receipt without terminating its recycled numeric id', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-reused-group-'))
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a',
      platform: 'linux',
      readBootToken: () => bootA,
      controller: {
        probe: vi.fn(async () => 'owned' as const),
        terminate: vi.fn(async () => ({ reaped: true }))
      }
    })
    await first.ensureReady()
    const intent = first.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'python:default-python',
      kernelEpochId: 'epoch-reused-group'
    })
    first.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b',
      platform: 'linux',
      readBootToken: () => bootB
    })

    await restarted.ensureReady()

    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
  })

  it.each(['linux', 'darwin'] as const)(
    'does not probe or signal a numeric %s group after a proven reboot',
    async (platform) => {
      const kill = vi.spyOn(process, 'kill')
      const controller = defaultController(platform, () => bootB)

      await expect(
        controller.probe({
          version: 1,
          receiptId: 'receipt-a',
          ownerInstanceId: 'owner-a',
          ownerToken: 'owner-token-a',
          platform,
          spawnedAt: 1,
          laneKey: 'lane-a',
          processKey: 'repl',
          kernelEpochId: 'epoch-a',
          pid: process.pid,
          bootToken: bootA
        })
      ).resolves.toBe('dead')

      expect(kill).not.toHaveBeenCalledWith(-process.pid, 0)
    }
  )

  it('preserves a proofless legacy Windows receipt without signalling its recorded PID', async () => {
    const kill = vi.spyOn(process, 'kill')
    const record = {
      version: 1 as const,
      receiptId: 'receipt-windows-exited',
      ownerInstanceId: 'owner-a',
      ownerToken: 'owner-token-a',
      platform: 'win32' as const,
      spawnedAt: 1,
      laneKey: 'lane-a',
      processKey: 'repl',
      kernelEpochId: 'epoch-a',
      pid: 4242
    }
    const controller = defaultController('win32')
    await expect(controller.probe(record)).resolves.toBe('unknown')
    await expect(controller.terminate(record)).resolves.toEqual({ reaped: false })
    expect(kill).not.toHaveBeenCalled()
  })

  it('admits the original Windows kernel only after observing a later boot on the same host', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-windows-reboot-'))
    const options = { storageRoot: root, platform: 'win32' as const }
    const previous = new KernelProcessLifecycleOwner(options)
    const scope = {
      laneKey: 'old-session',
      processKey: 'python:default-python',
      kernelEpochId: 'epoch'
    }
    previous.recordSpawned(previous.beginSpawn(scope), { pid: 4242 })
    const host = 'a'.repeat(64)
    const recover = (hostHash?: string, boot = bootA): Promise<KernelProcessSpawnIntent> => {
      const owner = new KernelProcessLifecycleOwner({
        ...options,
        readWindowsBootObservation: async () =>
          hostHash ? { hostHash, bootIdentity: `windows-boot:${boot}` } : undefined
      })
      return owner.ensureReady().then(() => owner.beginSpawn(scope))
    }

    await expect(recover(host)).rejects.toThrow('KERNEL_STARTUP_FENCE')
    await expect(recover(host)).rejects.toThrow('KERNEL_STARTUP_FENCE')
    await expect(recover()).rejects.toThrow('KERNEL_STARTUP_FENCE')
    await expect(recover('b'.repeat(64), bootB)).rejects.toThrow('KERNEL_STARTUP_FENCE')
    await expect(recover(host, bootB)).resolves.toMatchObject({ record: scope })
  })

  it.each(['started-and-reaped', 'never-started'] as const)(
    'clears a Windows receipt after the persisted supervisor proof reports %s',
    async (processState) => {
      root = await mkdtemp(join(tmpdir(), 'kernel-process-windows-proof-'))
      const proofPath = join(root, '.open-science-process-tree-terminated-proof.proof')
      const proof = {
        path: proofPath,
        token: 'proof-token',
        requestPath: `${proofPath}.request`
      }
      const first = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
      await first.ensureReady()
      const intent = first.beginSpawn(
        {
          laneKey: 'lane-a',
          processKey: 'repl',
          kernelEpochId: 'epoch-a'
        },
        'owner-token-a',
        proof
      )
      first.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })
      await writeFile(proof.path, JSON.stringify({ version: 1, token: proof.token, processState }))

      windowsProcessIsAlive.mockReturnValueOnce(false)
      const restarted = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
      await restarted.ensureReady()

      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
      await expect(readFile(proof.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(['ensureReady', 'recover'] as const)(
    'retries a named Windows Job after %s cannot confirm reaping',
    async (initialRecovery) => {
      root = await mkdtemp(join(tmpdir(), 'kernel-process-job-'))
      const first = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
      const scope = { laneKey: 'lane', processKey: 'repl', kernelEpochId: 'epoch' }
      const intent = first.beginSpawn(scope, undefined, undefined, true)
      first.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })
      reapWindowsOwnedJob.mockRejectedValueOnce(new Error('Job query unavailable'))
      const restarted = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
      await expect(restarted[initialRecovery]()).rejects.toThrow('KERNEL_STARTUP_FENCE')
      expect(() => restarted.beginSpawn(scope)).toThrow('KERNEL_STARTUP_FENCE')

      reapWindowsOwnedJob.mockResolvedValueOnce(true)
      const retry = restarted.ensureReady()
      expect(restarted.ensureReady()).toBe(retry)
      await retry
      expect(reapWindowsOwnedJob).toHaveBeenCalledTimes(2)
      expect(reapWindowsOwnedJob).toHaveBeenLastCalledWith(
        `Local\\OpenScience.Notebook.${intent.record.receiptId}`
      )
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
    }
  )

  it.each(['different-receipt', 'different-namespace', 'different-platform'])(
    'does not authorize a named Job from a %s receipt',
    async (mismatch) => {
      root = await mkdtemp(join(tmpdir(), 'kernel-process-invalid-job-'))
      const first = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
      const intent = first.beginSpawn(
        { laneKey: 'lane', processKey: 'repl', kernelEpochId: 'epoch' },
        undefined,
        undefined,
        true
      )
      const receipt = first.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })
      const record = JSON.parse(await readFile(receipt.path, 'utf8'))
      if (mismatch === 'different-receipt') record.windowsJobName += '-other'
      if (mismatch === 'different-namespace') {
        record.windowsJobName = `Local\\OpenScience.Delegation.${record.receiptId}`
      }
      if (mismatch === 'different-platform') record.platform = 'linux'
      await writeFile(receipt.path, JSON.stringify(record))
      const restarted = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
      await expect(restarted.ensureReady()).rejects.toThrow('KERNEL_STARTUP_FENCE')
      expect(reapWindowsOwnedJob).not.toHaveBeenCalled()
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toHaveLength(1)
    }
  )

  it('retains a Windows tree proof until receipt completion settles', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-windows-proof-settlement-'))
    const proofPath = join(root, '.open-science-process-tree-terminated-proof.proof')
    const proof = {
      path: proofPath,
      token: 'proof-token',
      requestPath: `${proofPath}.request`
    }
    const owner = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
    await owner.ensureReady()
    const intent = owner.beginSpawn(
      {
        laneKey: 'lane-a',
        processKey: 'repl',
        kernelEpochId: 'epoch-a'
      },
      'owner-token-a',
      proof
    )
    const receipt = owner.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })
    await writeFile(
      proof.path,
      JSON.stringify({ version: 1, token: proof.token, processState: 'started-and-reaped' })
    )

    await expect(readFile(proof.path, 'utf8')).resolves.toContain(proof.token)
    owner.complete(receipt, true)
    await expect(readFile(proof.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rechecks a failed Windows startup when the supervisor proof becomes terminal', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-late-proof-'))
    const proofPath = join(root, '.open-science-process-tree-terminated-proof.proof')
    const proof = { path: proofPath, token: 'proof-token', requestPath: `${proofPath}.request` }
    const first = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
    const intent = first.beginSpawn(
      { laneKey: 'lane-a', processKey: 'python:default-python', kernelEpochId: 'epoch-a' },
      undefined,
      proof
    )
    first.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })
    windowsProcessIsAlive.mockReturnValueOnce(false).mockReturnValueOnce(false)
    const restarted = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
    await expect(restarted.ensureReady()).rejects.toThrow('KERNEL_STARTUP_FENCE')
    await writeFile(
      proof.path,
      JSON.stringify({ version: 1, token: proof.token, processState: 'started-and-reaped' })
    )

    const retryError = await restarted.ensureReady().then(
      () => undefined,
      (error: unknown) => error
    )
    // A fresh owner accepts the exact same terminal proof; only the cached failed call is stale.
    await new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' }).ensureReady()
    expect(retryError).toBeUndefined()
    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
  })

  it('keeps a Windows reused-PID receipt fenced until its tree proof is terminal', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-windows-reused-proof-'))
    const proofPath = join(
      root,
      'proof-parent-created-after-recovery',
      '.open-science-process-tree-terminated-proof.proof'
    )
    const proof = {
      path: proofPath,
      token: 'proof-token',
      requestPath: `${proofPath}.request`
    }
    const controller = {
      probe: vi.fn().mockResolvedValue('reused' as const),
      terminate: vi.fn().mockResolvedValue({ reaped: false })
    }
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      platform: 'win32',
      controller
    })
    await first.ensureReady()
    const intent = first.beginSpawn(
      {
        laneKey: 'lane-a',
        processKey: 'repl',
        kernelEpochId: 'epoch-a'
      },
      'owner-token-a',
      proof
    )
    first.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      platform: 'win32',
      controller
    })
    await expect(restarted.ensureReady()).rejects.toThrow('KERNEL_STARTUP_FENCE')
    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toHaveLength(1)

    await mkdir(join(root, 'proof-parent-created-after-recovery'), { recursive: true })
    await writeFile(
      proof.path,
      JSON.stringify({ version: 1, token: proof.token, processState: 'started-and-reaped' })
    )
    const recovered = new KernelProcessLifecycleOwner({
      storageRoot: root,
      platform: 'win32',
      controller
    })
    await recovered.ensureReady()
    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
  })

  it.skipIf(process.platform !== 'darwin')(
    'treats a missing macOS process group as dead without a boot token',
    async () => {
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('missing'), { code: 'ESRCH' })
      })

      await expect(
        defaultController('darwin').probe({
          version: 1,
          receiptId: 'receipt-mac',
          ownerInstanceId: 'owner-a',
          ownerToken: 'owner-token-a',
          platform: 'darwin',
          spawnedAt: 1,
          laneKey: 'lane-a',
          processKey: 'repl',
          kernelEpochId: 'epoch-a',
          pid: 4242
        })
      ).resolves.toBe('dead')
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'recovers a real macOS group after its leader exits',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'kernel-mac-leaderless-'))
      const first = new KernelProcessLifecycleOwner({ storageRoot: root })
      const token = first.createOwnerToken()
      const intent = first.beginSpawn(
        { laneKey: 'lane', processKey: 'python:default-python', kernelEpochId: 'old' },
        token
      )
      const leader = spawn(
        process.execPath,
        [
          '-e',
          `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(child.pid));
      setInterval(() => {}, 1000);
    `
        ],
        {
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, ...first.environment(token) }
        }
      )
      const exited = once(leader, 'exit')
      let childPid: number | undefined
      try {
        childPid = Number((await once(leader.stdout!, 'data'))[0].toString())
        first.recordSpawned(intent, {
          pid: leader.pid!,
          posixBirthToken: processBirthIdentity(leader.pid!)
        })
        leader.kill('SIGKILL')
        await exited
        expect(processIsAlive(childPid)).toBe(true)
        await new KernelProcessLifecycleOwner({ storageRoot: root }).ensureReady()
        await vi.waitFor(() => expect(processIsAlive(childPid!)).toBe(false))
        expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
      } finally {
        try {
          process.kill(-leader.pid!, 'SIGKILL')
        } catch {
          /* already reaped */
        }
        await exited
        if (childPid)
          await vi.waitFor(() => expect(processIsAlive(childPid!)).toBe(false), { timeout: 5000 })
      }
    },
    15000
  )

  it('persists Darwin recovery identities across a failed cleanup and a new owner', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-mac-checkpoint-'))
    const first = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'darwin' })
    const intent = first.beginSpawn({
      laneKey: 'lane',
      processKey: 'python:default-python',
      kernelEpochId: 'old'
    })
    const receipt = first.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })
    const identities = [{ pid: 4243, uniqueId: '123456' }]
    const failed = new KernelProcessLifecycleOwner({
      storageRoot: root,
      platform: 'darwin',
      controller: {
        probe: async () => 'owned',
        terminate: async (_record, checkpoint) => {
          checkpoint!(identities)
          return { reaped: false }
        }
      }
    })
    await expect(failed.ensureReady()).rejects.toThrow('KERNEL_STARTUP_FENCE')
    expect(JSON.parse(await readFile(receipt.path, 'utf8')).darwinRecoveryProcesses).toEqual(
      identities
    )
    const probe = vi.fn(async () => 'unknown' as const)
    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      platform: 'darwin',
      controller: { probe, terminate: async () => ({ reaped: false }) }
    })
    await expect(restarted.ensureReady()).rejects.toThrow('KERNEL_STARTUP_FENCE')
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ darwinRecoveryProcesses: identities }),
      expect.any(Function)
    )
  })

  it.skipIf(process.platform !== 'darwin')(
    'reaps a real child forked into a new session during TERM',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'kernel-mac-term-fork-'))
      const childFile = join(root, 'child-pid')
      const first = new KernelProcessLifecycleOwner({ storageRoot: root })
      const token = first.createOwnerToken()
      const intent = first.beginSpawn(
        { laneKey: 'lane', processKey: 'python:default-python', kernelEpochId: 'term-fork' },
        token
      )
      const leader = spawn(
        process.execPath,
        [
          '-e',
          `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        require('node:fs').writeFileSync(${JSON.stringify(childFile)}, String(child.pid));
        process.exit(0);
      });
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `
        ],
        {
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, ...first.environment(token) }
        }
      )
      const exited = once(leader, 'exit')
      try {
        await once(leader.stdout!, 'data')
        first.recordSpawned(intent, {
          pid: leader.pid!,
          posixBirthToken: processBirthIdentity(leader.pid!)
        })
        await new KernelProcessLifecycleOwner({ storageRoot: root }).ensureReady()
        await exited
        const childPid = Number(await readFile(childFile, 'utf8'))
        expect(processIsAlive(childPid)).toBe(false)
        expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
      } finally {
        leader.kill('SIGKILL')
        await exited
        const childPid = Number(await readFile(childFile, 'utf8').catch(() => '0'))
        if (childPid) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch {
            /* already reaped */
          }
          await vi.waitFor(() => expect(processIsAlive(childPid)).toBe(false), { timeout: 5000 })
        }
      }
    },
    15000
  )

  it('does not claim a leaderless same-boot POSIX group by numeric id alone', async () => {
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === -4242) return true
      throw Object.assign(new Error('missing'), { code: 'ESRCH' })
    })

    await expect(
      defaultController('linux', () => bootA).probe({
        version: 1,
        receiptId: 'receipt-reused',
        ownerInstanceId: 'owner-a',
        ownerToken: 'owner-token-a',
        platform: 'linux',
        spawnedAt: 1,
        laneKey: 'lane-a',
        processKey: 'repl',
        kernelEpochId: 'epoch-a',
        pid: 4242,
        bootToken: bootA
      })
    ).resolves.toBe('unknown')
  })

  it('rolls back an interrupted pre-admission spawn intent on the next startup', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-pre-spawn-'))
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a'
    })
    await first.ensureReady()
    first.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'python:default-python',
      kernelEpochId: 'epoch-pre-spawn'
    })

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b'
    })
    await restarted.ensureReady()

    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
  })

  it('cleans proof files when recovery cancels a stale pending receipt', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-pending-proof-'))
    const proofPath = join(root, '.open-science-process-tree-terminated-proof.proof')
    const proof = {
      path: proofPath,
      token: 'proof-token',
      requestPath: `${proofPath}.request`
    }
    const first = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
    await first.ensureReady()
    first.beginSpawn(
      {
        laneKey: 'lane-a',
        processKey: 'repl',
        kernelEpochId: 'epoch-a'
      },
      'owner-token-a',
      proof
    )
    await writeFile(proof.path, 'proof')
    await writeFile(proof.requestPath, proof.token)

    const restarted = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'win32' })
    await restarted.ensureReady()

    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
    await expect(readFile(proof.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(proof.requestPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains the published POSIX birth receipt when a late parent supplies a different birth', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-birth-conflict-'))
    const owner = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'linux' })
    await owner.ensureReady()
    const intent = owner.beginSpawn({
      laneKey: 'lane',
      processKey: 'repl',
      kernelEpochId: 'epoch'
    })
    owner.recordSpawned(intent, { pid: 4242, posixBirthToken: 'linux-proc-starttime:100' })
    expect(() =>
      owner.recordSpawned(intent, {
        pid: 4242,
        posixBirthToken: 'linux-proc-starttime:200'
      })
    ).toThrow('identity changed')
    expect(JSON.parse(await readFile(intent.activePath(4242), 'utf8')).posixBirthToken).toBe(
      'linux-proc-starttime:100'
    )
  })

  it('retains the fence instead of publishing a POSIX process without birth proof', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-birth-missing-'))
    const owner = new KernelProcessLifecycleOwner({ storageRoot: root, platform: 'linux' })
    await owner.ensureReady()
    const intent = owner.beginSpawn({
      laneKey: 'lane',
      processKey: 'repl',
      kernelEpochId: 'epoch'
    })
    expect(() => owner.recordSpawned(intent, { pid: 4242 })).toThrow('birth identity')
    expect(JSON.parse(await readFile(intent.activePath(4242), 'utf8')).pid).toBeUndefined()
    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toHaveLength(1)
  })

  it('prevents a delayed process host from activating after recovery cancels its intent', async () => {
    root = await mkdtemp(join(tmpdir(), 'kernel-process-cancelled-host-'))
    const first = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-a'
    })
    await first.ensureReady()
    const intent = first.beginSpawn({
      laneKey: '["project-1","session-1","root",null,null]',
      processKey: 'repl',
      kernelEpochId: 'epoch-delayed-host'
    })
    const marker = join(root, 'must-not-run.txt')

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b'
    })
    await restarted.ensureReady()

    const host = spawn(
      process.execPath,
      [
        join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
        intent.path,
        intent.record.receiptId,
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    )
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      host.once('error', reject)
      host.once('exit', resolve)
    })

    expect(exitCode).toBe(125)
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  describe.runIf(process.platform !== 'win32')('POSIX startup recovery', () => {
    it.each(['host-first', 'parent-first', 'host-first-parent-without-birth'])(
      'recovers the real process host with publication order %s',
      async (order) => {
        root = await mkdtemp(join(tmpdir(), 'kernel-process-host-recovery-'))
        const first = new KernelProcessLifecycleOwner({
          storageRoot: root,
          ownerInstanceId: 'owner-a',
          readBootToken: () => BOOT_TOKEN
        })
        await first.ensureReady()
        const ownerToken = first.createOwnerToken()
        const intent = first.beginSpawn(
          {
            laneKey: '["project-1","session-1","root",null,null]',
            processKey: 'repl',
            kernelEpochId: 'epoch-host-crash-window'
          },
          ownerToken
        )
        const host = spawn(
          process.execPath,
          [
            ...(order === 'parent-first'
              ? ['-e', "process.stdin.once('data', () => require(process.argv[1]))"]
              : []),
            join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
            intent.path,
            intent.record.receiptId,
            process.execPath,
            '-e',
            'setInterval(() => undefined, 1_000)'
          ],
          {
            detached: true,
            stdio: order === 'parent-first' ? ['pipe', 'ignore', 'ignore'] : 'ignore',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...first.environment(ownerToken) }
          }
        )
        const pid = host.pid!
        if (order === 'parent-first') {
          trackOwnedPosixProcessTree(host)
          trackedChildren.push(host)
          first.recordSpawned(intent, {
            pid,
            posixBirthToken: capturePosixProcessTreeIdentity(host)?.birthToken
          })
          host.stdin!.end('start')
        }
        await vi.waitFor(async () => {
          // The parent can publish the birth token first. Only the host writes its identity marker.
          const record = JSON.parse(await readFile(intent.activePath(pid), 'utf8'))
          expect(record.commandIdentityMarker).toBe(intent.record.receiptId)
          expect(record.posixBirthToken).toEqual(expect.any(String))
        })

        if (order === 'host-first-parent-without-birth') first.recordSpawned(intent, { pid })

        const restarted = new KernelProcessLifecycleOwner({
          storageRoot: root,
          ownerInstanceId: 'owner-b',
          readBootToken: () => BOOT_TOKEN
        })
        await restarted.ensureReady()

        await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 5_000 })
        expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
      },
      15_000
    )

    it.each(['current', 'legacy'])(
      'verifies and reaps a real orphaned process group before admission (%s)',
      async (format) => {
        root = await mkdtemp(join(tmpdir(), 'kernel-process-posix-recovery-'))
        const first = new KernelProcessLifecycleOwner({
          storageRoot: root,
          ownerInstanceId: 'owner-a',
          readBootToken: () => BOOT_TOKEN
        })
        await first.ensureReady()
        const ownerToken = first.createOwnerToken()
        const intent = first.beginSpawn(
          {
            laneKey: '["project-1","session-1","root",null,null]',
            processKey: 'python:default-python',
            kernelEpochId: 'epoch-posix'
          },
          ownerToken
        )
        const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ...first.environment(ownerToken) }
        })
        trackOwnedPosixProcessTree(child)
        trackedChildren.push(child)
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
        const pid = child.pid!
        first.recordSpawned(intent, {
          pid,
          processStartToken: readProcessStartToken(pid),
          posixBirthToken: capturePosixProcessTreeIdentity(child)?.birthToken
        })

        if (format === 'legacy') {
          const path = intent.activePath(pid)
          const record = JSON.parse(await readFile(path, 'utf8'))
          delete record.posixBirthToken
          await writeFile(path, JSON.stringify(record))
        }
        const restarted = new KernelProcessLifecycleOwner({
          storageRoot: root,
          ownerInstanceId: 'owner-b',
          readBootToken: () => BOOT_TOKEN
        })
        try {
          await restarted.ensureReady()
          await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 5_000 })
          expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
        } finally {
          await terminateProcessTree(child)
        }
      },
      15_000
    )
  })

  describe.skipIf(process.platform !== 'win32')('Windows startup recovery', () => {
    it('keeps a legacy proofless receipt fenced after the host exits', async () => {
      root = await mkdtemp(join(tmpdir(), 'kernel-process-windows-recovery-'))
      const probe = vi.fn().mockResolvedValue('unknown' as const)
      const terminate = vi.fn().mockResolvedValue({ reaped: false })
      const first = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-a',
        platform: 'win32',
        controller: { probe, terminate }
      })
      await first.ensureReady()
      const intent = first.beginSpawn(
        {
          laneKey: '["project-1","session-1","root",null,null]',
          processKey: 'repl',
          kernelEpochId: 'epoch-windows'
        },
        'owner-token-a'
      )
      first.recordSpawned(intent, { pid: 4242, posixBirthToken: 'fixture-birth' })

      const restarted = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-b',
        platform: 'win32',
        controller: { probe, terminate }
      })

      await expect(restarted.ensureReady()).rejects.toThrow('KERNEL_STARTUP_FENCE')
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toHaveLength(1)
      expect(terminate).not.toHaveBeenCalled()
    })
  })
})

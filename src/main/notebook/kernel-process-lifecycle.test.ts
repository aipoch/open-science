import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  defaultController,
  KernelProcessLifecycleOwner
} from './kernel-process-lifecycle.windows-posix'
import { readProcessStartToken } from './operation-recovery'

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

  afterEach(async () => {
    vi.restoreAllMocks()
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
      })
    )
    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
  })

  it.each([
    { probe: 'owned', reaped: true, foreign: false, removed: true },
    { probe: 'dead', reaped: false, foreign: false, removed: true },
    { probe: 'reused', reaped: false, foreign: false, removed: true },
    { probe: 'owned', reaped: false, foreign: false, removed: false },
    { probe: 'unknown', reaped: false, foreign: false, removed: false },
    { probe: 'owned', reaped: true, foreign: true, removed: false }
  ] as const)(
    'handles interrupted host receipt writes after recovery ($probe, reaped=$reaped, foreign=$foreign)',
    async ({ probe, reaped, foreign, removed }) => {
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
      const receipt = first.recordSpawned(intent, { pid: 4242 })
      const temporary = `${receipt.path}.4242.tmp`
      const contents = await readFile(receipt.path, 'utf8')
      await writeFile(
        temporary,
        foreign
          ? JSON.stringify({ ...JSON.parse(contents), ownerToken: 'different-owner' })
          : contents
      )
      // The host publishes the active filename before persisting its PID in the receipt.
      await writeFile(receipt.path, JSON.stringify(intent.record))
      const terminate = vi.fn(async () => {
        expect(await readFile(temporary, 'utf8')).toBeTruthy()
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
      }
      expect(terminate).toHaveBeenCalledTimes(probe === 'owned' ? 1 : 0)
      if (removed) {
        await expect(readFile(temporary, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(await readFile(temporary, 'utf8')).toBeTruthy()
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
    first.recordSpawned(intent, { pid: 5252, commandIdentityMarker: 'marker-repl' })

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
    first.recordSpawned(intent, { pid: 4242 })

    const restarted = new KernelProcessLifecycleOwner({
      storageRoot: root,
      ownerInstanceId: 'owner-b',
      platform: 'linux',
      readBootToken: () => bootB
    })

    await restarted.ensureReady()

    expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
  })

  it('does not probe or signal a numeric POSIX group after a proven reboot', async () => {
    const kill = vi.spyOn(process, 'kill')
    const controller = defaultController('linux', () => bootB)

    await expect(
      controller.probe({
        version: 1,
        receiptId: 'receipt-a',
        ownerInstanceId: 'owner-a',
        ownerToken: 'owner-token-a',
        platform: 'linux',
        spawnedAt: 1,
        laneKey: 'lane-a',
        processKey: 'repl',
        kernelEpochId: 'epoch-a',
        pid: process.pid,
        bootToken: bootA
      })
    ).resolves.toBe('dead')

    expect(kill).not.toHaveBeenCalledWith(-process.pid, 0)
  })

  it('treats a missing macOS process group as dead without a boot token', async () => {
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
  })

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

  describe.runIf(process.platform === 'linux')('POSIX startup recovery', () => {
    it('recovers a process host that survived before its main owner recorded the PID', async () => {
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
          join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
          intent.path,
          intent.record.receiptId,
          process.execPath,
          '-e',
          'setInterval(() => undefined, 1_000)'
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...first.environment(ownerToken) }
        }
      )
      const pid = host.pid!
      await vi.waitFor(async () => {
        const names = await readdir(join(root!, 'runtime', 'kernel-processes'))
        expect(names).toContainEqual(expect.stringContaining(`.active.${pid}.`))
      })

      const restarted = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-b',
        readBootToken: () => BOOT_TOKEN
      })
      await restarted.ensureReady()

      await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 5_000 })
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
    }, 15_000)

    it('verifies and reaps a real orphaned process group before admission', async () => {
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
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const pid = child.pid!
      first.recordSpawned(intent, {
        pid,
        processStartToken: readProcessStartToken(pid)
      })

      const restarted = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-b',
        readBootToken: () => BOOT_TOKEN
      })
      await restarted.ensureReady()

      await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 5_000 })
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
    }, 15_000)
  })

  describe.skipIf(process.platform !== 'win32')('Windows startup recovery', () => {
    it('verifies a real command identity and taskkills its complete process tree', async () => {
      root = await mkdtemp(join(tmpdir(), 'kernel-process-windows-recovery-'))
      const first = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-a'
      })
      await first.ensureReady()
      const ownerToken = first.createOwnerToken()
      const marker = `open-science-kernel-${ownerToken}`
      const intent = first.beginSpawn(
        {
          laneKey: '["project-1","session-1","root",null,null]',
          processKey: 'repl',
          kernelEpochId: 'epoch-windows'
        },
        ownerToken
      )
      const child = spawn(
        process.execPath,
        [
          '-e',
          "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']); setInterval(()=>{},1000)",
          marker
        ],
        { windowsHide: true, env: { ...process.env, ...first.environment(ownerToken) } }
      )
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const pid = child.pid!
      first.recordSpawned(intent, { pid, commandIdentityMarker: marker })

      const restarted = new KernelProcessLifecycleOwner({
        storageRoot: root,
        ownerInstanceId: 'owner-b'
      })
      await restarted.ensureReady()

      await vi.waitFor(() => expect(processIsAlive(pid)).toBe(false), { timeout: 5_000 })
      expect(await readdir(join(root, 'runtime', 'kernel-processes'))).toEqual([])
    }, 20_000)
  })
})

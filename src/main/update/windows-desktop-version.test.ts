import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { UpdateLifecycleError } from '../../shared/update'
import * as windowsProcesses from '../windows-process-query'
import {
  checkColdLaunchOccupancy,
  preparedWindowsUpdateId,
  readPreparedWindowsUpdate,
  reclaimInstalledWindowsUpdates,
  startWindowsUpdateSupervisor
} from './windows-desktop-version'

it.runIf(process.platform === 'win32')(
  'executes the hidden supervisor and passes launch data literally',
  async () => {
    const value = '"a & b" %PATH% !bang!'
    const pending = await mkdtemp(join(tmpdir(), 'update-worker-'))
    try {
      const result = join(pending, 'result')
      const accepted = await startWindowsUpdateSupervisor(
        "[IO.File]::WriteAllText($env:PROBE_RESULT, $env:OPEN_SCIENCE_UPDATE_ARGUMENTS)\n[IO.File]::WriteAllText($env:OPEN_SCIENCE_UPDATE_ACK, '')",
        pending,
        { ...process.env, PROBE_RESULT: result, OPEN_SCIENCE_UPDATE_ARGUMENTS: value }
      )
      expect(accepted).toBe(true)
      expect(await readFile(result, 'utf8')).toBe(value)
    } finally {
      await rm(pending, { recursive: true, force: true, maxRetries: 5 })
    }
  }
)

it('selects the SDK package alongside a claimed older package and reclaims both after installation', async ({
  onTestFinished
}) => {
  const cache = await mkdtemp(join(tmpdir(), 'prepared-desktop-'))
  onTestFinished(() => rm(cache, { recursive: true, force: true }))
  const pending = join(cache, 'pending')
  const root = join(cache, 'open-science-prepared')
  await mkdir(pending)
  await writeFile(join(cache, 'desktop.exe'), '')
  const executable = await realpath(join(cache, 'desktop.exe'))
  const sha512 = createHash('sha512').update('signed setup').digest('base64')
  const receipt = { version: '1.2.0', executable, sha512, fileName: 'setup.exe' }
  const read = (current = '1.1.0'): ReturnType<typeof readPreparedWindowsUpdate> =>
    readPreparedWindowsUpdate(pending, executable, current)
  const stage = join(root, preparedWindowsUpdateId(executable, sha512))
  const older = {
    ...receipt,
    version: '1.1.1',
    sha512: createHash('sha512').update('older setup').digest('base64')
  }
  const claimed = join(root, preparedWindowsUpdateId(executable, older.sha512))
  await mkdir(claimed, { recursive: true })
  await writeFile(join(claimed, 'installing.json'), JSON.stringify(older))
  await mkdir(stage)
  expect(await read()).toBeUndefined()
  await writeFile(join(stage, 'ready.json'), JSON.stringify(receipt))
  const info = join(pending, 'update-info.json')
  await writeFile(info, JSON.stringify({ fileName: 'setup.exe', sha512: 'replaced' }))
  expect(await read()).toBeUndefined()
  await writeFile(info, JSON.stringify({ fileName: 'setup.exe', sha512 }))
  expect(await read()).toEqual(receipt)
  expect(await readPreparedWindowsUpdate(pending, cache + '/./desktop.exe', '1.1.0')).toEqual(
    receipt
  )
  expect(await read('1.2.0')).toBeUndefined()
  await writeFile(join(cache, 'other.exe'), '')
  expect(
    await readPreparedWindowsUpdate(pending, join(cache, 'other.exe'), '1.1.0')
  ).toBeUndefined()
  await reclaimInstalledWindowsUpdates(pending, executable, '1.1.0')
  expect(await readdir(root)).toHaveLength(2)
  const started = Promise.withResolvers<AbortSignal>()
  const lateScan = Promise.withResolvers<void>()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const allowed = checkColdLaunchOccupancy(stage, (signal) => {
      started.resolve(signal)
      return lateScan.promise
    })
    const signal = await started.promise
    await vi.advanceTimersByTimeAsync(9_999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await allowed).toBe(false)
    expect(signal.aborted).toBe(true)
    lateScan.resolve()
    // The next cold launch sees no ready receipt. Manual download/apply still owns its SDK cache.
    expect(await read()).toBeUndefined()
    expect(JSON.parse(await readFile(info, 'utf8'))).toEqual({ fileName: 'setup.exe', sha512 })
  } finally {
    vi.useRealTimers()
  }
  await reclaimInstalledWindowsUpdates(pending, executable, '1.2.0')
  expect(await readdir(root)).toEqual([])
})

it('skips the scan while a known holder lives and rechecks after exit or PID reuse', async ({
  onTestFinished
}) => {
  const stage = await mkdtemp(join(tmpdir(), 'prepared-holders-'))
  onTestFinished(() => rm(stage, { recursive: true, force: true }))
  const identities = new Map([
    [3, '123'],
    [4, '456']
  ])
  const starts = vi
    .spyOn(windowsProcesses, 'windowsProcessStartTicks')
    .mockImplementation((pid) => identities.get(pid))
  onTestFinished(() => {
    starts.mockRestore()
  })
  const busy = new UpdateLifecycleError('installation-busy', 'busy', {
    phase: 'preparing',
    runtime: 'running',
    installation: 'unchanged',
    detail: 'foreign-process',
    canCancel: true,
    canRecover: false,
    canRetryInstall: false,
    blockingProcesses: [{ pid: 3 }, { pid: 4 }]
  })
  const scan = vi.fn<() => Promise<void>>().mockRejectedValueOnce(busy).mockResolvedValue(undefined)
  await expect(checkColdLaunchOccupancy(stage, scan)).rejects.toBe(busy)
  expect(await checkColdLaunchOccupancy(stage, scan)).toBe(false)
  identities.delete(3)
  expect(await checkColdLaunchOccupancy(stage, scan)).toBe(false)
  expect(scan).toHaveBeenCalledTimes(1)
  identities.set(4, '789')
  expect(await checkColdLaunchOccupancy(stage, scan)).toBe(true)
  expect(scan).toHaveBeenCalledTimes(2)
})

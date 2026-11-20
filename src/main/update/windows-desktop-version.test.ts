import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
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
  await reclaimInstalledWindowsUpdates(pending, executable, '1.2.0')
  expect(await readdir(root)).toEqual([])
})

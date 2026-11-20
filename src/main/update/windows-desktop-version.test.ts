import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readPreparedWindowsUpdate } from './windows-desktop-version'

it('only offers a complete receipt for this installation and the matching SDK download', async () => {
  const pending = await mkdtemp(join(tmpdir(), 'prepared-desktop-'))
  const executable = join(pending, 'desktop.exe')
  const sha512 = createHash('sha512').update('signed setup').digest('base64')
  const receipt = { version: '1.2.0', executable, sha512, fileName: 'setup.exe' }
  const read = (current = '1.1.0'): ReturnType<typeof readPreparedWindowsUpdate> =>
    readPreparedWindowsUpdate(pending, executable, current)
  try {
    await mkdir(join(pending, 'open-science-prepared'))
    expect(await read()).toBeUndefined()
    await writeFile(join(pending, 'open-science-prepared', 'ready.json'), JSON.stringify(receipt))
    const info = join(pending, 'update-info.json')
    await writeFile(info, JSON.stringify({ fileName: 'setup.exe', sha512: 'replaced' }))
    expect(await read()).toBeUndefined()
    await writeFile(info, JSON.stringify({ fileName: 'setup.exe', sha512 }))
    expect(await read()).toEqual(receipt)
    expect(await read('1.2.0')).toBeUndefined()
    expect(
      await readPreparedWindowsUpdate(pending, join(pending, 'other.exe'), '1.1.0')
    ).toBeUndefined()
  } finally {
    await rm(pending, { recursive: true, force: true })
  }
})

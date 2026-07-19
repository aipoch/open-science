import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { locateApp } from './locate-app.mjs'

describe('locateApp', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'os-locate-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves an explicit --app-path to a packaged executable', async () => {
    const exe = join(dir, 'Open Science')
    await writeFile(exe, '')
    // Empty env so repository discovery can't shadow the explicit override.
    const app = await locateApp({ appPath: exe, env: {} })
    expect(app).toMatchObject({ command: exe, args: [], packaged: true })
  })

  it('honors OPEN_SCIENCE_APP_PATH when no --app-path is given', async () => {
    const exe = join(dir, 'app-binary')
    await writeFile(exe, '')
    const app = await locateApp({ env: { OPEN_SCIENCE_APP_PATH: exe } })
    expect(app.command).toBe(exe)
    expect(app.packaged).toBe(true)
  })

  it('throws a helpful error when the explicit path does not exist', async () => {
    await expect(locateApp({ appPath: join(dir, 'missing'), env: {} })).rejects.toThrow(/not found/)
  })
})

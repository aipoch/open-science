import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  appImageVersion,
  assertPackagedResources,
  findOne,
  parseArguments,
  parsePackagedAppEndpoint
} from './linux-package-smoke.mjs'

describe('Linux package smoke', () => {
  it('discovers one AppImage and derives stable or nightly versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-linux-artifacts-'))
    const appImage = join(root, 'aipoch-open-science-0.11.0-nightly.abc1234-linux-x64.AppImage')
    await writeFile(appImage, '')

    await expect(findOne(root, /\.AppImage$/, 'AppImage')).resolves.toBe(appImage)
    expect(appImageVersion(appImage)).toBe('0.11.0-nightly.abc1234')
    await writeFile(join(root, 'second.AppImage'), '')
    await expect(findOne(root, /\.AppImage$/, 'AppImage')).rejects.toThrow(/exactly one/)
  })

  it('parses only the authenticated packaged-app endpoint', () => {
    expect(
      parsePackagedAppEndpoint('Open Science Web: http://127.0.0.1:44001/?token=linux_smoke-token')
    ).toEqual({
      endpoint: 'http://127.0.0.1:44001',
      auth: 'token=linux_smoke-token'
    })
    expect(parsePackagedAppEndpoint('Open Science Web: http://127.0.0.1:44001/')).toBeUndefined()
  })

  it('requires explicit package and installed executable paths', () => {
    expect(
      parseArguments(['--artifact-dir', 'dist', '--installed-executable', '/usr/bin/open-science'])
    ).toMatchObject({ installedExecutable: '/usr/bin/open-science' })
    expect(() => parseArguments([])).toThrow(/Usage:/)
  })

  it('fails closed when a packaged runtime resource is missing', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'open-science-linux-package-'))
    const executable = join(appRoot, 'open-science')
    await writeFile(executable, '')
    await mkdir(join(appRoot, 'resources'), { recursive: true })
    await writeFile(join(appRoot, 'resources', 'app.asar'), '')

    await expect(assertPackagedResources(executable)).rejects.toThrow(/micromamba/)
  })
})

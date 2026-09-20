import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveElectronProfile, type ProfileLocationOptions } from './electron-profile'

let fixture: string
let options: ProfileLocationOptions
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'brand-profile-'))
  options = { appData: fixture, configRoot: join(fixture, 'config'), packaged: true, env: {} }
})
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true })
})
const profile = async (name: string): Promise<string> => {
  const path = join(fixture, name)
  await mkdir(path)
  await writeFile(join(path, 'Preferences'), '{"research":"retained"}')
  return path
}
it.each([true, false])(
  'reuses the old profile without moving it (packaged=%s)',
  async (packaged) => {
    const old = await profile(packaged ? 'Open Science' : 'Open Science (DEV)')
    expect(resolveElectronProfile({ ...options, packaged })).toBe(old)
    expect(await readFile(join(old, 'Preferences'), 'utf8')).toContain('retained')
    expect(existsSync(join(fixture, packaged ? 'Open-Science' : 'Open-Science (DEV)'))).toBe(false)
  }
)
it('keeps the original profile when both application names have profile directories', async () => {
  const old = await profile('Open Science')
  const current = await profile('Open-Science')
  expect(resolveElectronProfile(options)).toBe(old)
  expect(await readFile(join(current, 'Preferences'), 'utf8')).toContain('retained')
})
it('preserves an existing empty old directory without interpreting its initialization state', async () => {
  const old = join(fixture, 'Open Science')
  await mkdir(old)
  expect(resolveElectronProfile(options)).toBe(old)
})
it('uses explicit isolation even when system profiles coexist', async () => {
  await profile('Open Science')
  await profile('Open-Science')
  const isolated = join(fixture, 'task-profile')
  expect(
    resolveElectronProfile({
      ...options,
      env: {
        OPEN_SCIENCE_USER_DATA: ` ${isolated}/../task-profile `,
        OPEN_SCIENCE_CONFIG_ROOT: options.configRoot
      }
    })
  ).toBe(isolated)
  expect(existsSync(isolated)).toBe(false)
})
it.each(['OPEN_SCIENCE_CONFIG_ROOT', 'OPEN_SCIENCE_E2E_STORAGE_ROOT', 'OPEN_SCIENCE_STORAGE_ROOT'])(
  'uses %s as a config-derived isolated profile in development',
  (key) => {
    expect(
      resolveElectronProfile({ ...options, packaged: false, env: { [key]: options.configRoot } })
    ).toBe(join(options.configRoot, 'electron-profile'))
    expect(existsSync(options.configRoot)).toBe(false)
  }
)
it('ignores the development-only storage override in a packaged build', () => {
  expect(
    resolveElectronProfile({ ...options, env: { OPEN_SCIENCE_STORAGE_ROOT: options.configRoot } })
  ).toBe(join(fixture, 'Open-Science'))
})
it('uses new names for fresh packaged and development profiles', () => {
  expect(resolveElectronProfile(options)).toBe(join(fixture, 'Open-Science'))
  expect(resolveElectronProfile({ ...options, packaged: false })).toBe(
    join(fixture, 'Open-Science (DEV)')
  )
})
it('keeps Electron profile defaults independent of existing settings', async () => {
  await mkdir(options.configRoot)
  await writeFile(join(options.configRoot, 'settings.json'), '{"version":2,"providers":[]}')
  expect(resolveElectronProfile(options)).toBe(join(fixture, 'Open-Science'))
  expect(existsSync(join(fixture, 'Open-Science'))).toBe(false)
})
it('rejects a relative explicit path without falling back to shared profiles', () => {
  expect(() =>
    resolveElectronProfile({ ...options, env: { OPEN_SCIENCE_USER_DATA: 'relative' } })
  ).toThrow(/absolute/)
})
it('does not accept a file as an explicitly selected profile', async () => {
  const path = join(fixture, 'profile-file')
  await writeFile(path, 'preserve')
  expect(() =>
    resolveElectronProfile({ ...options, env: { OPEN_SCIENCE_USER_DATA: path } })
  ).toThrow(/not a directory/i)
  expect(await readFile(path, 'utf8')).toBe('preserve')
})
it.each([false, true])('preserves an unavailable profile link (nested=%s)', async (nested) => {
  const link = join(fixture, 'broken-profile')
  const target = join(fixture, 'unmounted')
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() =>
    resolveElectronProfile({
      ...options,
      env: { OPEN_SCIENCE_USER_DATA: nested ? join(link, 'child') : link }
    })
  ).toThrow(/profile/)
  expect(existsSync(target)).toBe(false)
})

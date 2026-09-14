import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
it('retains the legacy Electron profile rather than starting an empty profile after branding', async () => {
  const old = await profile('Open Science')
  expect(resolveElectronProfile(options)).toBe(old)
  expect(existsSync(join(fixture, 'Open-Science'))).toBe(false)
})
it('rejects two populated profiles without a recorded choice', async () => {
  await profile('Open Science')
  await profile('Open-Science')
  expect(() => resolveElectronProfile(options)).toThrow(/multiple/i)
})
it('uses explicit isolation even when system profiles coexist', async () => {
  await profile('Open Science')
  await profile('Open-Science')
  const isolated = join(fixture, 'task-profile')
  expect(resolveElectronProfile({ ...options, env: { OPEN_SCIENCE_USER_DATA: isolated } })).toBe(
    isolated
  )
})
it('uses new names for fresh packaged and development profiles', () => {
  expect(resolveElectronProfile(options)).toBe(join(fixture, 'Open-Science'))
  expect(resolveElectronProfile({ ...options, packaged: false })).toBe(
    join(fixture, 'Open-Science (DEV)')
  )
})
it('keeps the persisted location and reports its disappearance', async () => {
  const old = await profile('Open Science')
  await mkdir(options.configRoot)
  await writeFile(
    join(options.configRoot, 'electron-profile.json'),
    JSON.stringify({ version: 1, path: old })
  )
  await profile('Open-Science')
  expect(resolveElectronProfile(options)).toBe(old)
  await rm(old, { recursive: true })
  expect(() => resolveElectronProfile(options)).toThrow(/missing/i)
})

it('requires recovery when the profile selection was lost but app configuration remains', async () => {
  await mkdir(options.configRoot)
  await writeFile(join(options.configRoot, 'settings.json'), '{"dataRoot":"/custom/research"}')
  expect(() => resolveElectronProfile(options)).toThrow(/profile|recover/i)
  expect(existsSync(join(fixture, 'Open-Science'))).toBe(false)
})

it('ignores only known single-instance locks when identifying a fresh profile', async () => {
  const path = join(fixture, 'Open-Science')
  await mkdir(path)
  await writeFile(join(path, 'SingletonLock'), 'stale lock')
  const { profileHasHistory } = await import('./electron-profile')
  expect(profileHasHistory(path)).toBe(false)
  await writeFile(join(path, 'Local State'), '{}')
  expect(profileHasHistory(path)).toBe(true)
})
it('recovers an initial pending file written before its atomic rename', async () => {
  await mkdir(options.configRoot)
  const record = {
    version: 1,
    path: join(fixture, 'Open-Science'),
    bootstrap: {
      dataRoot: join(fixture, 'research', 'Open-Science'),
      createDataRoot: true,
      createProfile: true
    }
  }
  await writeFile(
    join(options.configRoot, 'electron-profile.json.bootstrap'),
    JSON.stringify(record)
  )
  expect(resolveElectronProfile(options)).toBe(record.path)
})

it('consumes an initial temporary intent so it cannot resurrect a completed missing profile', async () => {
  const { pinFreshApplicationLocations, writeElectronProfileRecord } =
    await import('./electron-profile')
  await mkdir(options.configRoot)
  const path = join(fixture, 'Open-Science')
  await writeFile(
    join(options.configRoot, 'electron-profile.json.bootstrap'),
    JSON.stringify({
      version: 1,
      path,
      bootstrap: { dataRoot: join(fixture, 'research'), createDataRoot: true, createProfile: true }
    })
  )
  pinFreshApplicationLocations({
    configRoot: options.configRoot,
    profilePath: path,
    home: fixture,
    packaged: true,
    existingInstallation: true
  })
  expect(existsSync(join(options.configRoot, 'electron-profile.json.bootstrap'))).toBe(false)
  await writeElectronProfileRecord(options.configRoot, { version: 1, path })
  await rm(join(options.configRoot, 'electron-profile.json'))
  await writeFile(join(options.configRoot, 'projects.db'), 'history')
  expect(() => resolveElectronProfile(options)).toThrow(/location|profile/i)
})

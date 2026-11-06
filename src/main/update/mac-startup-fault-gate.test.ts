import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ enabled: vi.fn(() => false) }))
vi.mock('../mac-ordinary-entry', () => ({ macEntryFaultInjectionEnabled: fixture.enabled }))
import { pauseMacVerifiedStartup } from './mac-startup-fault-gate'
import { installationStateDirectory } from './installation-protection'
const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  fixture.enabled.mockReturnValue(false)
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

it('never pauses a normal signed installation even when a pause environment is supplied', async () => {
  vi.stubEnv('OPEN_SCIENCE_MAC_STARTUP_PAUSE_AT', 'verified-ready')
  await expect(
    pauseMacVerifiedStartup({ installationRoot: '/unused' }, 'operation', '/profile')
  ).resolves.toBeUndefined()
})

it('keeps the actual ticket intact during a bounded diagnostic pause after verified readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mac-startup-gate-'))
  roots.push(root)
  const installationRoot = join(root, 'Runtime.app')
  mkdirSync(installationRoot)
  const stateRoot = join(root, 'state')
  mkdirSync(stateRoot)
  const location = { installationRoot, stateRoot }
  const directory = installationStateDirectory(location)
  mkdirSync(directory)
  const ticket = join(directory, 'verified-startup.json')
  writeFileSync(ticket, '{"operationId":"real-operation"}')
  const release = join(stateRoot, 'release')
  fixture.enabled.mockReturnValue(true)
  vi.stubEnv('OPEN_SCIENCE_MAC_STARTUP_PAUSE_AT', 'verified-ready')
  vi.stubEnv('OPEN_SCIENCE_MAC_STARTUP_RELEASE_FILE', release)
  const paused = pauseMacVerifiedStartup(location, 'real-operation', '/original-profile')
  await Promise.race([
    paused.then(() => {
      throw new Error('Diagnostic pause ended before its receipt')
    }),
    vi.waitFor(() =>
      expect(existsSync(join(directory, 'mac-verified-ready-pause.json'))).toBe(true)
    )
  ])
  expect(
    JSON.parse(readFileSync(join(directory, 'mac-verified-ready-pause.json'), 'utf8'))
  ).toMatchObject({
    operationId: 'real-operation',
    phase: 'verified-ready-before-cleanup',
    pid: process.pid,
    profilePath: '/original-profile'
  })
  expect(readFileSync(ticket, 'utf8')).toBe('{"operationId":"real-operation"}')
  writeFileSync(release, '')
  await paused
  expect(readFileSync(ticket, 'utf8')).toBe('{"operationId":"real-operation"}')
})

it('rejects a diagnostic release path outside the operation state root', async () => {
  fixture.enabled.mockReturnValue(true)
  vi.stubEnv('OPEN_SCIENCE_MAC_STARTUP_PAUSE_AT', 'verified-ready')
  vi.stubEnv('OPEN_SCIENCE_MAC_STARTUP_RELEASE_FILE', '/elsewhere/release')
  await expect(
    pauseMacVerifiedStartup(
      { installationRoot: '/unused', stateRoot: '/isolated' },
      'operation',
      '/profile'
    )
  ).rejects.toThrow('isolated release file')
})

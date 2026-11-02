import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import { electronLaunchTarget, launchEnvironment } from './fixtures/electron-app'

test('starts native Windows OpenSSH without exposing operator credentials', () => {
  test.skip(process.platform !== 'win32', 'Requires the Windows OpenSSH client.')
  const ssh = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
  test.skip(!existsSync(ssh), 'Requires the native Windows OpenSSH client.')
  const environment = launchEnvironment(
    join(tmpdir(), 'open-science-ssh-environment', 'storage'),
    undefined,
    {
      ...process.env,
      OPENAI_API_KEY: 'operator-credential-must-not-escape'
    }
  )
  expect(environment.OPENAI_API_KEY).toBeUndefined()
  const result = spawnSync(ssh, ['-V'], {
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000
  })
  expect(result.status).toBe(0)
  expect(/OpenSSH_for_Windows/i.test(result.stdout + result.stderr)).toBe(true)
})

test('normalizes a Windows-style Path before injecting the fake Agent directory', () => {
  const environment = launchEnvironment('storage-root', 'fake-agent-bin', {
    ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173',
    Path: 'system-bin'
  })

  expect(environment.PATH).toBe(`fake-agent-bin${delimiter}system-bin`)
  expect(environment.Path).toBeUndefined()
  expect(environment.ELECTRON_RENDERER_URL).toBeUndefined()
  expect(environment.OPEN_SCIENCE_STORAGE_ROOT).toBe('storage-root')
  expect(environment.OPEN_SCIENCE_E2E_WINDOW_MODE).toBe('hidden')
})

test('isolates source E2E storage and initializes the matching Electron home', () => {
  const environment = launchEnvironment('storage-root', undefined, { HOME: 'host-home' })

  expect(environment.OPEN_SCIENCE_E2E_STORAGE_ROOT).toBe('storage-root')
  expect(environment.OPEN_SCIENCE_STORAGE_ROOT).toBe('storage-root')
  expect(environment.HOME).toBe('isolated home')
  expect(environment.APPDATA).toBe(join('isolated home', 'AppData', 'Roaming'))
  expect(environment.OPEN_SCIENCE_E2E_ISOLATE_HOME).toBe('1')
})

test('isolates packaged certification storage and process home', () => {
  const environment = launchEnvironment('storage-root', undefined, {
    OPEN_SCIENCE_E2E_EXECUTABLE: '/artifacts/Open-Science'
  })

  expect(environment.OPEN_SCIENCE_E2E_STORAGE_ROOT).toBe('storage-root')
  expect(environment.OPEN_SCIENCE_STORAGE_ROOT).toBe('storage-root')
  expect(environment.HOME).toBe('isolated home')
})

test('allows native window-system tests to opt into normal presentation', () => {
  const environment = launchEnvironment('storage-root', undefined, {}, undefined, 'normal')

  expect(environment.OPEN_SCIENCE_E2E_WINDOW_MODE).toBe('normal')
})

test('enables Session CPU tracing only for an active local performance profile', () => {
  const ordinary = launchEnvironment('storage-root', undefined, {})
  const profiled = launchEnvironment('storage-root', undefined, {}, undefined, 'hidden', true)

  expect(ordinary.OPEN_SCIENCE_PERF_SESSION_TRACE).toBeUndefined()
  expect(profiled.OPEN_SCIENCE_PERF_SESSION_TRACE).toBe('1')
})

test('uses the native secret-service password store for Linux E2E profiles', () => {
  expect(electronLaunchTarget('profile-root', {}, 'linux')).toEqual({
    args: [
      '--user-data-dir=profile-root',
      '--password-store=gnome-libsecret',
      '--require',
      expect.stringContaining('node-runtime-preload.cjs'),
      expect.any(String)
    ]
  })
  expect(electronLaunchTarget('profile-root', {}, 'darwin')).toEqual({
    args: [
      '--user-data-dir=profile-root',
      '--use-mock-keychain',
      '--require',
      expect.stringContaining('mock-credential-identity.cjs'),
      '--require',
      expect.stringContaining('node-runtime-preload.cjs'),
      expect.any(String)
    ]
  })
  expect(electronLaunchTarget('profile-root', {}, 'win32')).toEqual({
    args: [
      '--user-data-dir=profile-root',
      '--require',
      expect.stringContaining('node-runtime-preload.cjs'),
      expect.any(String)
    ]
  })
})

test('launches packaged and source applications with the expected Linux arguments', () => {
  expect(
    electronLaunchTarget(
      'profile-root',
      {
        OPEN_SCIENCE_E2E_EXECUTABLE: '/artifacts/Open-Science.app/Contents/MacOS/Open-Science'
      },
      'linux'
    )
  ).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=gnome-libsecret'],
    executablePath: '/artifacts/Open-Science.app/Contents/MacOS/Open-Science'
  })
  expect(electronLaunchTarget('profile-root', {}, 'linux')).toEqual({
    args: [
      '--user-data-dir=profile-root',
      '--password-store=gnome-libsecret',
      '--require',
      expect.stringContaining('node-runtime-preload.cjs'),
      expect.any(String)
    ]
  })
})

test('uses the real Keychain and native identity probe for packaged macOS E2E', () => {
  expect(
    electronLaunchTarget(
      'profile-root',
      {
        OPEN_SCIENCE_E2E_EXECUTABLE: '/artifacts/Open-Science.app/Contents/MacOS/Open-Science'
      },
      'darwin'
    )
  ).toEqual({
    args: ['--user-data-dir=profile-root'],
    executablePath: '/artifacts/Open-Science.app/Contents/MacOS/Open-Science'
  })
})

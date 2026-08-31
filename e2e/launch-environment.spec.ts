import { expect, test } from '@playwright/test'
import { delimiter } from 'node:path'
import { electronLaunchTarget, launchEnvironment } from './fixtures/electron-app'

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

test('isolates source E2E data storage without changing the process home', () => {
  const environment = launchEnvironment('storage-root', undefined, { HOME: 'host-home' })

  expect(environment.OPEN_SCIENCE_E2E_STORAGE_ROOT).toBe('storage-root')
  expect(environment.OPEN_SCIENCE_STORAGE_ROOT).toBe('storage-root')
  expect(environment.HOME).toBe('host-home')
})

test('isolates packaged certification storage without changing the process home', () => {
  const environment = launchEnvironment('storage-root', undefined, {
    OPEN_SCIENCE_E2E_EXECUTABLE: '/artifacts/Open Science'
  })

  expect(environment.OPEN_SCIENCE_E2E_STORAGE_ROOT).toBe('storage-root')
  expect(environment.OPEN_SCIENCE_STORAGE_ROOT).toBe('storage-root')
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

test('enables the basic password store only for Linux E2E profiles', () => {
  expect(electronLaunchTarget('profile-root', {}, 'linux')).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=basic', expect.any(String)]
  })
  expect(electronLaunchTarget('profile-root', {}, 'darwin')).toEqual({
    args: ['--user-data-dir=profile-root', expect.any(String)]
  })
  expect(electronLaunchTarget('profile-root', {}, 'win32')).toEqual({
    args: ['--user-data-dir=profile-root', expect.any(String)]
  })
})

test('launches packaged and source applications with the expected Linux arguments', () => {
  expect(
    electronLaunchTarget(
      'profile-root',
      {
        OPEN_SCIENCE_E2E_EXECUTABLE: '/artifacts/Open Science.app/Contents/MacOS/Open Science'
      },
      'linux'
    )
  ).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=basic'],
    executablePath: '/artifacts/Open Science.app/Contents/MacOS/Open Science'
  })
  expect(electronLaunchTarget('profile-root', {}, 'linux')).toEqual({
    args: ['--user-data-dir=profile-root', '--password-store=basic', expect.any(String)]
  })
})

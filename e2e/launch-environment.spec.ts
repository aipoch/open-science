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
})

test('launches the packaged executable without the source application argument when configured', () => {
  expect(
    electronLaunchTarget('profile-root', {
      OPEN_SCIENCE_E2E_EXECUTABLE: '/artifacts/Open Science.app/Contents/MacOS/Open Science'
    })
  ).toEqual({
    args: ['--user-data-dir=profile-root'],
    executablePath: '/artifacts/Open Science.app/Contents/MacOS/Open Science'
  })
  expect(electronLaunchTarget('profile-root', {})).toEqual({
    args: ['--user-data-dir=profile-root', expect.any(String)]
  })
})

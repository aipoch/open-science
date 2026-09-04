import { describe, expect, it } from 'vitest'

import {
  relocateManagedRuntimeEnablement,
  relocatedManagedRuntimeId
} from './managed-runtime-relocation'

describe('relocatedManagedRuntimeId', () => {
  it.each([
    {
      scenario: 'Linux named Python',
      platform: 'linux' as const,
      language: 'python' as const,
      fromDataRoot: '/mnt/old/OpenScience',
      toDataRoot: '/mnt/new/OpenScience',
      runtimeId: '/mnt/old/OpenScience/runtime/envs/analysis/bin/python',
      expected: '/mnt/new/OpenScience/runtime/envs/analysis/bin/python'
    },
    {
      scenario: 'macOS default R',
      platform: 'darwin' as const,
      language: 'r' as const,
      fromDataRoot: '/Volumes/Old/OpenScience',
      toDataRoot: '/Volumes/New/OpenScience',
      runtimeId: '/Volumes/Old/OpenScience/runtime/envs/default-r/bin/R',
      expected: '/Volumes/New/OpenScience/runtime/envs/default-r/bin/R'
    },
    {
      scenario: 'Windows legacy default Python',
      platform: 'win32' as const,
      language: 'python' as const,
      fromDataRoot: 'D:\\Old\\OpenScience',
      toDataRoot: 'E:\\New\\OpenScience',
      runtimeId: 'd:\\OLD\\OPENSCIENCE\\runtime\\envs\\DEFAULT-PYTHON\\PYTHON.EXE',
      expected: 'E:\\New\\OpenScience\\runtime\\envs\\.p\\python.exe'
    },
    {
      scenario: 'Windows legacy default R',
      platform: 'win32' as const,
      language: 'r' as const,
      fromDataRoot: 'D:\\Old\\OpenScience',
      toDataRoot: 'E:\\New\\OpenScience',
      runtimeId: 'd:\\OLD\\OPENSCIENCE\\runtime\\envs\\DEFAULT-R\\lib\\r\\BIN\\r.exe',
      expected: 'E:\\New\\OpenScience\\runtime\\envs\\.r\\Lib\\R\\bin\\R.exe'
    },
    {
      scenario: 'Windows named Python',
      platform: 'win32' as const,
      language: 'python' as const,
      fromDataRoot: 'D:\\Old\\OpenScience',
      toDataRoot: 'E:\\New\\OpenScience',
      runtimeId: 'D:\\Old\\OpenScience\\runtime\\envs\\Analysis\\python.exe',
      expected: 'E:\\New\\OpenScience\\runtime\\envs\\Analysis\\python.exe'
    },
    {
      scenario: 'Windows named R',
      platform: 'win32' as const,
      language: 'r' as const,
      fromDataRoot: 'D:\\Old\\OpenScience',
      toDataRoot: 'E:\\New\\OpenScience',
      runtimeId: 'D:\\Old\\OpenScience\\runtime\\envs\\Analysis\\Lib\\R\\bin\\R.exe',
      expected: 'E:\\New\\OpenScience\\runtime\\envs\\Analysis\\Lib\\R\\bin\\R.exe'
    }
  ])('relocates $scenario using the managed layout', (testCase) => {
    expect(relocatedManagedRuntimeId(testCase)).toBe(testCase.expected)
  })

  it.each([
    '/opt/external/runtime/envs/analysis/bin/python',
    '/mnt/old/OpenScience/runtime/envs/analysis/Scripts/python',
    '/mnt/old/OpenScience/runtime/envs/.hidden/bin/python',
    '/mnt/old/OpenScience/other/runtime/envs/analysis/bin/python'
  ])('rejects a non-managed or invalid POSIX path: %s', (runtimeId) => {
    expect(
      relocatedManagedRuntimeId({
        fromDataRoot: '/mnt/old/OpenScience',
        toDataRoot: '/mnt/new/OpenScience',
        language: 'python',
        platform: 'linux',
        runtimeId
      })
    ).toBeUndefined()
  })

  it('relocates disabled Windows Python and R overrides without changing other preferences', () => {
    const previousPython = 'd:\\OLD\\OPENSCIENCE\\runtime\\envs\\DEFAULT-PYTHON\\PYTHON.EXE'
    const previousR = 'D:\\Old\\OpenScience\\runtime\\envs\\Analysis\\Lib\\R\\bin\\R.exe'
    const externalPython = 'C:\\Python312\\python.exe'
    const enablement = {
      python: {
        enabled: { [previousPython]: false, [externalPython]: false },
        installAuthorized: { [previousPython]: true }
      },
      r: {
        enabled: { [previousR]: false },
        installAuthorized: { [previousR]: true }
      }
    }

    const relocated = relocateManagedRuntimeEnablement({
      enablement,
      fromDataRoot: 'D:\\Old\\OpenScience',
      toDataRoot: 'E:\\New\\OpenScience',
      platform: 'win32'
    })

    expect(relocated).toEqual({
      python: {
        enabled: {
          [previousPython]: false,
          [externalPython]: false,
          'E:\\New\\OpenScience\\runtime\\envs\\.p\\python.exe': false
        },
        installAuthorized: { [previousPython]: true }
      },
      r: {
        enabled: {
          [previousR]: false,
          'E:\\New\\OpenScience\\runtime\\envs\\Analysis\\Lib\\R\\bin\\R.exe': false
        },
        installAuthorized: { [previousR]: true }
      }
    })
    expect(
      relocateManagedRuntimeEnablement({
        enablement: relocated,
        fromDataRoot: 'D:\\Old\\OpenScience',
        toDataRoot: 'E:\\New\\OpenScience',
        platform: 'win32'
      })
    ).toBe(relocated)
  })
})

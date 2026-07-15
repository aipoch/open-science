import { describe, expect, it, vi } from 'vitest'

import { findPythonCommand, isPython3Version, resolvePythonCommand } from './python-command'

describe('resolvePythonCommand', () => {
  it('accepts Python 3 versions and rejects Python 2', () => {
    expect(isPython3Version('Python 3.12.2')).toBe(true)
    expect(isPython3Version('Python 2.7.18')).toBe(false)
  })

  it('returns undefined from the non-blocking environment probe when Python is missing', async () => {
    const result = await findPythonCommand({
      platform: 'linux',
      probe: vi.fn().mockResolvedValue(false)
    })

    expect(result).toBeUndefined()
  })

  it('prefers python3, then python, on unix', async () => {
    const tried: string[] = []
    const result = await resolvePythonCommand({
      platform: 'linux',
      probe: ({ command }) => {
        tried.push(command)
        return Promise.resolve(command === 'python')
      }
    })

    expect(tried).toEqual(['python3', 'python'])
    expect(result).toEqual({ command: 'python', baseArgs: [] })
  })

  it('prefers the `py -3` launcher on windows', async () => {
    const result = await resolvePythonCommand({
      platform: 'win32',
      probe: ({ command }) => Promise.resolve(command === 'py')
    })

    expect(result).toEqual({ command: 'py', baseArgs: ['-3'] })
  })

  it('falls through py -> python -> python3 on windows', async () => {
    const tried: string[] = []
    const result = await resolvePythonCommand({
      platform: 'win32',
      probe: ({ command }) => {
        tried.push(command)
        return Promise.resolve(command === 'python3')
      }
    })

    expect(tried).toEqual(['py', 'python', 'python3'])
    expect(result).toEqual({ command: 'python3', baseArgs: [] })
  })

  it('falls back to the preferred candidate when none respond', async () => {
    const win = await resolvePythonCommand({
      platform: 'win32',
      probe: () => Promise.resolve(false)
    })
    const nix = await resolvePythonCommand({
      platform: 'linux',
      probe: () => Promise.resolve(false)
    })

    expect(win).toEqual({ command: 'py', baseArgs: ['-3'] })
    expect(nix).toEqual({ command: 'python3', baseArgs: [] })
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  findRCommand,
  isRVersion,
  parseRVersion,
  probeRExternal,
  rHasJsonlite,
  rKernelProtocolProbe,
  type RExec
} from './r-command'

describe('parseRVersion', () => {
  it('accepts R 4.x and R 3.x banners on either front-end wording', () => {
    expect(parseRVersion('Rscript (R) version 4.4.1 (2024-06-14)')).toBe('4.4.1')
    expect(parseRVersion('R scripting front-end version 4.3.2 (2023-10-31)')).toBe('4.3.2')
    expect(parseRVersion('R version 3.6.3 (2020-02-29)')).toBe('3.6.3')
  })

  it('rejects non-R output and unsupported major versions', () => {
    expect(parseRVersion('Python 3.12.2')).toBeUndefined()
    expect(parseRVersion('bash: Rscript: command not found')).toBeUndefined()
    expect(parseRVersion('R version 2.15.3 (2013-03-01)')).toBeUndefined()
  })

  it('exposes a boolean helper mirroring isPython3Version', () => {
    expect(isRVersion('Rscript (R) version 4.4.1')).toBe(true)
    expect(isRVersion('Python 3.12.2')).toBe(false)
  })
})

describe('findRCommand', () => {
  it('returns the first responding candidate', async () => {
    const tried: string[] = []
    const result = await findRCommand({
      platform: 'linux',
      probe: ({ command }) => {
        tried.push(command)
        return Promise.resolve(true)
      }
    })

    expect(tried).toEqual(['Rscript'])
    expect(result).toEqual({ command: 'Rscript', baseArgs: [] })
  })

  it('returns undefined when Rscript does not answer', async () => {
    const result = await findRCommand({
      platform: 'win32',
      probe: vi.fn().mockResolvedValue(false)
    })

    expect(result).toBeUndefined()
  })
})

describe('rHasJsonlite', () => {
  it('is true only when requireNamespace prints TRUE', async () => {
    const exec: RExec = vi.fn().mockResolvedValue({ stdout: 'TRUE', stderr: '' })
    expect(await rHasJsonlite({ exec })).toBe(true)
  })

  it('is false when jsonlite is absent', async () => {
    const exec: RExec = vi.fn().mockResolvedValue({ stdout: 'FALSE', stderr: '' })
    expect(await rHasJsonlite({ exec })).toBe(false)
  })

  it('is false when the probe subprocess fails', async () => {
    const exec: RExec = vi.fn().mockRejectedValue(new Error('ENOENT'))
    expect(await rHasJsonlite({ exec })).toBe(false)
  })
})

describe('rKernelProtocolProbe', () => {
  it('is true when jsonlite loads and round-trips ok:true', async () => {
    const exec: RExec = vi.fn().mockResolvedValue({ stdout: '{"ok":true}', stderr: '' })
    expect(await rKernelProtocolProbe({ exec })).toBe(true)
  })

  it('is false when the output is not the expected JSON', async () => {
    const exec: RExec = vi
      .fn()
      .mockResolvedValue({ stdout: 'Error: package not loadable', stderr: '' })
    expect(await rKernelProtocolProbe({ exec })).toBe(false)
  })
})

describe('probeRExternal', () => {
  it('reports detected and runnable when every check passes', async () => {
    const result = await probeRExternal({
      detectVersion: () => Promise.resolve('4.4.1'),
      hasJsonlite: () => Promise.resolve(true),
      protocolProbe: () => Promise.resolve(true)
    })

    expect(result).toEqual({ detected: true, runnable: true, version: '4.4.1' })
  })

  it('reports detected but NOT runnable when jsonlite is missing', async () => {
    const protocolProbe = vi.fn().mockResolvedValue(true)
    const result = await probeRExternal({
      detectVersion: () => Promise.resolve('4.4.1'),
      hasJsonlite: () => Promise.resolve(false),
      protocolProbe
    })

    expect(result.detected).toBe(true)
    expect(result.runnable).toBe(false)
    expect(result.version).toBe('4.4.1')
    expect(result.detail).toMatch(/jsonlite/i)
    // The protocol probe is short-circuited once jsonlite is known absent.
    expect(protocolProbe).not.toHaveBeenCalled()
  })

  it('reports detected but NOT runnable when the protocol probe fails', async () => {
    const result = await probeRExternal({
      detectVersion: () => Promise.resolve('4.4.1'),
      hasJsonlite: () => Promise.resolve(true),
      protocolProbe: () => Promise.resolve(false)
    })

    expect(result.detected).toBe(true)
    expect(result.runnable).toBe(false)
    expect(result.detail).toMatch(/protocol/i)
  })

  it('reports not detected when Rscript does not answer', async () => {
    const result = await probeRExternal({
      detectVersion: () => Promise.resolve(undefined),
      hasJsonlite: () => Promise.resolve(true),
      protocolProbe: () => Promise.resolve(true)
    })

    expect(result.detected).toBe(false)
    expect(result.runnable).toBe(false)
    expect(result.version).toBeUndefined()
  })
})

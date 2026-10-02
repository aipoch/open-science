import { describe, expect, it, vi } from 'vitest'

import { discoverQuarto } from './quarto-discovery'

describe('Quarto external-tool discovery', () => {
  it('probes candidate executables without a shell and returns the detected version', async () => {
    const exec = vi.fn(async () => ({ stdout: '1.7.32\n', stderr: '' }))

    await expect(
      discoverQuarto({
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        home: '/Users/researcher',
        candidatePaths: ['/opt/quarto/bin/quarto'],
        exec
      })
    ).resolves.toEqual({
      available: true,
      path: '/opt/quarto/bin/quarto',
      version: '1.7.32'
    })
    expect(exec).toHaveBeenCalledWith('/opt/quarto/bin/quarto', ['--version'], {
      timeout: 10_000,
      windowsHide: true,
      env: { PATH: '/usr/local/bin' },
      shell: false
    })
  })

  it('returns an actionable unavailable result when Quarto is not installed', async () => {
    await expect(
      discoverQuarto({
        platform: 'darwin',
        env: { PATH: '/usr/bin' },
        home: '/Users/researcher',
        candidatePaths: [],
        exec: vi.fn()
      })
    ).resolves.toEqual({
      available: false,
      reason:
        'Quarto was not found. Install Quarto and ensure "quarto" is on PATH, then retry. Other preview and export formats are unaffected.'
    })
  })
})

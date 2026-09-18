import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPackages } from './package-manager'
import { discoverExternalRLibraries, resolveExternalRLibrary } from './external-r-library'

import * as externalRLibrary from './external-r-library'

afterEach(() => vi.restoreAllMocks())

describe('external R package installation', () => {
  it('probes the selected R with bounded execution and canonicalizes duplicate candidates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'r-library-probe-'))
    try {
      const execute = vi.fn().mockResolvedValue({
        stdout: `profile output\nOPEN_SCIENCE_R_LIBRARIES=${JSON.stringify([directory, directory])}\n`,
        stderr: ''
      })
      await expect(discoverExternalRLibraries('/external/bin/Rscript', execute)).resolves.toEqual([
        await realpath(directory)
      ])
      expect(execute).toHaveBeenCalledWith(
        '/external/bin/Rscript',
        ['--slave', '-e', expect.stringContaining('.libPaths()')],
        expect.objectContaining({ timeout: 15000, windowsHide: true })
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['', 'OPEN_SCIENCE_R_LIBRARIES={}', 'OPEN_SCIENCE_R_LIBRARIES=[42]'])(
    'refuses an invalid library probe response %s',
    async (stdout) => {
      await expect(
        discoverExternalRLibraries(
          '/external/Rscript',
          vi.fn().mockResolvedValue({ stdout, stderr: '' })
        )
      ).rejects.toThrow()
    }
  )
  it('refuses missing consent and relative destinations without spawning an installer', async () => {
    const spawn = vi.fn()
    const result = await installPackages(
      { language: 'r', packages: ['glue'] },
      {
        interpreter: { command: '/external/Rscript' },
        spawn
      }
    )
    expect(result.ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    await expect(resolveExternalRLibrary('relative/library')).rejects.toThrow('absolute')
  })

  it.each(['missing', 'probe failure'])(
    'refuses an authorized library when revalidation reports %s',
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), 'external-r-revalidate-'))
      try {
        const library = await realpath(directory)
        const probe = vi.spyOn(externalRLibrary, 'discoverExternalRLibraries')
        if (failure === 'missing') probe.mockResolvedValue([])
        else probe.mockRejectedValue(new Error('R probe failed'))
        const spawn = vi.fn()
        const result = await installPackages(
          { language: 'r', packages: ['glue'] },
          {
            interpreter: { command: '/external/Rscript', library },
            spawn
          }
        )
        expect(result).toMatchObject({ ok: false, needsRestart: false })
        expect(spawn).not.toHaveBeenCalled()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.each([0, 1])(
    'uses the bound R and exact library and derives restart advice from exit code %s',
    async (code) => {
      const directory = await mkdtemp(join(tmpdir(), 'external-r-library-'))
      try {
        const library = await realpath(directory)
        const probe = vi
          .spyOn(externalRLibrary, 'discoverExternalRLibraries')
          .mockResolvedValue([library])
        const spawn = vi.fn(async () => ({
          code,
          stdout: '',
          stderr: code ? 'install failed' : ''
        }))
        const result = await installPackages(
          { language: 'r', packages: ['glue'], workspaceCwd: library },
          {
            interpreter: { command: '/external/Rscript', library },
            spawn
          }
        )
        expect(probe).toHaveBeenCalledWith('/external/Rscript')
        expect(spawn).toHaveBeenCalledTimes(1)
        expect(
          (spawn.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv])[2].R_LIBS_USER
        ).toBe(library)
        const [command, args] = spawn.mock.calls[0] as unknown as [string, string[]]
        expect(command).toBe('/external/Rscript')
        expect(args).not.toContain('-m')
        expect(args.at(-1)).toContain(JSON.stringify(library))
        expect(args.at(-1)).toContain('installed.packages(lib.loc=destination)')
        expect(result).toMatchObject({ ok: code === 0, needsRestart: code === 0, method: 'cran' })
        expect(result.attempts).toEqual([
          expect.objectContaining({
            status: code === 0 ? 'succeeded' : 'failed',
            mutationRisk: code === 0 ? 'confirmed' : 'possible'
          })
        ])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})

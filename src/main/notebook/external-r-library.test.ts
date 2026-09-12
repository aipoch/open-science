import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installPackages } from './package-manager'
import { resolveExternalRLibrary } from './external-r-library'

describe('external R package installation', () => {
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

  it.each([0, 1])(
    'uses the bound R and exact library and derives restart advice from exit code %s',
    async (code) => {
      const directory = await mkdtemp(join(tmpdir(), 'external-r-library-'))
      try {
        const library = await realpath(directory)
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
        expect(spawn).toHaveBeenCalledTimes(1)
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

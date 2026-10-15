import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it.each(['baseline', 'clean', 'failed'] as const)(
  'keeps critical unref shutdown work alive until its %s outcome is recorded',
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-shutdown-lifetime-'))
    try {
      const entry = join(directory, 'entry.ts')
      const record = join(directory, 'record.json')
      await writeFile(
        entry,
        `
        import { withRuntimeShutdownLifetime } from ${JSON.stringify(resolve('src/main/runtime-shutdown-lifetime.ts'))}
        import { writeFile } from 'node:fs/promises'
        const shutdown = async () => {
          // Model the last socket closing before an unref logging worker responds.
          await new Promise(resolve => setTimeout(resolve, 30).unref())
          const failed = ${JSON.stringify(outcome)} === 'failed'
          await writeFile(${JSON.stringify(record)}, JSON.stringify({ outcome: failed ? 'failed' : 'clean', ownershipReleased: !failed }))
          if (failed) throw new Error('fixture drain failed')
        }
        void (${JSON.stringify(outcome)} === 'baseline' ? shutdown() : withRuntimeShutdownLifetime(shutdown)).catch(() => { process.exitCode = 1 })
      `
      )
      const bundled = join(directory, 'entry.cjs')
      await build({
        entryPoints: [entry],
        outfile: bundled,
        bundle: true,
        platform: 'node',
        format: 'cjs'
      })
      const child = spawn(process.execPath, [bundled], { stdio: 'ignore' })
      const exit = await new Promise<number | null>((resolve, reject) => {
        const deadline = setTimeout(() => {
          child.kill()
          reject(new Error('Child did not naturally exit'))
        }, 2_000)
        child.once('error', reject)
        child.once('exit', (code) => {
          clearTimeout(deadline)
          resolve(code)
        })
      })
      if (outcome === 'baseline') {
        expect(exit).toBe(0)
        await expect(readFile(record, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(exit).toBe(outcome === 'failed' ? 1 : 0)
        expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
          outcome,
          ownershipReleased: outcome === 'clean'
        })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

import { afterEach, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

it.each(['unhandledRejection', 'uncaughtException'] as const)(
  'persists the fatal %s diagnostic before a real Node process exits',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'node-fatal-log-'))
    directories.push(directory)
    const entry = join(directory, 'child.cjs')
    await build({
      stdin: {
        contents: `
          import { installNodeFatalErrors } from './src/main/node-fatal-errors';
          import { createLogger, initLogger, flushLogs } from '@aipoch/diagnostics/node';
          initLogger({ logDir: process.argv[2], mirrorToConsole: false });
          (async () => {
            createLogger('node-runtime').info('before fatal failure');
            await flushLogs();
            installNodeFatalErrors({ process });
            const failure = Object.assign(
              new TypeError('Fixture transport failed: Bearer private-fixture-credential', {
                cause: new Error('Fixture socket timed out')
              }),
              { code: 'ETIMEDOUT' }
            );
            if (process.argv[3] === 'unhandledRejection') Promise.reject(failure);
            else setTimeout(() => { throw failure; }, 0);
          })();
        `,
        resolveDir: process.cwd(),
        sourcefile: 'fatal-child.ts',
        loader: 'ts'
      },
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    const child = spawn(process.execPath, [entry, directory, kind], { stdio: 'ignore' })
    const [code, signal] = await once(child, 'exit')
    expect({ code, signal }).toEqual({ code: 1, signal: null })
    const contents = await readFile(join(directory, 'main.log'), 'utf8')
    const records = contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records.filter((record) => record.msg === 'fatal local service failure')).toEqual([
      expect.objectContaining({
        level: 'error',
        scope: 'node-runtime',
        data: expect.objectContaining({
          kind,
          errorCategory: 'timeout',
          name: 'TypeError',
          code: 'ETIMEDOUT',
          error: 'Fixture transport failed: Bearer [redacted]',
          stack: expect.stringContaining('child.cjs'),
          cause: expect.objectContaining({ error: 'Fixture socket timed out' })
        })
      })
    ])
    expect(contents).not.toContain('private-fixture-credential')
  }
)

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NotebookKernelExecutor } from './kernel-executor'

it
  .skipIf(!process.env.OPEN_SCIENCE_TEST_RSCRIPT)
  .each(['closeAllConnections()', 'base::closeAllConnections()'])(
  'preserves capture and the next request after %s',
  async (closeAll) => {
    const root = await mkdtemp(join(tmpdir(), 'r-connections-'))
    const executor = new NotebookKernelExecutor({
      rLoopPath: join(__dirname, '../../../resources/notebook/r_loop.R')
    })
    const request = {
      language: 'r' as const,
      cwd: root,
      notebookSessionRoot: root,
      dataRoot: root,
      inputRoot: join(root, 'inputs'),
      runtimeRoot: join(root, 'runtime'),
      resolvedInterpreter: {
        command: process.env.OPEN_SCIENCE_TEST_RSCRIPT!,
        args: ['--vanilla'],
        condaPrefix: process.env.OPEN_SCIENCE_TEST_R_PREFIX
      }
    }
    try {
      await mkdir(join(root, 'outputs'))
      const result = await executor.execute({
        ...request,
        code: `kept <- 41L
con <- gzfile('outputs/data.gz', 'w'); writeLines('preserved bytes', con)
user_sink <- file('outputs/sink.txt', 'w'); sink(user_sink); cat('user output')
user_messages <- file('outputs/messages.txt', 'w'); sink(user_messages, type='message'); message('user diagnostic')
${closeAll}
stopifnot(!as.integer(con) %in% getAllConnections(), !as.integer(user_sink) %in% getAllConnections(), !as.integer(user_messages) %in% getAllConnections())
cat('capture survives')`
      })
      expect(result.status, result.traceback || result.stderr).toBe('completed')
      expect(result.stdout).toContain('capture survives')
      const next = await executor.execute({
        ...request,
        code: `cat(kept + 1L); cat(readLines(gzfile('outputs/data.gz', 'r')))
next_user <- file('outputs/next.txt', 'w'); writeLines('next', next_user)
${closeAll}
stopifnot(!as.integer(next_user) %in% getAllConnections()); cat('second cleanup survives')`
      })
      expect(next.status, next.traceback || next.stderr).toBe('completed')
      expect(next.stdout).toContain('42')
      expect(next.stdout).toContain('preserved bytes')
      expect(next.stdout).toContain('second cleanup survives')
      expect(await readFile(join(root, 'outputs/sink.txt'), 'utf8')).toBe('user output')
      expect(await readFile(join(root, 'outputs/messages.txt'), 'utf8')).toContain(
        'user diagnostic'
      )
      expect((await readFile(join(root, 'outputs/data.gz'))).length).toBeGreaterThan(0)
      const failed = await executor.execute({
        ...request,
        code: `${closeAll}; stop('diagnostic survives')`
      })
      expect(failed.status).toBe('failed')
      expect(failed.traceback).toContain('diagnostic survives')
      const recovered = await executor.execute({ ...request, code: 'cat(kept)' })
      expect(recovered).toMatchObject({ status: 'completed', stdout: '41' })
    } finally {
      expect((await executor.shutdown()).reaped).toBe(true)
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60000
)

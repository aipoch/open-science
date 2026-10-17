import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSshRunner } from './controllers'
import { parsePollOutput } from './job-poll-output'
import type { ComputeJob } from './model'

// Node stands in for the SSH executable; output and process lifecycle are real OS pipes.
describe('SSH runner real processes', () => {
  it.each(['stdout', 'stderr', 'mixed'])(
    'finishes >1 MiB %s with bounded captures',
    async (mode) => {
      const dir = await mkdtemp(join(tmpdir(), 'compute-output-'))
      try {
        const script = join(dir, 'child.cjs')
        const marker = join(dir, 'completed')
        await writeFile(
          script,
          `const fs = require('node:fs');
        const block = Buffer.alloc(65536, 120);
        for (let i = 0; i < 40; i++) {
          ${mode !== 'stderr' ? 'fs.writeSync(1, block);' : ''}
          ${mode !== 'stdout' ? 'fs.writeSync(2, block);' : ''}
        }
        fs.writeFileSync(${JSON.stringify(marker)}, 'completed'); process.exitCode = 7;`
        )
        const result = await createSshRunner().run(
          { sshBinary: process.execPath, extraArgs: [], host: script },
          'unused',
          { timeoutMs: 5000, maxOutputBytes: 65536 }
        )
        expect.soft(await readFile(marker, 'utf8').catch(() => 'missing')).toBe('completed')
        expect(result.exitCode).toBe(7)
        expect(result).toMatchObject({
          timedOut: false,
          truncated: true,
          stdoutTruncated: mode !== 'stderr',
          stderrTruncated: mode !== 'stdout'
        })
        expect(Buffer.byteLength(result.stdout)).toBe(mode === 'stderr' ? 0 : 65536)
        expect(Buffer.byteLength(result.stderr)).toBe(mode === 'stdout' ? 0 : 65536)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})

it('retains the final protocol result in an eight-job >1 MiB poll batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compute-batch-'))
  try {
    const script = join(dir, 'batch.cjs')
    const jobs = Array.from({ length: 8 }, (_, i) => ({ job_id: `job-${i}` }) as ComputeJob)
    const nonce = 'batch_nonce_'
    const output = jobs
      .map(
        (job) =>
          `${nonce}JOB_START:${job.job_id}\n${nonce}alive:0\n${nonce}exit:0\n${'x'.repeat(65536)}\n${nonce}STDOUT_END:${job.job_id}\n${'e'.repeat(65536)}\n${nonce}STDERR_END:${job.job_id}\n`
      )
      .join('')
    expect(Buffer.byteLength(output)).toBeGreaterThan(1024 * 1024)
    await writeFile(join(dir, 'output'), output)
    await writeFile(
      script,
      `const fs = require('node:fs'); fs.writeSync(1, fs.readFileSync(${JSON.stringify(join(dir, 'output'))}));`
    )
    const result = await createSshRunner().run(
      { sshBinary: process.execPath, extraArgs: [], host: script },
      'unused',
      { timeoutMs: 5000, maxOutputBytes: 8 * (65536 * 2 + 1024) }
    )
    expect(result).toMatchObject({ exitCode: 0, truncated: false })
    const observations = parsePollOutput(result.stdout, jobs, nonce)
    expect(observations).toHaveLength(8)
    for (const observation of observations)
      expect(observation).toMatchObject({ status: 'complete', exitCode: 0, hasExitCode: true })
    expect(observations[7]).toMatchObject({
      stdoutTail: 'x'.repeat(65536),
      stderrTail: 'e'.repeat(65536)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it.each(['timeout', 'abort'] as const)('reaps a real child ignoring TERM on %s', async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'compute-termination-'))
  let pid: number | undefined
  const controller = new AbortController()
  let outcome: Promise<unknown> | undefined
  try {
    const script = join(dir, 'child.cjs')
    const pidFile = join(dir, 'pid')
    await writeFile(
      script,
      `process.on('SIGTERM', () => {});
      const fs = require('node:fs');
      const pidFile = ${JSON.stringify(pidFile)};
      fs.writeFileSync(pidFile + '.tmp', String(process.pid));
      fs.renameSync(pidFile + '.tmp', pidFile);
      setInterval(() => {}, 100);`
    )
    outcome = createSshRunner()
      .run({ sshBinary: process.execPath, extraArgs: [], host: script }, 'unused', {
        timeoutMs: mode === 'timeout' ? 500 : 5000,
        signal: controller.signal
      })
      .then(
        (result) => result,
        (error) => error
      )
    for (let i = 0; i < 100; i++) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'))
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    expect(pid).toBeGreaterThan(0)
    if (mode === 'abort') controller.abort()
    const result = await outcome
    expect(result).toMatchObject(mode === 'abort' ? { name: 'AbortError' } : { timedOut: true })
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    // A readiness assertion can fail before pid is known; still reap the runner's child.
    controller.abort()
    await outcome
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* Already reaped. */
      }
    }
    await rm(dir, { recursive: true, force: true })
  }
})

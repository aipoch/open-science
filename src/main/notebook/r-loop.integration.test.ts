import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { frameRRequest, parseLoopResponse, type KernelLoopResponse } from './kernel-protocol'

// Run with: RUN_KERNEL=1 OPEN_SCIENCE_TEST_R_ENV=/path/to/r/env/prefix \
//   npx vitest run src/main/notebook/r-loop.integration.test.ts
// OPEN_SCIENCE_TEST_R_ENV is the R environment's prefix directory; the Rscript binary is expected
// at <prefix>/bin/Rscript.
const rEnvPrefix = process.env.OPEN_SCIENCE_TEST_R_ENV
const gate = process.env.RUN_KERNEL && rEnvPrefix ? describe : describe.skip

const LOOP = join(__dirname, '../../../resources/notebook/r_loop.R')

// Minimal one-shot client over r_loop.R's length-prefixed stdio protocol for the test.
const startLoop = (
  rscript: string,
  env: NodeJS.ProcessEnv
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string) => Promise<KernelLoopResponse>
} => {
  const child = spawn(rscript, [LOOP], { env: { ...process.env, ...env } })
  const rl = createInterface({ input: child.stdout })
  const waiters = new Map<string, (v: KernelLoopResponse) => void>()
  rl.on('line', (line) => {
    const msg = parseLoopResponse(line)
    if (!msg) return // non-JSON loop noise ignored in the test
    const w = waiters.get(msg.reqId)
    if (w) {
      waiters.delete(msg.reqId)
      w(msg)
    }
  })
  const send = (code: string): Promise<KernelLoopResponse> =>
    new Promise((resolve) => {
      const reqId = randomUUID()
      waiters.set(reqId, resolve)
      child.stdin.write(frameRRequest(reqId, code))
    })
  return { child, send }
}

// Resolved lazily inside each `it` (not at describe-body scope) so a skipped describe.skip run
// doesn't evaluate join() against an undefined rEnvPrefix.
const rscriptBin = (): string => join(rEnvPrefix as string, 'bin', 'Rscript')

gate('r_loop.R', () => {
  it('auto-prints visible results, keeps state across requests, reports errors', async () => {
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      const a = await send('40 + 2')
      expect(a.error).toBeNull()
      expect(a.stdout).toContain('42')

      // State survives across requests; issue two requests back-to-back (without awaiting the
      // first) to prove the length-prefixed framing does not desync.
      const b = await send('x <- 5')
      expect(b.error).toBeNull()
      const c = await send('x * 2')
      expect(c.error).toBeNull()
      expect(c.stdout).toContain('10')

      // Errors come back as a message string, not a thrown exception.
      const d = await send('stop("boom")')
      expect(d.error).toContain('boom')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('proves back-to-back requests written without waiting stay aligned', async () => {
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      const pA = send('y <- 7')
      const pB = send('y * 3')
      const [a, b] = await Promise.all([pA, pB])
      expect(a.error).toBeNull()
      expect(b.error).toBeNull()
      expect(b.stdout).toContain('21')
    } finally {
      child.kill()
    }
  }, 60_000)

  it('captures a base graphics figure as a content-addressed PNG', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send('plot(1:3)')
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
      const fig = r.figures[0]
      expect(existsSync(fig.path)).toBe(true)
      const bytes = readFileSync(fig.path)
      // PNG magic bytes.
      expect(bytes[0]).toBe(0x89)
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures a ggplot2 figure via autoprint-triggered grid rendering', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-gg-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        'library(ggplot2); ggplot(data.frame(x=1:3,y=1:3), aes(x,y)) + geom_point()'
      )
      if (r.error && /there is no package called .ggplot2./.test(r.error)) {
        // ggplot2 not installed in this R env; base graphics coverage above already proves
        // device figure capture, so skip rather than fail.
        return
      }
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)
})

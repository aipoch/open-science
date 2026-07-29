import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { frameRRequest, parseLoopResponse, type KernelLoopResponse } from './kernel-protocol'

// Run with: RUN_KERNEL=1 OPEN_SCIENCE_TEST_R_ENV=/path/to/r/env/prefix \
//   npx vitest run src/main/notebook/r-loop.integration.test.ts
// OPEN_SCIENCE_TEST_R_ENV is the R environment's prefix directory; the Rscript binary is expected
// at <prefix>/bin/Rscript.
const rEnvPrefix = process.env.OPEN_SCIENCE_TEST_R_ENV
const gate = process.env.RUN_KERNEL && rEnvPrefix ? describe : describe.skip

const LOOP = join(__dirname, '../../../resources/notebook/r_loop.R')
const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)
const PALETTE_TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEX///+nxBvIAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
  'base64'
)
const DIFFERENT_TINY_PNG_BYTES = Buffer.from(TINY_PNG_BYTES)
DIFFERENT_TINY_PNG_BYTES[DIFFERENT_TINY_PNG_BYTES.length - 1] ^= 0xff

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
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const waiters = new Map<
    string,
    {
      resolve: (v: KernelLoopResponse) => void
      reject: (error: Error) => void
    }
  >()
  child.on('exit', (code, signal) => {
    const error = new Error(
      `R loop exited before replying: code=${code} signal=${signal} ${stderr}`
    )
    for (const waiter of waiters.values()) {
      waiter.reject(error)
    }
    waiters.clear()
  })
  rl.on('line', (line) => {
    const msg = parseLoopResponse(line)
    if (!msg) return // non-JSON loop noise ignored in the test
    const w = waiters.get(msg.reqId)
    if (w) {
      waiters.delete(msg.reqId)
      w.resolve(msg)
    }
  })
  const send = (code: string): Promise<KernelLoopResponse> =>
    new Promise((resolve, reject) => {
      const reqId = randomUUID()
      waiters.set(reqId, { resolve, reject })
      child.stdin.write(frameRRequest(reqId, code))
    })
  return { child, send }
}

// Resolved lazily inside each `it` (not at describe-body scope) so a skipped describe.skip run
// doesn't evaluate join() against an undefined rEnvPrefix.
const rscriptBin = (): string => join(rEnvPrefix as string, 'bin', 'Rscript')

const tinyPngRVector = (bytes = TINY_PNG_BYTES): string =>
  `as.raw(c(${Array.from(bytes, (byte) => `0x${byte.toString(16).padStart(2, '0')}`).join(', ')}))`

const installBlankPngMaterializationTrace = (
  blankPngVector: string,
  options: { capturePngVector?: string; materializeCapture?: boolean } = {}
): string =>
  [
    '.open_science_test_png <- new.env(parent = emptyenv())',
    `.open_science_test_png$blank_bytes <- ${blankPngVector}`,
    `.open_science_test_png$capture_bytes <- ${options.capturePngVector ?? blankPngVector}`,
    `.open_science_test_png$materialize_capture <- ${options.materializeCapture ? 'TRUE' : 'FALSE'}`,
    'trace(grDevices::png, quote({',
    '  .open_science_test_png$filename <- filename',
    '}), print = FALSE)',
    'trace(grDevices::dev.off, exit = quote({',
    '  pattern <- .open_science_test_png$filename',
    '  figures_dir <- Sys.getenv("OPEN_SCIENCE_KERNEL_FIGURES_DIR")',
    '  if (is.character(pattern) && length(pattern) > 0L) {',
    '    pattern <- pattern[[1L]]',
    '    path <- sub("%03d", "001", pattern, fixed = TRUE)',
    '    path_dir <- normalizePath(dirname(path), mustWork = FALSE)',
    '    figures_dir_norm <- normalizePath(figures_dir, mustWork = FALSE)',
    '    is_capture_path <- nzchar(figures_dir) && (path_dir == figures_dir_norm || startsWith(path_dir, paste0(figures_dir_norm, .Platform$file.sep)))',
    '    should_materialize_blank <- grepl("open-science-blank-r-", pattern, fixed = TRUE)',
    '    should_materialize_capture <- isTRUE(.open_science_test_png$materialize_capture) && is_capture_path',
    '    if (should_materialize_blank && !file.exists(path)) writeBin(.open_science_test_png$blank_bytes, path)',
    '    if (should_materialize_capture) writeBin(.open_science_test_png$capture_bytes, path)',
    '  }',
    '}), print = FALSE)'
  ].join('\n')

gate('r_loop.R', () => {
  it('auto-prints visible results, keeps state across requests, reports errors', async () => {
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      const a = await send('40 + 2')
      expect(a.error).toBeNull()
      expect(a.stdout).toContain('42')
      expect(a.environmentOverlay?.runtimeVersion).toMatch(/^4\./)
      expect(a.environmentOverlay?.packages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'base', loadedState: 'attached', ecosystem: 'r' })
        ])
      )

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

  it('does not return a figure for text-only output when figure capture is enabled', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-text-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send('print("text only")')
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] "text only"')
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not return a palette PNG blank page for text-only output', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-palette-blank-'))
    const blankPngVector = tinyPngRVector(PALETTE_TINY_PNG_BYTES)
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(
        installBlankPngMaterializationTrace(blankPngVector, { materializeCapture: true })
      )
      expect(installTrace.error).toBeNull()

      const r = await send('print("text only")')
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] "text only"')
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('ignores unrelated non-empty PNG pages when no R plotting occurred', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-blank-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      writeFileSync(join(figuresDir, 'page-999.png'), TINY_PNG_BYTES)
      const r = await send('print("text only")')
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] "text only"')
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('skips unreadable raw PNG page paths without killing the loop', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-unreadable-page-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        [
          'dir.create(file.path(Sys.getenv("OPEN_SCIENCE_KERNEL_FIGURES_DIR"), "page-001.png"))',
          'print("text only")'
        ].join('; ')
      )
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] "text only"')
      expect(r.figures).toEqual([])

      const next = await send('21 * 2')
      expect(next.error).toBeNull()
      expect(next.stdout).toContain('42')
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures plots and preserves user default-device changes inside a cell', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-device-option-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        [
          'custom_device <- function(...) stop("custom default device should not be opened")',
          'options(device = custom_device)',
          'plot(1:3)',
          'print(identical(getOption("device"), custom_device))'
        ].join('; ')
      )
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] TRUE')
      expect(r.figures.length).toBeGreaterThan(0)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures a plot even when user code closes the current graphics device', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-user-dev-off-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send('plot(1:3); grDevices::dev.off()')
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures a plot even when a low-number stray raw page exists', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-low-stray-page-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      writeFileSync(join(figuresDir, 'page-000.png'), TINY_PNG_BYTES)

      const r = await send('plot(1:3)')
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures a plot when user code replaces plot hooks before closing the capture device', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-replaced-hooks-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        'setHook("before.plot.new", NULL, action = "replace"); plot(1:3); grDevices::dev.off()'
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not re-add capture hooks between user expressions', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-hook-state-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        [
          'setHook("before.plot.new", NULL, action = "replace")',
          'setHook("grid.newpage", NULL, action = "replace")',
          'c(length(getHook("before.plot.new")), length(getHook("grid.newpage")))'
        ].join('; ')
      )
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] 0 0')
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not expose capture hooks to notebook hook snapshots', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-hidden-hooks-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send('c(length(getHook("before.plot.new")), length(getHook("grid.newpage")))')
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] 0 0')
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('preserves a blank graphics page when user code closes the capture device', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-user-blank-dev-off-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(installBlankPngMaterializationTrace(blankPngVector))
      expect(installTrace.error).toBeNull()

      const r = await send(
        [
          `blank_png <- ${blankPngVector}`,
          'plot.new()',
          'grDevices::dev.off()',
          'writeBin(blank_png, file.path(Sys.getenv("OPEN_SCIENCE_KERNEL_FIGURES_DIR"), "page-001.png"))'
        ].join('; ')
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBe(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not return a blank figure when user code closes an unused capture device', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-unused-dev-off-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(
        installBlankPngMaterializationTrace(blankPngVector, { materializeCapture: true })
      )
      expect(installTrace.error).toBeNull()

      const r = await send('print("text only"); grDevices::dev.off()')
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] "text only"')
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not treat a reused graphics device id as notebook output after capture device close', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-reused-dev-id-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(
        installBlankPngMaterializationTrace(blankPngVector, { materializeCapture: true })
      )
      expect(installTrace.error).toBeNull()

      const r = await send(
        'grDevices::dev.off(); pdf(tempfile()); plot.new(); grDevices::dev.off()'
      )
      expect(r.error).toBeNull()
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not confuse a user png device reopened in the same expression with notebook output', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-reused-png-dev-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(
        installBlankPngMaterializationTrace(blankPngVector, { materializeCapture: true })
      )
      expect(installTrace.error).toBeNull()

      const r = await send(
        [
          '{',
          '  grDevices::dev.off()',
          '  user_png <- tempfile(fileext = ".png")',
          '  grDevices::png(user_png, width = 800, height = 600, res = 96)',
          '  plot(1:3)',
          '}'
        ].join('\n')
      )
      expect(r.error).toBeNull()
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not confuse a user png device after graphics.off closes notebook capture', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-graphics-off-reuse-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(
        installBlankPngMaterializationTrace(blankPngVector, { materializeCapture: true })
      )
      expect(installTrace.error).toBeNull()

      const r = await send(
        [
          '{',
          '  .open_science_test_png$materialize_capture <- TRUE',
          '  grDevices::graphics.off()',
          '  user_png <- tempfile(fileext = ".png")',
          '  grDevices::png(user_png, width = 800, height = 600, res = 96)',
          '  plot(1:3)',
          '  grDevices::dev.off()',
          '}'
        ].join('\n')
      )
      expect(r.error).toBeNull()
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('preserves a blank graphics page when display-list recording is inhibited', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-blank-inhibit-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(installBlankPngMaterializationTrace(blankPngVector))
      expect(installTrace.error).toBeNull()

      const r = await send(
        [
          '.open_science_test_png$materialize_capture <- TRUE',
          'grDevices::dev.control(displaylist = "inhibit")',
          'plot.new()'
        ].join('; ')
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBe(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('preserves a blank graphics page when hooks are replaced and display-list recording is inhibited', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-blank-hooks-inhibit-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(installBlankPngMaterializationTrace(blankPngVector))
      expect(installTrace.error).toBeNull()

      const r = await send(
        [
          '.open_science_test_png$materialize_capture <- TRUE',
          'setHook("before.plot.new", NULL, action = "replace")',
          'grDevices::dev.control(displaylist = "inhibit")',
          'plot.new()',
          'grDevices::dev.off()'
        ].join('; ')
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBe(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('preserves a blank graphics page when hooks are replaced inside a braced expression', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-braced-blank-hooks-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(installBlankPngMaterializationTrace(blankPngVector))
      expect(installTrace.error).toBeNull()

      const r = await send(
        [
          '{',
          '  .open_science_test_png$materialize_capture <- TRUE',
          '  setHook("before.plot.new", NULL, action = "replace")',
          '  setHook("grid.newpage", NULL, action = "replace")',
          '  grDevices::dev.control(displaylist = "inhibit")',
          '  plot.new()',
          '  dev.off()',
          '}'
        ].join('\n')
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBe(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('preserves a blank graphics page when a saved dev.off alias closes the capture device', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-saved-dev-off-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const saveAlias = await send('saved_dev_off <- grDevices::dev.off')
      expect(saveAlias.error).toBeNull()

      const installTrace = await send(installBlankPngMaterializationTrace(blankPngVector))
      expect(installTrace.error).toBeNull()

      const r = await send(
        [
          '{',
          '  .open_science_test_png$materialize_capture <- TRUE',
          '  setHook("before.plot.new", NULL, action = "replace")',
          '  setHook("grid.newpage", NULL, action = "replace")',
          '  grDevices::dev.control(displaylist = "inhibit")',
          '  plot.new()',
          '  saved_dev_off()',
          '}'
        ].join('\n')
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBe(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures a plot when hooks are replaced and display-list recording is inhibited', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-hooks-inhibit-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        'setHook("before.plot.new", NULL, action = "replace"); grDevices::dev.control(displaylist = "inhibit"); plot(1:3)'
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures a uniform filled page when hooks are replaced and display-list recording is inhibited', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-uniform-fill-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        [
          '{',
          '  setHook("before.plot.new", NULL, action = "replace")',
          '  setHook("grid.newpage", NULL, action = "replace")',
          '  grDevices::dev.control(displaylist = "inhibit")',
          '  grid::grid.rect(gp = grid::gpar(fill = "red", col = NA))',
          '  grDevices::dev.off()',
          '}'
        ].join('\n')
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBe(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not treat plots on another graphics device as notebook output', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-external-device-'))
    const blankPngVector = tinyPngRVector()
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(
        installBlankPngMaterializationTrace(blankPngVector, { materializeCapture: true })
      )
      expect(installTrace.error).toBeNull()

      const r = await send('pdf(tempfile()); plot.new(); grDevices::dev.off()')
      expect(r.error).toBeNull()
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps text-only blank filtering isolated from user graphics traces', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-traced-blank-'))
    const blankPngVector = tinyPngRVector()
    const capturePngVector = tinyPngRVector(DIFFERENT_TINY_PNG_BYTES)
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(
        installBlankPngMaterializationTrace(blankPngVector, {
          capturePngVector,
          materializeCapture: true
        })
      )
      expect(installTrace.error).toBeNull()

      const r = await send('print("text only")')
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] "text only"')
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not run user graphics traces for kernel-owned capture preflight', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-hidden-preflight-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const installTrace = await send(
        [
          '.open_science_trace_counts <- c(png = 0L, dev.off = 0L)',
          'trace(grDevices::png, quote({',
          '  .open_science_trace_counts["png"] <<- .open_science_trace_counts["png"] + 1L',
          '}), print = FALSE)',
          'trace(grDevices::dev.off, quote({',
          '  .open_science_trace_counts["dev.off"] <<- .open_science_trace_counts["dev.off"] + 1L',
          '}), print = FALSE)'
        ].join('\n')
      )
      expect(installTrace.error).toBeNull()

      const r = await send('print("text only"); print(.open_science_trace_counts)')
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] "text only"')
      expect(r.stdout).toContain('png dev.off')
      expect(r.stdout).toContain('  0       0')
      expect(r.figures).toEqual([])
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures grid drawing rendered onto the existing capture page', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-grid-existing-page-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send('grid::grid.rect()')
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures a plot when user code inhibits display-list recording', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-displaylist-inhibit-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send('grDevices::dev.control(displaylist = "inhibit"); plot(1:3)')
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps figure-capture helpers private from notebook variables', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-helper-collision-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        [
          'blank_capture_hashes <- function(...) "user-blank"',
          'capture_device_has_plot <- function(...) FALSE',
          'harvest_figures <- function(...) list()',
          'capture_page_files <- function(...) character()',
          'is_png_file <- function(...) FALSE',
          'content_hash <- function(...) "user-hash"',
          'plot(1:3)'
        ].join('; ')
      )
      expect(r.error).toBeNull()
      expect(r.figures.length).toBeGreaterThan(0)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps R loop helper lookups isolated from notebook variables across requests', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-helper-shadow-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const poison = await send(
        'tempfile <- function(...) stop("user tempfile should not run"); print("poisoned")'
      )
      expect(poison.error).toBeNull()
      expect(poison.stdout).toContain('[1] "poisoned"')

      const r = await send('print("still alive")')
      expect(r.error).toBeNull()
      expect(r.stdout).toContain('[1] "still alive"')
      expect(r.figures).toEqual([])
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

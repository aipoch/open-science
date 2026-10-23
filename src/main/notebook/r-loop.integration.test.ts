import { createNotebookDependencyAnalyzer } from './dependency-analysis-adapter'
import { once } from 'node:events'
import { describe, it, expect } from 'vitest'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'

import { startWorkingFileObservation } from './working-file-observer'
import { restoreRRandomState } from '@aipoch/reproducibility'
import rdsChordCells from './reported-mixed-rds-chord.fixture.json'
import repelVolcanoCells from './reported-r-repel-volcano.fixture.json'
import pipedVolcanoCells from './reported-r-piped-volcano.fixture.json'
import retryVolcanoCells from './reported-r-retry-volcano.fixture.json'
import aggregateVolcanoCells from './reported-r-aggregate-volcano.fixture.json'
import finiteVolcanoCells from './reported-r-finite-volcano.fixture.json'
import welchVolcanoCells from './reported-r-welch-volcano.fixture.json'
import joinedVolcanoCells from './reported-mixed-joined-volcano.fixture.json'
import marginalVolcanoCells from './reported-marginal-volcano.fixture.json'
import fontFallbackVolcanoCells from './reported-font-fallback-volcano.fixture.json'
import rdsEnvelopeCells from './reported-rds-envelope-volcano.fixture.json'
import withVolcanoCells from './reported-with-volcano.fixture.json'
import layeredVolcanoCells from './reported-layered-volcano.fixture.json'
import contrastsVolcanoCells from './reported-contrasts-volcano.fixture.json'
import rdsCleanVolcanoCells from './reported-rds-clean-volcano.fixture.json'
import crossLanguageVolcanoCells from './reported-cross-language-volcano.fixture.json'
import vennCells from './reported-venn.fixture.json'
import vennLayerCells from './reported-venn-layers.fixture.json'
import vennPartitionCells from './reported-venn-partitions.fixture.json'
import mixedVennCells from './reported-mixed-venn.fixture.json'
import vennDeviceCells from './reported-venn-device.fixture.json'
import vennRegionCells from './reported-venn-regions.fixture.json'
import vennPackageCells from './reported-venn-package.fixture.json'
import vennRdsCells from './reported-venn-rds.fixture.json'
import vennCounterCells from './reported-mixed-venn-counter.fixture.json'
import vennRegionChainCells from './reported-venn-region-chain.fixture.json'

import {
  frameRNamespaceRequest,
  frameRInterruptProbeRequest,
  frameRRequest,
  parseLoopResponse,
  type KernelLoopResponse
} from './kernel-protocol'

// Run with: RUN_KERNEL=1 OPEN_SCIENCE_TEST_R_ENV=/path/to/r/env/prefix \
//   npx vitest run src/main/notebook/r-loop.integration.test.ts
// OPEN_SCIENCE_TEST_R_ENV is the R environment's prefix directory; the Rscript binary is expected
// at <prefix>/bin/Rscript.
const rEnvPrefix = process.env.OPEN_SCIENCE_TEST_R_ENV
const gate = process.env.RUN_KERNEL && rEnvPrefix ? describe : describe.skip

// The native plots succeed, but unproven R column dispatch does not certify file coverage.
const partialRColumnEvidence = {
  state: 'partial',
  fileReads: 'partial',
  writerAttribution: 'partial',
  reasonCodes: [
    'delayed-writes-not-observed',
    'external-paths-not-observed',
    'file-reads-not-observed',
    'remote-outputs-not-observed',
    'source-analysis-unsupported-call',
    'transient-files-not-captured',
    'writer-not-isolated'
  ]
}

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
  env: NodeJS.ProcessEnv,
  cwd?: string,
  vanilla = false,
  loopPath = LOOP
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string) => Promise<KernelLoopResponse>
  stage: (code: string, options: Record<string, unknown>) => Promise<KernelLoopResponse>
  inspect: (includePrivate?: boolean) => Promise<KernelLoopResponse>
  waitFor: (reqId: string) => Promise<KernelLoopResponse>
} => {
  const child = spawn(rscript, [...(vanilla ? ['--vanilla'] : []), loopPath], {
    cwd,
    env: { ...process.env, ...env }
  })
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
  const waitFor = (reqId: string): Promise<KernelLoopResponse> =>
    new Promise((resolve, reject) => {
      waiters.set(reqId, { resolve, reject })
    })
  const send = (code: string): Promise<KernelLoopResponse> => {
    const reqId = randomUUID()
    const pending = waitFor(reqId)
    child.stdin.write(frameRRequest(reqId, code))
    return pending
  }
  const inspect = (includePrivate = false): Promise<KernelLoopResponse> => {
    const reqId = randomUUID()
    const pending = waitFor(reqId)
    child.stdin.write(frameRNamespaceRequest(reqId, includePrivate))
    return pending
  }
  const stage = (code: string, options: Record<string, unknown>): Promise<KernelLoopResponse> => {
    const reqId = randomUUID()
    const pending = waitFor(reqId)
    const body = Buffer.from(JSON.stringify({ code, ...options }), 'utf8')
    child.stdin.write(Buffer.concat([Buffer.from(`${reqId} ${body.length} execute_stage\n`), body]))
    return pending
  }
  return { child, send, stage, inspect, waitFor }
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

gate('r_loop.R stage checkpoints', () => {
  it('projects only an explicit fresh package context while preserving original scientific evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-package-context-'))
    const original = startLoop(rscriptBin(), {}, root, true)
    const baseOriginal = startLoop(rscriptBin(), {}, root, true)
    const loops = [original, baseOriginal]
    const fresh = (): ReturnType<typeof startLoop> => {
      const loop = startLoop(rscriptBin(), {}, root, true)
      loops.push(loop)
      return loop
    }
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    const baseCheckpoint = {
      input_path: join(root, 'base-input.rds'),
      output_path: join(root, 'base-output.rds')
    }
    const targetPackages = [
      'jsonlite',
      'stats',
      'graphics',
      'grDevices',
      'utils',
      'datasets',
      'methods',
      'base'
    ]
    const code = [
      'plotData <- utils::read.csv("data.csv", stringsAsFactors = FALSE)',
      'utils::write.csv(plotData, "copy.csv", row.names = FALSE)',
      'grDevices::png("plot.png", width = 320, height = 240)',
      'graphics::plot.default(plotData$x, plotData$y)',
      'grDevices::dev.off()'
    ].join('\n')
    writeFileSync(join(root, 'data.csv'), 'x,y\n1,2\n2,4\n3,3\n')
    const digest = (path: string): string =>
      createHash('sha256').update(readFileSync(path)).digest('hex')
    try {
      expect((await original.send('library(DESeq2); NULL')).error).toBeNull()
      expect(
        (await original.stage(code, { stage_checkpoint: checkpoint })).stageCheckpointCapture?.state
      ).toBe('available')
      const sourcePackages = JSON.parse(
        execFileSync(
          rscriptBin(),
          [
            '--vanilla',
            '-e',
            `cat(jsonlite::toJSON(readRDS(${JSON.stringify(checkpoint.input_path)})$packages))`
          ],
          { encoding: 'utf8' }
        )
      ) as string[]
      expect(sourcePackages).toContain('DESeq2')
      const packageContext = { schemaVersion: 1 as const, sourcePackages, targetPackages }
      const wireContext = {
        schema_version: 1,
        source_packages: sourcePackages,
        target_packages: targetPackages
      }
      const restore = {
        input_path: checkpoint.input_path,
        expected_output_path: checkpoint.output_path,
        package_context: wireContext,
        observe_runtime_footprint: true
      }
      const before = [digest(checkpoint.input_path), digest(checkpoint.output_path)]
      const files = [readFileSync(join(root, 'copy.csv')), readFileSync(join(root, 'plot.png'))]
      expect(
        (await baseOriginal.stage(code, { stage_checkpoint: baseCheckpoint })).error
      ).toBeNull()

      const replay = fresh()
      const result = await replay.stage(code, { stage_restore: restore })
      expect(result.error, JSON.stringify(result)).toBeNull()
      expect(result.stageComparison).toMatchObject({
        outcome: 'equal',
        scientificOutcome: 'equal',
        packageContext,
        runtimeFootprint: { processId: replay.child.pid }
      })
      expect(
        result.stageComparison?.runtimeFootprint?.packages.some(({ name }) => name === 'DESeq2')
      ).toBe(false)
      expect(result.stageComparison?.runtimeFootprint?.libraryPaths.length).toBeGreaterThan(0)
      expect(readFileSync(join(root, 'copy.csv'))).toEqual(files[0])
      expect(readFileSync(join(root, 'plot.png'))).toEqual(files[1])
      expect([digest(checkpoint.input_path), digest(checkpoint.output_path)]).toEqual(before)

      const warm = await replay.stage(code, { stage_restore: restore })
      expect(warm.executionStarted).toBe(false)
      expect(warm.stageComparison).toEqual({
        outcome: 'unavailable',
        reason: 'package-context-projection-requires-fresh-session'
      })
      const changed = await fresh().stage(
        code.replace('plotData$x, plotData$y', 'plotData$x, plotData$y + 1'),
        { stage_restore: restore }
      )
      // Image bytes remain a separate host comparison; the state graph must not claim to cover them.
      expect(changed.stageComparison?.scientificOutcome).toBe('equal')
      expect(readFileSync(join(root, 'plot.png'))).not.toEqual(files[1])
      const changedState = await fresh().stage(
        code.replace('utils::write.csv', 'plotData$y <- plotData$y + 1; utils::write.csv'),
        { stage_restore: restore }
      )
      expect(changed.stageComparison?.packageContext).toEqual(packageContext)
      expect(changedState.stageComparison).toMatchObject({
        outcome: 'different',
        scientificOutcome: 'different',
        packageContext
      })
      const wrongInput = await fresh().stage(code, {
        stage_restore: {
          ...restore,
          package_context: { ...wireContext, source_packages: targetPackages }
        }
      })
      expect(wrongInput.executionStarted).toBe(false)
      expect(wrongInput.stageComparison?.reason).toBe('package-context-source-mismatch')
      const wrongExpected = await fresh().stage(code, {
        stage_restore: { ...restore, expected_output_path: baseCheckpoint.output_path }
      })
      expect(wrongExpected.executionStarted).toBe(false)
      expect(wrongExpected.stageComparison?.reason).toBe('package-context-expected-source-mismatch')
      const wrongTarget = await fresh().stage(code, {
        stage_restore: {
          ...restore,
          package_context: { ...wireContext, target_packages: [...targetPackages, 'DESeq2'] }
        }
      })
      expect(wrongTarget.stageComparison?.reason).toBe('unsupported-package-context-target')
      // Exact recovery continues to attach the original package context and exposes only requested footprint metadata.
      const strict = await fresh().stage(code, {
        stage_restore: {
          input_path: checkpoint.input_path,
          expected_output_path: checkpoint.output_path,
          observe_runtime_footprint: true
        }
      })
      expect(strict.stageComparison?.outcome).toBe('equal')
      expect(strict.stageComparison).not.toHaveProperty('packageContext')
      expect(
        strict.stageComparison?.runtimeFootprint?.packages.some(({ name }) => name === 'DESeq2')
      ).toBe(true)
    } finally {
      await Promise.all(
        loops.map(async (loop) => {
          loop.child.stdin.end()
          await once(loop.child, 'exit')
        })
      )
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([
    'utils::packageVersion("Matrix"); NULL',
    'utils::packageVersion(pkg = "Matrix", lib.loc = NULL); NULL',
    'utils::packageVersion(lib.loc = NULL, "Matrix"); NULL'
  ])('retains literal default-library package metadata roots: %s', async (code) => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-package-version-root-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    try {
      const rawVersion = execFileSync(
        rscriptBin(),
        [
          '--vanilla',
          '-e',
          'cat(read.dcf(file.path(.Library, "Matrix", "DESCRIPTION"), fields = "Version")[1L, 1L])'
        ],
        { encoding: 'utf8' }
      )
      const captured = await loop.stage(code, {
        stage_checkpoint: {
          input_path: join(root, 'input.rds'),
          output_path: join(root, 'output.rds')
        }
      })
      expect(captured.error).toBeNull()
      expect(captured.stageCheckpointCapture).toMatchObject({ state: 'available' })
      const proof =
        captured.stageCheckpointCapture?.state === 'available'
          ? captured.stageCheckpointCapture.environmentProof
          : undefined
      expect(proof?.packages).toContainEqual({ name: 'Matrix', version: rawVersion })
      // The bare metadata call must retain its target without assigning the result
      // or loading a target namespace, either of which could mask the missing root.
      expect((await loop.send('cat("Matrix" %in% loadedNamespaces())')).stdout).toBe('FALSE')
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    { label: 'dynamic package target', code: 'utils::packageVersion(target); NULL' },
    {
      label: 'explicit library override',
      code: 'utils::packageVersion("Matrix", lib.loc = .Library); NULL'
    },
    { label: 'abbreviated package formal', code: 'utils::packageVersion(p = "Matrix"); NULL' },
    {
      label: 'abbreviated library formal',
      code: 'utils::packageVersion("Matrix", lib = NULL); NULL'
    }
  ])(
    'keeps metadata execution and checkpoints usable without proof for $label',
    async ({ code }) => {
      const root = mkdtempSync(join(tmpdir(), 'r-stage-unproven-package-version-'))
      const loop = startLoop(rscriptBin(), {}, root, true)
      try {
        expect((await loop.send('target <- "Matrix"; NULL')).error).toBeNull()
        const captured = await loop.stage(code, {
          stage_checkpoint: {
            input_path: join(root, 'input.rds'),
            output_path: join(root, 'output.rds')
          }
        })
        expect(captured.error).toBeNull()
        expect(captured.stageCheckpointCapture).toMatchObject({ state: 'available' })
        expect(
          captured.stageCheckpointCapture?.state === 'available'
            ? captured.stageCheckpointCapture.environmentProof
            : undefined
        ).toBeUndefined()
      } finally {
        loop.child.stdin.end()
        await once(loop.child, 'exit')
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('rejects the complete invalid object graph before optional proof serializes atomic attributes', () => {
    const result = execFileSync(
      rscriptBin(),
      [
        '--vanilla',
        '-e',
        [
          `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
          'owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
          'namespace_state <- new.env(parent = emptyenv()); capture_r_random_state <- function() NULL; eval(owner)',
          'owner_env <- environment(stage_checkpoint_owner$begin)',
          'owner_env$snapshot_budget_bytes <- 4096',
          'observed <- new.env(parent = emptyenv()); observed$calls <- 0L',
          'owner_env$serialize <- function(...) { observed$calls <- observed$calls + 1L; base::serialize(...) }',
          'hidden <- new.env(parent = emptyenv()); hidden$payload <- raw(1024^2)',
          'invalid <- structure(1, hidden = hidden)',
          'plain <- tryCatch(owner_env$validate(invalid), error = conditionMessage)',
          'stopifnot(identical(plain, "unsupported-object-reference"), observed$calls == 0L)',
          'proof <- owner_env$new_environment_proof(character())',
          'with_proof <- tryCatch(owner_env$validate(invalid, environment_proof = proof), error = conditionMessage)',
          'stopifnot(identical(with_proof, plain), observed$calls == 0L)',
          'owner_env$validate(structure(1, hidden = list(value = 3)), environment_proof = proof)',
          'stopifnot(observed$calls > 0L, !is.null(owner_env$finish_environment_proof(proof, character())))',
          'cat("invalid-object-rejected-before-proof-serialization")'
        ].join('\n')
      ],
      { encoding: 'utf8' }
    )
    expect(result).toBe('invalid-object-rejected-before-proof-serialization')
  })

  it('captures and restores the qualified original volcano source while rejecting unknown method history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-qualified-volcano-'))
    writeFileSync(
      join(root, 'de-results.csv'),
      ',log2FoldChange,pvalue\ngene1,-2,0.001\ngene2,-0.5,0.2\ngene3,1.5,0.03\ngene4,3,0.00001\n'
    )
    const original = startLoop(rscriptBin(), {}, root, true)
    const replay = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    // Keep the reported source verbatim, including png/dev.off and explicit
    // plot.default. The package allowlist must support the original workflow.
    const code = [
      'plotData <- utils::read.csv("de-results.csv", row.names = 1, stringsAsFactors = FALSE)',
      'grDevices::png("volcano.png", width = 640, height = 480)',
      'graphics::plot.default(plotData$log2FoldChange, -base::log10(base::pmax(plotData$pvalue, 1e-300)), pch = 16, xlab = "log2 fold change", ylab = "-log10 p-value", main = "Original workflow")',
      'graphics::abline(v = base::c(-1, 1), h = -base::log10(0.05), lty = 2)',
      'grDevices::dev.off()'
    ].join('\n')
    expect(createHash('sha256').update(code).digest('hex')).toBe(
      '3160d3afa7780fc6627bd0da0f2cef1126611ecce152a03af532a017eb447efe'
    )
    try {
      const captured = await original.stage(code, { stage_checkpoint: checkpoint })
      expect(captured.error).toBeNull()
      expect(captured.stageCheckpointCapture).toMatchObject({ state: 'available' })
      const png = readFileSync(join(root, 'volcano.png'))
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      const options = execFileSync(
        rscriptBin(),
        [
          '--vanilla',
          '-e',
          [
            `input <- readRDS(${JSON.stringify(checkpoint.input_path)})`,
            `output <- readRDS(${JSON.stringify(checkpoint.output_path)})`,
            'stopifnot(identical(input$schema, 2L), identical(output$schema, 3L))',
            'required <- c("device", "device.ask.default", "bitmapType", "preferRaster", "OutDec", "digits", "digits.secs", "scipen", "width", "max.print", "verbose")',
            'stopifnot(all(required %in% input$option_names), identical(input$option_names, output$option_names))',
            'cat("graphics-options-captured")'
          ].join('\n')
        ],
        { encoding: 'utf8' }
      )
      expect(options).toBe('graphics-options-captured')
      const restored = await replay.stage(code, {
        stage_restore: {
          input_path: checkpoint.input_path,
          expected_output_path: checkpoint.output_path
        }
      })
      expect(restored.error).toBeNull()
      expect(restored.stageComparison).toEqual({ outcome: 'equal' })
      expect(readFileSync(join(root, 'volcano.png'))).toEqual(png)
      expect(
        (await replay.send('base::registerS3method("plot", "stage_unknown", function(...) NULL)'))
          .error
      ).toBeNull()
      const unproven = await replay.stage(code, { stage_checkpoint: checkpoint })
      expect(unproven.error).toBeNull()
      expect(unproven.stageCheckpointCapture).toEqual({
        state: 'unavailable',
        reason: expect.stringMatching(/^unsupported-method-history:dynamic-call:registerS3method/)
      })
    } finally {
      original.child.stdin.end()
      replay.child.stdin.end()
      await Promise.all([once(original.child, 'exit'), once(replay.child, 'exit')])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('proves original-context package roots without treating unused loaded namespaces as dependencies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-environment-roots-'))
    const profile = join(root, 'profile.R')
    writeFileSync(profile, 'invisible(requireNamespace("splines", quietly = TRUE))\n')
    const loop = startLoop(rscriptBin(), { R_PROFILE_USER: profile }, root)
    try {
      const captured = await loop.stage('answer <- 42; NULL', {
        stage_checkpoint: {
          input_path: join(root, 'input.rds'),
          output_path: join(root, 'output.rds')
        }
      })
      expect(captured.error).toBeNull()
      expect(captured.stageCheckpointCapture).toMatchObject({ state: 'available' })
      const proof =
        captured.stageCheckpointCapture?.state === 'available'
          ? captured.stageCheckpointCapture.environmentProof
          : undefined
      expect(proof).toMatchObject({ schemaVersion: 1 })
      const packages = proof?.packages.map(({ name }) => name)
      expect(packages?.sort()).toEqual(
        [
          'base',
          'datasets',
          'grDevices',
          'graphics',
          'jsonlite',
          'methods',
          'stats',
          'utils'
        ].sort()
      )
      expect(proof?.packages.every(({ version }) => version.length > 0)).toBe(true)
      // splines is installed and actually loaded, but is neither attached nor used
      // by the captured source/objects. This asserts the live precondition too.
      expect((await loop.send('cat("splines" %in% loadedNamespaces())')).stdout).toBe('TRUE')
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'unknown S3 class',
      code: 'value <- structure(7, class = "UnreviewedStageClass"); NULL'
    },
    { label: 'special ALTREP serialization', code: 'value <- 1:10; NULL' }
  ])('keeps checkpoints usable without environment proof for $label', async ({ code }) => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-unproven-environment-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    try {
      const captured = await loop.stage(code, { stage_checkpoint: checkpoint })
      expect(captured.error).toBeNull()
      expect(captured.stageCheckpointCapture).toMatchObject({ state: 'available' })
      expect(
        captured.stageCheckpointCapture?.state === 'available'
          ? captured.stageCheckpointCapture.environmentProof
          : undefined
      ).toBeUndefined()
      const restored = await loop.stage(code, {
        stage_restore: {
          input_path: checkpoint.input_path,
          expected_output_path: checkpoint.output_path
        }
      })
      expect(restored.error).toBeNull()
      expect(restored.stageComparison).toEqual({ outcome: 'equal' })
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'omits environment proof when the declared default library contains package symlinks',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'r-stage-shadow-environment-'))
      const library = execFileSync(rscriptBin(), ['--vanilla', '-e', 'cat(.Library)'], {
        encoding: 'utf8'
      })
      const declaredLibrary = join(root, 'declared-library')
      mkdirSync(declaredLibrary)
      symlinkSync(join(library, 'base'), join(declaredLibrary, 'base'), 'dir')
      const loopPath = join(root, 'loop.R')
      const source = readFileSync(LOOP, 'utf8')
      const ownerContext =
        'base::list(namespace_state = namespace_state,\n  capture_rng = capture_r_random_state)'
      expect(source).toContain(ownerContext)
      writeFileSync(
        loopPath,
        // Supply the observer a declared library with an external package link;
        // keep R's own startup library intact so the real cell still executes.
        source.replace(
          ownerContext,
          `base::list(.Library = ${JSON.stringify(declaredLibrary)}, namespace_state = namespace_state,\n  capture_rng = capture_r_random_state)`
        )
      )
      const loop = startLoop(rscriptBin(), {}, root, true, loopPath)
      try {
        const captured = await loop.stage('answer <- 42; NULL', {
          stage_checkpoint: {
            input_path: join(root, 'input.rds'),
            output_path: join(root, 'output.rds')
          }
        })
        expect(captured.error).toBeNull()
        expect(captured.stageCheckpointCapture).toMatchObject({ state: 'available' })
        expect(
          captured.stageCheckpointCapture?.state === 'available'
            ? captured.stageCheckpointCapture.environmentProof
            : undefined
        ).toBeUndefined()
        expect((await loop.send('cat(answer)')).stdout).toBe('42')
      } finally {
        loop.child.stdin.end()
        await once(loop.child, 'exit')
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('collects fitted S4 class and closure namespace roots without requiring them to be attached', () => {
    const result = execFileSync(
      rscriptBin(),
      [
        '--vanilla',
        '-e',
        [
          // This probe owns no user execution: it exercises the same validator over
          // a real object while deliberately supplying no attached-package roots.
          'stopifnot(requireNamespace("DESeq2", quietly = TRUE))',
          `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
          'owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
          'namespace_state <- new.env(parent = emptyenv()); capture_r_random_state <- function() NULL; eval(owner)',
          'owner_env <- environment(stage_checkpoint_owner$begin)',
          'counts <- matrix(rep(c(10L, 11L, 20L, 22L), 50), ncol = 4)',
          'samples <- data.frame(condition = factor(c("a", "a", "b", "b")))',
          'dds <- DESeq2::DESeq(DESeq2::DESeqDataSetFromMatrix(counts, samples, ~ condition), fitType = "mean", quiet = TRUE)',
          'proof <- owner_env$new_environment_proof(character())',
          'owner_env$validate(list(dds), environment_proof = proof)',
          'value <- owner_env$finish_environment_proof(proof, character())',
          'stopifnot(!is.null(value), !"package:DESeq2" %in% search())',
          'names <- vapply(value$packages, `[[`, character(1), "name")',
          'stopifnot(all(c("DESeq2", "SummarizedExperiment", "GenomicRanges", "S4Vectors", "IRanges", "rlang") %in% names))',
          'stopifnot(!"Matrix" %in% names)',
          // Matrix is loaded transitively, but becomes a root only when explicitly
          // needed. Its raw DESCRIPTION version differs from the namespace spelling.
          'owner_env$environment_proof_package(proof, "Matrix")',
          'value <- owner_env$finish_environment_proof(proof, character())',
          'matrix <- Filter(function(entry) entry$name == "Matrix", value$packages)[[1L]]',
          'raw_version <- unname(read.dcf(file.path(.Library, "Matrix", "DESCRIPTION"), fields = "Version")[1L, 1L])',
          'stopifnot(identical(matrix$version, raw_version), identical(package_version(matrix$version), package_version(as.character(getNamespaceVersion("Matrix")))))',
          'cat("fitted-S4-and-namespace-roots")'
        ].join('\n')
      ],
      { encoding: 'utf8' }
    )
    expect(result).toBe('fitted-S4-and-namespace-roots')
  }, 120_000)

  it.each(['trusted-control', 'ordinary-source'] as const)(
    'isolates interrupt probe history from user source: %s',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'r-interrupt-control-history-'))
      const loop = startLoop(rscriptBin(), {}, root, true)
      const capture = (name: string): Promise<KernelLoopResponse> =>
        loop.stage('answer <- 42; NULL', {
          stage_checkpoint: {
            input_path: join(root, `${name}-input.rds`),
            output_path: join(root, `${name}-output.rds`)
          }
        })
      const probe = async (): Promise<KernelLoopResponse> => {
        const id = randomUUID()
        const pending = loop.waitFor(id)
        loop.child.stdin.write(frameRInterruptProbeRequest(id))
        return pending
      }
      try {
        expect((await capture('before')).stageCheckpointCapture?.state).toBe('available')
        const response =
          mode === 'trusted-control' ? await probe() : await loop.send('base::Sys.sleep(0.05)')
        expect(response.error).toBeNull()
        if (mode === 'trusted-control') {
          expect(response.environmentOverlay).toBeUndefined()
          expect(response.stageCheckpointCapture).toBeUndefined()
          expect((await loop.inspect()).namespace?.variables.some((v) => v.name === 'answer')).toBe(
            true
          )
          expect((await capture('after')).stageCheckpointCapture?.state).toBe('available')
          // The control must not erase unsupported history from a later ordinary user call.
          expect((await loop.send('base::Sys.sleep(0.05)')).error).toBeNull()
        }
        expect((await probe()).error).toBeNull()
        expect((await capture('blocked')).stageCheckpointCapture).toEqual({
          state: 'unavailable',
          reason: 'unsupported-method-history:unreviewed-call:base::Sys.sleep'
        })
      } finally {
        loop.child.stdin.end()
        await once(loop.child, 'exit')
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('rejects interrupt control payloads without execution and keeps UTF-8 frames aligned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-interrupt-control-payload-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    try {
      const id = randomUUID()
      const pending = loop.waitFor(id)
      const body = Buffer.from('payload_executed <- "恶意"', 'utf8')
      loop.child.stdin.write(
        Buffer.concat([Buffer.from(`${id} ${body.byteLength} interrupt_probe\n`), body])
      )
      expect(await pending).toMatchObject({ error: 'Invalid interrupt probe request' })
      expect((await loop.send('cat(exists("payload_executed"))')).stdout).toBe('FALSE')
      const captured = await loop.stage('answer <- "café"; NULL', {
        stage_checkpoint: {
          input_path: join(root, 'input.rds'),
          output_path: join(root, 'output.rds')
        }
      })
      expect(captured.stageCheckpointCapture?.state).toBe('available')
      await loop.send(
        'Sys.sleep <- function(...) stop("masked sleep"); interrupt_sleep <- Sys.sleep; interrupt_probe <- Sys.sleep; getwd <- Sys.sleep'
      )
      const probeId = randomUUID()
      const probe = loop.waitFor(probeId)
      loop.child.stdin.write(frameRInterruptProbeRequest(probeId))
      expect(await probe).toMatchObject({ error: null, cwd: captured.cwd })
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'acknowledges an interrupted trusted control without tainting capture',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'r-interrupt-control-ack-'))
      const loop = startLoop(rscriptBin(), {}, root, true)
      try {
        expect((await loop.send('NULL')).error).toBeNull()
        const id = randomUUID()
        const pending = loop.waitFor(id)
        loop.child.stdin.write(frameRInterruptProbeRequest(id))
        await new Promise((resolve) => setTimeout(resolve, 10))
        loop.child.kill('SIGINT')
        const interrupted = await pending
        expect(interrupted).toMatchObject({ error: 'interrupted', interruptAck: true })
        expect(interrupted.environmentOverlay).toBeUndefined()
        const captured = await loop.stage('answer <- 42; NULL', {
          stage_checkpoint: {
            input_path: join(root, 'input.rds'),
            output_path: join(root, 'output.rds')
          }
        })
        expect(captured.stageCheckpointCapture?.state).toBe('available')
      } finally {
        loop.child.stdin.end()
        await once(loop.child, 'exit')
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each([
    { label: 'ordinary', fixture: 'pairlist(a = 1L, empty = NULL, b = 2L)' },
    {
      label: 'attributed',
      fixture:
        'structure(pairlist(a = 1L, empty = NULL), class = "PairlistFixture", note = pairlist(label = "original"))'
    },
    {
      label: 'nested',
      fixture:
        'pairlist(a = list(inner = pairlist(value = 1L, empty = NULL)), b = pairlist(NULL, 2L))'
    },
    { label: 'missing formals', fixture: 'as.pairlist(alist(a = , b = NULL, ... = ))' }
  ])(
    'preserves $label pairlist types and contents in a fresh checkpoint loop',
    async ({ fixture }) => {
      const root = mkdtempSync(join(tmpdir(), 'r-stage-pairlist-types-'))
      const original = startLoop(rscriptBin(), {}, root, true)
      const replay = startLoop(rscriptBin(), {}, root, true)
      const checkpoint = {
        input_path: join(root, 'input.rds'),
        output_path: join(root, 'output.rds')
      }
      const code = 'p <- p; NULL'
      try {
        execFileSync(
          rscriptBin(),
          ['--vanilla', '-e', `base::saveRDS(${fixture}, "fixture.rds")`],
          { cwd: root }
        )
        expect((await original.send('p <- base::readRDS("fixture.rds"); NULL')).error).toBeNull()
        const captured = await original.stage(code, { stage_checkpoint: checkpoint })
        expect(captured.error).toBeNull()
        expect(captured.stageCheckpointCapture).toMatchObject({
          state: 'available',
          inputNames: ['p'],
          outputNames: ['p']
        })
        expect((await original.send('base::saveRDS(p, "original.rds"); NULL')).error).toBeNull()
        const restored = await replay.stage(code, {
          stage_restore: {
            input_path: checkpoint.input_path,
            expected_output_path: checkpoint.output_path
          }
        })
        expect(restored.error).toBeNull()
        expect(restored.stageComparison).toEqual({ outcome: 'equal' })
        expect((await replay.send('base::saveRDS(p, "replay.rds"); NULL')).error).toBeNull()
        const checked = execFileSync(
          rscriptBin(),
          [
            '--vanilla',
            '-e',
            [
              'fixture <- readRDS("fixture.rds"); original <- readRDS("original.rds"); replay <- readRDS("replay.rds")',
              'stopifnot(identical(typeof(original), "pairlist"), identical(typeof(replay), "pairlist"))',
              'stopifnot(identical(fixture, original), identical(original, replay))',
              'cat("pairlist-preserved")'
            ].join('\n')
          ],
          { cwd: root, encoding: 'utf8' }
        )
        expect(checked).toBe('pairlist-preserved')
      } finally {
        original.child.stdin.end()
        replay.child.stdin.end()
        await Promise.all([once(original.child, 'exit'), once(replay.child, 'exit')])
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it('preserves nested pairlist DESeq aliases across fresh restore and continuous comparison', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-pairlist-deseq-alias-'))
    const original = startLoop(rscriptBin(), {}, root, true)
    const replay = startLoop(rscriptBin(), {}, root, true)
    const paths = (name: string): { input_path: string; output_path: string } => ({
      input_path: join(root, `${name}-input.rds`),
      output_path: join(root, `${name}-output.rds`)
    })
    const first = paths('first')
    const later = paths('later')
    try {
      execFileSync(
        rscriptBin(),
        [
          '--vanilla',
          '-e',
          [
            'suppressPackageStartupMessages(library(DESeq2)); set.seed(42)',
            'counts <- matrix(rnbinom(6000, mu = 100, size = 10), nrow = 1000)',
            'colnames(counts) <- paste0("sample", 1:6); rownames(counts) <- paste0("gene", 1:1000)',
            'samples <- data.frame(condition = factor(rep(c("control", "treated"), each = 3)), row.names = colnames(counts))',
            'dds <- DESeq(DESeqDataSetFromMatrix(counts, samples, ~ condition), fitType = "local", quiet = TRUE)',
            'p <- structure(pairlist(first = dds, nested = list(second = dds), empty = NULL), note = "aliases")',
            'base::saveRDS(p, "fixture.rds")'
          ].join('\n')
        ],
        { cwd: root }
      )
      expect(
        (
          await original.send(
            'suppressPackageStartupMessages(library(DESeq2)); p <- base::readRDS("fixture.rds"); NULL'
          )
        ).error
      ).toBeNull()
      expect(
        (await original.stage('p <- p; NULL', { stage_checkpoint: first })).stageCheckpointCapture
      ).toMatchObject({ state: 'available' })
      expect(
        (await original.stage('q <- p; NULL', { stage_checkpoint: later })).stageCheckpointCapture
      ).toMatchObject({ state: 'available' })
      expect(
        (await original.send('base::saveRDS(list(p = p, q = q), "original.rds"); NULL')).error
      ).toBeNull()
      const restored = await replay.stage('p <- p; NULL', {
        stage_restore: { input_path: first.input_path, expected_output_path: first.output_path }
      })
      expect(restored.error).toBeNull()
      expect(restored.stageComparison).toEqual({ outcome: 'equal' })
      const compared = await replay.stage('q <- p; NULL', {
        stage_expected_output_path: later.output_path
      })
      expect(compared.error).toBeNull()
      expect(compared.stageComparison).toEqual({ outcome: 'equal' })
      expect(
        (await replay.send('base::saveRDS(list(p = p, q = q), "replay.rds"); NULL')).error
      ).toBeNull()
      const checked = execFileSync(
        rscriptBin(),
        [
          '--vanilla',
          '-e',
          [
            'suppressPackageStartupMessages(library(DESeq2))',
            'original <- readRDS("original.rds"); replay <- readRDS("replay.rds")',
            'for (value in list(original, replay)) {',
            'stopifnot(identical(typeof(value$p), "pairlist"), identical(typeof(value$q), "pairlist"), identical(attr(value$p, "note"), "aliases"), is.null(value$p$empty))',
            'stopifnot(identical(environment(dispersionFunction(value$p$first)), environment(dispersionFunction(value$p$nested$second))), identical(environment(dispersionFunction(value$p$first)), environment(dispersionFunction(value$q$first))))',
            '}',
            'stopifnot(identical(counts(original$p$first), counts(replay$p$first)), identical(dispersionFunction(original$p$first)(c(1, 3.5, 20000)), dispersionFunction(replay$p$first)(c(1, 3.5, 20000))))',
            'cat("pairlist-deseq-aliases-preserved")'
          ].join('\n')
        ],
        { cwd: root, encoding: 'utf8' }
      )
      expect(checked).toBe('pairlist-deseq-aliases-preserved')
    } finally {
      original.child.stdin.end()
      replay.child.stdin.end()
      await Promise.all([once(original.child, 'exit'), once(replay.child, 'exit')])
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('rejects over-budget containers in begin before reconstruction or method dispatch', () => {
    const output = execFileSync(
      rscriptBin(),
      [
        '--vanilla',
        '-e',
        [
          `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
          'owner_node <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
          'rng_node <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("capture_r_random_state")), nodes)[[1L]]',
          'local({',
          'root <- tempfile(); dir.create(root); on.exit(unlink(root, recursive = TRUE)); set.seed(42)',
          'for (pair in c(FALSE, TRUE)) {',
          'harness <- new.env(parent = baseenv()); harness$namespace_state <- new.env(parent = emptyenv())',
          'harness$namespace_state$internal_names <- ls(globalenv(), all.names = TRUE); harness$namespace_state$written_names <- character(); harness$namespace_state$lazy_names <- character()',
          'eval(rng_node, harness); eval(owner_node, harness); owner <- harness$stage_checkpoint_owner; owner$seal_options()',
          'env <- environment(owner$begin); env$snapshot_budget_bytes <- 64; copies <- 0L',
          'watched <- function(x) typeof(x) %in% c("list", "pairlist") && !is.object(x) && length(x) == 10000L',
          'env$`[<-` <- function(x, ..., value) { if (watched(x)) copies <<- copies + 1L; base::`[<-`(x, ..., value = value) }',
          'env$as.list <- function(x, ...) { if (watched(x)) copies <<- copies + 1L; base::as.list(x, ...) }',
          'env$lapply <- function(X, FUN, ...) { if (watched(X)) copies <<- copies + 1L; base::lapply(X, FUN, ...) }',
          'payload <- rep(list(NULL), 10000); if (pair) payload <- as.pairlist(payload); assign("budget_payload", payload, globalenv())',
          'req <- list(stage_checkpoint = list(input_path = file.path(root, "input.rds"), output_path = file.path(root, "output.rds")))',
          'state <- owner$begin(req, parse(text = "copy <- budget_payload; NULL"))',
          'stopifnot(identical(state, list(state = "unavailable", reason = "object-byte-budget")), copies == 0L, identical(get("budget_payload", globalenv()), payload), !file.exists(req$stage_checkpoint$input_path))',
          'rm("budget_payload", envir = globalenv())',
          '}',
          'traps <- c("as.list.CopyTrap", "as.list.pairlist", "as.pairlist.CopyTrap", "length.CopyTrap", "[.CopyTrap", "[[.CopyTrap", "[<-.CopyTrap", "object.size.CopyTrap")',
          'for (name in traps) assign(name, function(...) stop("must not dispatch"), globalenv()); on.exit(rm(list = traps, envir = globalenv()), add = TRUE)',
          'harness <- new.env(parent = baseenv()); harness$namespace_state <- new.env(parent = emptyenv())',
          'harness$namespace_state$internal_names <- ls(globalenv(), all.names = TRUE); harness$namespace_state$written_names <- character(); harness$namespace_state$lazy_names <- character()',
          'eval(rng_node, harness); eval(owner_node, harness); owner <- harness$stage_checkpoint_owner; owner$seal_options()',
          'env <- environment(owner$begin); pair <- pairlist(value = 1L, empty = NULL); stopifnot(identical(env$project_values(pair), pair))',
          'payload <- structure(list(value = 1L, empty = NULL), class = "CopyTrap"); assign("budget_payload", payload, globalenv())',
          'on.exit(rm("budget_payload", envir = globalenv()), add = TRUE)',
          'state <- owner$begin(req, parse(text = "copy <- budget_payload; NULL"))',
          'stopifnot(identical(state$state, "capturing"), identical(readRDS(req$stage_checkpoint$input_path)$bindings$budget_payload, payload))',
          'cat("begin-budget-before-copy")',
          '})'
        ].join('\n')
      ],
      { encoding: 'utf8' }
    )
    expect(output).toBe('begin-budget-before-copy')
  })

  it.each(['input', 'output', 'compare'] as const)(
    'refuses pre-container-fix checkpoint proof before %s execution',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'r-stage-old-container-proof-'))
      const original = startLoop(rscriptBin(), {}, root, true)
      const replay = startLoop(rscriptBin(), {}, root, true)
      const checkpoint = {
        input_path: join(root, 'input.rds'),
        output_path: join(root, 'output.rds')
      }
      const code = 'p <- p; sentinel <- sentinel + 1L; NULL'
      try {
        expect(
          (await original.send('p <- pairlist(a = 1L, empty = NULL); sentinel <- 0L; NULL')).error
        ).toBeNull()
        expect(
          (await original.stage(code, { stage_checkpoint: checkpoint })).stageCheckpointCapture
        ).toMatchObject({ state: 'available' })
        if (scenario === 'compare') {
          expect(
            (
              await replay.stage(code, {
                stage_restore: {
                  input_path: checkpoint.input_path,
                  expected_output_path: checkpoint.output_path
                }
              })
            ).stageComparison
          ).toEqual({ outcome: 'equal' })
        }
        expect((await replay.send('sentinel <- 0L; NULL')).error).toBeNull()
        const path = scenario === 'input' ? checkpoint.input_path : checkpoint.output_path
        const change =
          scenario === 'input'
            ? 'value$options$proof <- "literal-and-reviewed-profiles-v2"; value$bindings$p <- as.list(value$bindings$p)'
            : 'value$context_proof <- "literal-and-reviewed-profiles-v2"; value$input_options$proof <- "literal-and-reviewed-profiles-v2"'
        execFileSync(rscriptBin(), [
          '--vanilla',
          '-e',
          `path <- commandArgs(TRUE)[1]; value <- readRDS(path); ${change}; saveRDS(value, path); stopifnot(is.list(readRDS(path)))`,
          path
        ])
        const rejected = await replay.stage(
          code,
          scenario === 'compare'
            ? { stage_expected_output_path: checkpoint.output_path }
            : {
                stage_restore: {
                  input_path: checkpoint.input_path,
                  expected_output_path: checkpoint.output_path
                }
              }
        )
        expect(rejected.executionStarted).toBe(false)
        expect(rejected.stageComparison).toEqual({
          outcome: 'unavailable',
          reason:
            scenario === 'input'
              ? 'invalid-checkpoint-context'
              : 'unsupported-expected-output-format'
        })
        expect((await replay.send('cat(sentinel)')).stdout).toBe('0')
        expect((await replay.send('cat(exists("p", inherits = FALSE))')).stdout).toBe(
          scenario === 'compare' ? 'TRUE' : 'FALSE'
        )
        if (scenario === 'compare')
          expect((await replay.send('cat(typeof(p), p$a)')).stdout).toBe('pairlist 1')
      } finally {
        original.child.stdin.end()
        replay.child.stdin.end()
        await Promise.all([once(original.child, 'exit'), once(replay.child, 'exit')])
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it('budgets checkpoint graphs without size dispatch or forcing private bindings', () => {
    const output = execFileSync(
      rscriptBin(),
      [
        '--vanilla',
        '-e',
        [
          `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
          'owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
          'namespace_state <- new.env(parent = emptyenv()); capture_r_random_state <- function() list(state = "available", kinds = as.list(RNGkind()), seed = as.list(.Random.seed))',
          'eval(owner); env <- environment(stage_checkpoint_owner$begin)',
          'validate <- env$validate; snapshot <- env$output_snapshot',
          'object.size.BudgetTrap <- function(...) stop("size dispatch")',
          'length.BudgetTrap <- function(...) stop("length dispatch")',
          'stopifnot(identical(tryCatch(validate(structure(rep(0, 1000), class = "BudgetTrap"), max_bytes = 100), error = conditionMessage), "object-byte-budget"))',
          'methods::setClass("BudgetS4", slots = c(payload = "numeric", callback = "function"))',
          'e <- new.env(parent = baseenv()); e$payload <- rep(0, 1000); callback <- function() NULL; environment(callback) <- e',
          'stopifnot(identical(tryCatch(validate(methods::new("BudgetS4", payload = rep(0, 1000), callback = callback), max_bytes = 100), error = conditionMessage), "object-byte-budget"))',
          'suppressPackageStartupMessages(library(rlang))',
          'stopifnot(identical(tryCatch(validate(list(callback), allow_namespace_functions = TRUE, max_bytes = 1000), error = conditionMessage), "object-byte-budget"))',
          'e <- new.env(parent = baseenv()); delayedAssign("payload", stop("must not force"), assign.env = e); environment(callback) <- e',
          'stopifnot(identical(tryCatch(validate(list(callback), allow_namespace_functions = TRUE), error = conditionMessage), "lazy-object-binding"))',
          'rm("payload", envir = e); makeActiveBinding("payload", function() stop("must not activate"), e)',
          'stopifnot(identical(tryCatch(validate(list(callback), allow_namespace_functions = TRUE), error = conditionMessage), "active-object-binding"))',
          'env$snapshot_budget_bytes <- 1000; env$serialize <- function(...) stop("serialize-started"); env$saveRDS <- function(...) stop("save-started")',
          'set.seed(42); before <- .Random.seed',
          'stopifnot(identical(tryCatch(snapshot(list(x = rep(0, 1000)), NULL), error = conditionMessage), "object-byte-budget"), identical(before, .Random.seed))',
          'cat("budget-safe")'
        ].join('\n')
      ],
      { encoding: 'utf8' }
    )
    expect(output).toBe('budget-safe')
  })

  it('keeps original execution and later requests alive after an observer byte budget rejection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-small-budget-'))
    const loopPath = join(root, 'r_loop.R')
    writeFileSync(
      loopPath,
      readFileSync(LOOP, 'utf8').replace(
        'snapshot_budget_bytes <- 32 * 1024^2',
        'snapshot_budget_bytes <- 16000'
      )
    )
    const loop = startLoop(rscriptBin(), {}, root, true, loopPath)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    try {
      const output = await loop.stage('big <- rep(0, 10000); NULL', {
        stage_checkpoint: checkpoint
      })
      expect(output.error).toBeNull()
      expect(output.stageCheckpointCapture).toEqual({
        state: 'unavailable',
        reason: 'object-byte-budget'
      })
      const input = await loop.stage('copy <- big; NULL', { stage_checkpoint: checkpoint })
      expect(input.error).toBeNull()
      expect(input.stageCheckpointCapture).toEqual({
        state: 'unavailable',
        reason: 'object-byte-budget'
      })
      const later = await loop.send('cat(length(big), sum(copy))')
      expect(later.error).toBeNull()
      expect(later.stdout).toBe('10000 0')
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores formatting options used by the kernel implicit visible-value print', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-implicit-print-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    try {
      await loop.send('options(digits = 3)')
      const captured = await loop.stage('1 / 3', { stage_checkpoint: checkpoint })
      expect(captured.stageCheckpointCapture?.state).toBe('available')
      expect(captured.stdout).toContain('0.333')
      await loop.send('options(digits = 7)')
      const restored = await loop.stage('1 / 3', {
        stage_restore: {
          input_path: checkpoint.input_path,
          expected_output_path: checkpoint.output_path
        }
      })
      expect(restored.error).toBeNull()
      expect(restored.stdout).toBe(captured.stdout)
      expect(restored.stageComparison?.outcome).toBe('equal')
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('captures only proven options and preserves literal absence and default evaluation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-proven-options-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    try {
      await loop.send(
        'options(stage_unrelated_env = new.env(), stage_unrelated_string = "UNRELATED_CANARY"); x <- 7'
      )
      const code = 'result <- getOption("stage_missing", x + 1); options(stage_written = 3); NULL'
      const captured = await loop.stage(code, { stage_checkpoint: checkpoint })
      expect(captured.error).toBeNull()
      expect(captured.stageCheckpointCapture?.state).toBe('available')
      const shape = execFileSync(
        rscriptBin(),
        [
          '--vanilla',
          '-e',
          [
            `input <- readRDS(${JSON.stringify(checkpoint.input_path)}); output <- readRDS(${JSON.stringify(checkpoint.output_path)})`,
            'stopifnot(!any(c("stage_unrelated_env", "stage_unrelated_string") %in% names(input$options$values)), "stage_missing" %in% names(input$options$values), is.null(input$options$values$stage_missing))',
            'stopifnot(!grepl(paste(sprintf("%02x", as.integer(charToRaw("UNRELATED_CANARY"))), collapse = ""), paste(sprintf("%02x", as.integer(output$comparison)), collapse = ""), fixed = TRUE))',
            'cat("proven-options")'
          ].join('\n')
        ],
        { encoding: 'utf8' }
      )
      expect(shape).toBe('proven-options')
      await loop.send(
        'options(stage_missing = 99, stage_written = 99, stage_unrelated_string = "CURRENT_CANARY")'
      )
      const restored = await loop.stage(code, {
        stage_restore: {
          input_path: checkpoint.input_path,
          expected_output_path: checkpoint.output_path
        }
      })
      expect(restored.error).toBeNull()
      expect(restored.stageComparison?.outcome).toBe('equal')
      const current = await loop.send(
        'cat(result, getOption("stage_written"), getOption("stage_unrelated_string"))'
      )
      expect(current.stdout).toBe('8 3 CURRENT_CANARY')
      await loop.send('options(stage_bad = structure(7, class = "UnreviewedOptionClass"))')
      const classed = await loop.stage('result <- getOption("stage_bad"); NULL', {
        stage_checkpoint: checkpoint
      })
      expect(classed.error).toBeNull()
      expect(classed.stageCheckpointCapture).toMatchObject({
        state: 'unavailable',
        reason: 'unsupported-option-data'
      })
      const dynamic = await loop.stage('name <- "stage_missing"; y <- getOption(name); NULL', {
        stage_checkpoint: checkpoint
      })
      expect(dynamic.error).toBeNull()
      expect(dynamic.stageCheckpointCapture).toMatchObject({
        state: 'unavailable',
        reason: 'dynamic-option-dependency'
      })
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supplements unknown option dependencies while retaining selected writes and rejecting missing or legacy proof', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-option-frontier-'))
    const original = startLoop(rscriptBin(), {}, root, true)
    const replay = startLoop(rscriptBin(), {}, root, true)
    const paths = (name: string): { input_path: string; output_path: string } => ({
      input_path: join(root, `${name}-input.rds`),
      output_path: join(root, `${name}-output.rds`)
    })
    const clean = paths('clean')
    const model = paths('model')
    const writer = paths('writer')
    const reader = paths('reader')
    const cleanCode = 'x <- 1; NULL'
    const modelCode =
      'result <- model.matrix(~ condition, data.frame(condition = factor(c("a", "b")))); NULL'
    const writerCode = 'options(stage_custom = 1); NULL'
    const readerCode = 'result <- getOption("stage_custom"); NULL'
    try {
      const defaultNamed = paths('default-named')
      const defaultCapture = await original.stage(modelCode, { stage_checkpoint: defaultNamed })
      expect(defaultCapture.stageCheckpointCapture, JSON.stringify(defaultCapture)).toMatchObject({
        state: 'available'
      })
      const defaultRestore = await replay.stage(modelCode, {
        stage_restore: {
          input_path: defaultNamed.input_path,
          expected_output_path: defaultNamed.output_path
        }
      })
      expect(defaultRestore.stageComparison, JSON.stringify(defaultRestore)).toEqual({
        outcome: 'equal'
      })
      await original.send('options(contrasts = c("contr.sum", "contr.poly"))')
      for (const [code, checkpoint] of [
        [cleanCode, clean],
        [modelCode, model],
        [writerCode, writer],
        [readerCode, reader]
      ] as const) {
        const captured = await original.stage(code, { stage_checkpoint: checkpoint })
        expect(captured.error).toBeNull()
        expect(captured.stageCheckpointCapture, JSON.stringify(captured)).toMatchObject({
          state: 'available'
        })
      }
      await replay.send('NULL')
      const noFrontier = await replay.stage(modelCode, {
        stage_expected_output_path: model.output_path
      })
      expect(noFrontier.stageComparison).toEqual({
        outcome: 'unavailable',
        reason: 'missing-option-frontier'
      })
      const first = await replay.stage(cleanCode, {
        stage_restore: { input_path: clean.input_path, expected_output_path: clean.output_path }
      })
      expect(first.stageComparison?.outcome).toBe('equal')
      const second = await replay.stage(modelCode, {
        stage_expected_output_path: model.output_path
      })
      expect(second.stageComparison, JSON.stringify(second)).toEqual({ outcome: 'equal' })
      // Same literal option dependencies, changed selected write: comparison detects the
      // change, and the later reader must observe 2 instead of historical input 1.
      const changed = await replay.stage('options(stage_custom = 2); NULL', {
        stage_restore: { input_path: writer.input_path, expected_output_path: writer.output_path }
      })
      expect(changed.stageComparison?.outcome).toBe('different')
      const retained = await replay.stage(readerCode, {
        stage_expected_output_path: reader.output_path
      })
      expect(retained.stageComparison?.outcome).toBe('different')
      expect((await replay.send('cat(result, getOption("stage_custom"))')).stdout).toBe('2 2')
      execFileSync(rscriptBin(), [
        '--vanilla',
        '-e',
        [
          `input <- readRDS(${JSON.stringify(clean.input_path)}); input$options$proof <- NULL; saveRDS(input, ${JSON.stringify(clean.input_path)})`,
          `output <- readRDS(${JSON.stringify(model.output_path)}); output$context_proof <- NULL; saveRDS(output, ${JSON.stringify(model.output_path)})`
        ].join('\n')
      ])
      const legacy = await replay.stage(cleanCode, {
        stage_restore: { input_path: clean.input_path, expected_output_path: clean.output_path }
      })
      expect(legacy.executionStarted).toBe(false)
      expect(legacy.stageComparison?.outcome).toBe('unavailable')
      const legacyOutput = await replay.stage(modelCode, {
        stage_expected_output_path: model.output_path
      })
      expect(legacyOutput.stageComparison).toEqual({
        outcome: 'unavailable',
        reason: 'unsupported-expected-output-format'
      })
    } finally {
      original.child.stdin.end()
      replay.child.stdin.end()
      await Promise.all([once(original.child, 'exit'), once(replay.child, 'exit')])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses unreviewed parallel DESeq option branches before execution', () => {
    const output = execFileSync(
      rscriptBin(),
      [
        '--vanilla',
        '-e',
        [
          `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
          'owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
          'namespace_state <- new.env(parent = emptyenv()); capture_r_random_state <- function() NULL; eval(owner)',
          'plan <- get("plan", environment(stage_checkpoint_owner$begin))',
          `codes <- c(${[
            'DESeq2::DESeq(dds, fitType = "mean", parallel = TRUE)',
            'DESeq2::DESeq(dds, parallel = TRUE)',
            'DESeq2::DESeq(dds, fitType = "glmGamPoi")',
            'DESeq2::DESeq(dds, fitType = customFit)',
            'DESeq2::DESeq(dds, "Wald", fitType = "mean", TRUE)',
            'DESeq2::results(dds, parallel = TRUE)',
            'DESeq2::DESeq(dds, fitType = "mean", p = TRUE)',
            'DESeq2::results(dds, p = TRUE)'
          ]
            .map((code) => JSON.stringify(code))
            .join(', ')})`,
          'for (code in codes) stopifnot(identical(tryCatch(plan(parse(text = code), "dds"), error = conditionMessage), "unreviewed-deseq-option-branch"))',
          'cat("serial-contract")'
        ].join('\n')
      ],
      { encoding: 'utf8' }
    )
    expect(output).toBe('serial-contract')
  })

  it('encodes only the exact package constant method handler as base option metadata', () => {
    const output = execFileSync(
      rscriptBin(),
      [
        '--vanilla',
        '-e',
        [
          `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
          'owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
          'namespace_state <- new.env(parent = emptyenv()); capture_r_random_state <- function() NULL; eval(owner)',
          'env <- environment(stage_checkpoint_owner$begin); before <- loadedNamespaces()',
          'handler <- function(cond) NULL; environment(handler) <- emptyenv(); options(ambiguousMethodSelection = handler)',
          'value <- env$snapshot_options("ambiguousMethodSelection")',
          'stopifnot(identical(value$handlers, "ambiguousMethodSelection"), is.null(value$values$ambiguousMethodSelection))',
          'options(ambiguousMethodSelection = NULL); env$apply_options(value)',
          'stopifnot(env$is_empty_method_handler(getOption("ambiguousMethodSelection")), identical(loadedNamespaces(), before))',
          'options(ambiguousMethodSelection = function(cond) stop("must not call"))',
          'stopifnot(identical(tryCatch(env$snapshot_options("ambiguousMethodSelection"), error = conditionMessage), "unsupported-object-closure"))',
          'cat("constant-handler")'
        ].join('\n')
      ],
      { encoding: 'utf8' }
    )
    expect(output).toBe('constant-handler')
  })

  it('accepts only the empty S4 prototype callback and rejects hidden closure state', () => {
    // Exercise the production graph validator directly: creating custom class methods
    // in a live loop would correctly taint the separate package-state proof first.
    const result = execFileSync(
      rscriptBin(),
      [
        '--vanilla',
        '-e',
        [
          `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
          'owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
          'namespace_state <- new.env(parent = emptyenv())',
          'capture_r_random_state <- function() list(state = "available", kinds = as.list(RNGkind()), seed = as.list(.Random.seed))',
          'eval(owner)',
          'validate <- get("validate", environment(stage_checkpoint_owner$begin))',
          'methods::setClass("StageCheckpointClosureFixture", slots = c(callback = "function"))',
          'global_value <- 7',
          'check <- function(callback) tryCatch({ validate(list(methods::new("StageCheckpointClosureFixture", callback = callback))); "accepted" }, error = conditionMessage)',
          'cat(check(function() NULL), "\n", sep = "")',
          'cat(check(function() global_value), "\n", sep = "")',
          'cat(check(function(x = global_value) NULL), "\n", sep = "")',
          'callback <- function() NULL',
          'environment(callback) <- baseenv()',
          'attr(callback, "pointer") <- methods::new("externalptr")',
          'cat(check(callback), "\n", sep = "")',
          'set.seed(42)',
          'snapshot <- get("output_snapshot", environment(stage_checkpoint_owner$begin))',
          'before_options <- options(); before_seed <- .Random.seed; before_namespaces <- loadedNamespaces()',
          'value <- snapshot(list(x = 1), list(value = NULL, visible = TRUE))',
          'stopifnot(is.raw(value$comparison), identical(options(), before_options), identical(.Random.seed, before_seed), identical(loadedNamespaces(), before_namespaces))',
          'cat("context-preserved\n")'
        ].join('\n')
      ],
      { encoding: 'utf8' }
    )
    expect(result.trim().split('\n')).toEqual([
      'accepted',
      'global-closure-environment',
      'global-closure-environment',
      'unsupported-object-reference',
      'context-preserved'
    ])
  })

  const checkpointResponse = (
    response: KernelLoopResponse
  ): {
    stageCheckpointCapture?: {
      state: string
      reason?: string
      inputNames?: string[]
      outputNames?: string[]
    }
    stageComparison?: { outcome: string }
  } =>
    response as KernelLoopResponse & {
      stageCheckpointCapture?: {
        state: string
        reason?: string
        inputNames?: string[]
        outputNames?: string[]
      }
      stageComparison?: { outcome: string }
    }

  it('captures old RHS bindings before writes and restores only the selected cell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-checkpoint-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    const code = 'scratch <- 2; x <- x + scratch; answer <- list(x, x); nullable <- NULL'
    try {
      await loop.send('x <- 3; unrelated <- new.env(); upstream_count <- 1')
      const captured = checkpointResponse(await loop.stage(code, { stage_checkpoint: checkpoint }))
      expect(captured.stageCheckpointCapture).toMatchObject({
        state: 'available',
        inputNames: ['x'],
        outputNames: ['answer', 'nullable', 'scratch', 'x']
      })
      await loop.send('x <- 100; upstream_count <- 99')
      const restored = await loop.stage(code, {
        stage_restore: {
          input_path: checkpoint.input_path,
          expected_output_path: checkpoint.output_path
        }
      })
      expect(restored.error).toBeNull()
      expect(checkpointResponse(restored).stageComparison?.outcome).toBe('equal')
      expect((await loop.send('cat(x, upstream_count)')).stdout).toBe('5 99')
      const changed = await loop.stage(
        'scratch <- 2; x <- x + scratch + 1; answer <- list(x, x); nullable <- NULL',
        {
          stage_restore: {
            input_path: checkpoint.input_path,
            expected_output_path: checkpoint.output_path
          }
        }
      )
      expect(checkpointResponse(changed).stageComparison?.outcome).toBe('different')
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'ifelse sibling argument',
      code: 'y <- ifelse(FALSE, x <- 2, x); NULL',
      inputNames: ['x'],
      value: '1 1'
    },
    {
      label: 'ifelse later expression',
      code: 'ifelse(FALSE, x <- 2, 0); y <- x; NULL',
      inputNames: ['x'],
      value: '1 1'
    },
    {
      label: 'grouped lazy argument',
      code: 'y <- ifelse(FALSE, { x <- 2; x }, x); NULL',
      inputNames: ['x'],
      value: '1 1'
    },
    {
      label: 'short-circuit and',
      code: 'FALSE && (x <- 2); y <- x; NULL',
      inputNames: ['x'],
      value: '1 1'
    },
    {
      label: 'short-circuit or',
      code: 'TRUE || (x <- 2); y <- x; NULL',
      inputNames: ['x'],
      value: '1 1'
    },
    {
      label: 'unused getOption default',
      code: 'getOption("digits", x <- 2); y <- x; NULL',
      inputNames: ['x'],
      value: '1 1'
    },
    {
      label: 'lazy call inside a sequential group',
      code: '{ ifelse(FALSE, x <- 2, 0); y <- x }; NULL',
      inputNames: ['x'],
      value: '1 1'
    },
    {
      label: 'top-level sequential assignment',
      code: 'x <- 2; y <- x; NULL',
      inputNames: [],
      value: '2 2'
    },
    {
      label: 'brace sequential assignment',
      code: '{ x <- 2; y <- x }; NULL',
      inputNames: [],
      value: '2 2'
    },
    {
      label: 'parenthesized assignment',
      code: '(x <- 2); y <- x; NULL',
      inputNames: [],
      value: '2 2'
    }
  ])(
    'preserves must-defined object inputs in a fresh loop: $label',
    async ({ code, inputNames, value }) => {
      const root = mkdtempSync(join(tmpdir(), 'r-stage-lazy-input-'))
      const original = startLoop(rscriptBin(), {}, root, true)
      const checkpoint = {
        input_path: join(root, 'input.rds'),
        output_path: join(root, 'output.rds')
      }
      try {
        expect((await original.send('x <- 1')).error).toBeNull()
        const captured = await original.stage(code, { stage_checkpoint: checkpoint })
        expect(captured.error).toBeNull()
        expect(
          checkpointResponse(captured).stageCheckpointCapture,
          JSON.stringify(captured)
        ).toMatchObject({
          state: 'available',
          inputNames,
          outputNames: ['x', 'y']
        })
        expect((await original.send('cat(y, x)')).stdout).toBe(value)
        const isolated = startLoop(rscriptBin(), {}, root, true)
        try {
          // This process has no upstream x; the checkpoint must supply any old binding.
          const restored = await isolated.stage(code, {
            stage_restore: {
              input_path: checkpoint.input_path,
              expected_output_path: checkpoint.output_path
            }
          })
          expect(restored.error).toBeNull()
          expect(checkpointResponse(restored).stageComparison, JSON.stringify(restored)).toEqual({
            outcome: 'equal'
          })
          expect((await isolated.send('cat(y, x)')).stdout).toBe(value)
        } finally {
          isolated.child.stdin.end()
          await once(isolated.child, 'exit')
        }
      } finally {
        original.child.stdin.end()
        await once(original.child, 'exit')
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('keeps possible argument writes from certifying later callee aliases', () => {
    const output = execFileSync(
      rscriptBin(),
      [
        '--vanilla',
        '-e',
        [
          `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
          'owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
          'namespace_state <- new.env(parent = emptyenv()); capture_r_random_state <- function() NULL; eval(owner)',
          'plan <- get("plan", environment(stage_checkpoint_owner$begin))',
          `codes <- c(${[
            'ifelse(FALSE, sum <- 2, 0); sum(1)',
            'FALSE && (sum <- 2); sum(1)',
            'getOption("digits", sum <- 2); sum(1)'
          ]
            .map((code) => JSON.stringify(code))
            .join(', ')})`,
          'for (code in codes) stopifnot(identical(tryCatch(plan(parse(text = code), character()), error = conditionMessage), "user-function-dependency"))',
          'cat("possible-callee-writes-rejected")'
        ].join('\n')
      ],
      { encoding: 'utf8' }
    )
    expect(output).toBe('possible-callee-writes-rejected')
  })

  it('compares unassigned values and keeps new state between consecutive steps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-sequence-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    const first = {
      input_path: join(root, 'first-in.rds'),
      output_path: join(root, 'first-out.rds')
    }
    const second = {
      input_path: join(root, 'second-in.rds'),
      output_path: join(root, 'second-out.rds')
    }
    const visible = {
      input_path: join(root, 'value-in.rds'),
      output_path: join(root, 'value-out.rds')
    }
    try {
      await loop.send('x <- 3')
      expect(
        checkpointResponse(await loop.stage('a <- x + 1', { stage_checkpoint: first }))
          .stageCheckpointCapture?.state
      ).toBe('available')
      expect(
        checkpointResponse(await loop.stage('b <- a * 2', { stage_checkpoint: second }))
          .stageCheckpointCapture?.state
      ).toBe('available')
      expect(
        checkpointResponse(await loop.stage('sum(b)', { stage_checkpoint: visible }))
          .stageCheckpointCapture?.state
      ).toBe('available')
      expect(
        checkpointResponse(
          await loop.stage('a <- x + 2', {
            stage_restore: {
              input_path: first.input_path,
              expected_output_path: first.output_path
            }
          })
        ).stageComparison?.outcome
      ).toBe('different')
      expect(
        checkpointResponse(
          await loop.stage('b <- a * 2', {
            stage_expected_output_path: second.output_path
          })
        ).stageComparison?.outcome
      ).toBe('different')
      expect((await loop.send('cat(a, b)')).stdout).toBe('5 10')
      expect(
        checkpointResponse(
          await loop.stage('sum(b) + 1', {
            stage_restore: {
              input_path: visible.input_path,
              expected_output_path: visible.output_path
            }
          })
        ).stageComparison?.outcome
      ).toBe('different')
      expect(
        checkpointResponse(
          await loop.stage('sum(b)', {
            stage_restore: {
              input_path: visible.input_path,
              expected_output_path: visible.output_path
            }
          })
        ).stageComparison?.outcome
      ).toBe('equal')
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores RNG, options and palette while preserving the exact original cell source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-context-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    const code =
      'draw <- runif(4); result <- list(draw, getOption("scipen"), getOption("contrasts"), palette())'
    try {
      await loop.send(
        'set.seed(42); options(scipen = 17, contrasts = c("contr.sum", "contr.poly")); palette(c("red", "blue"))'
      )
      const captured = await loop.stage(code, { stage_checkpoint: checkpoint })
      expect(checkpointResponse(captured).stageCheckpointCapture?.state).toBe('available')
      await loop.send(
        'set.seed(999); options(scipen = 0, contrasts = c("contr.treatment", "contr.poly")); palette("default")'
      )
      const restored = await loop.stage(code, {
        stage_restore: {
          input_path: checkpoint.input_path,
          expected_output_path: checkpoint.output_path
        }
      })
      expect(restored.error).toBeNull()
      expect(checkpointResponse(restored).stageComparison?.outcome).toBe('equal')
      expect(restored.environmentOverlay?.executionContext?.before?.rRandomState).toEqual(
        captured.environmentOverlay?.executionContext?.before?.rRandomState
      )
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('captures a literal package attachment followed by new functions in the same cell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-package-'))
    const original = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    const code = 'library(IRanges); interval <- IRanges(start = seq_len(3), width = 2)'
    try {
      const captured = await original.stage(code, { stage_checkpoint: checkpoint })
      expect(captured.error).toBeNull()
      expect(checkpointResponse(captured).stageCheckpointCapture).toMatchObject({
        state: 'available',
        inputNames: []
      })
      expect(
        (await original.send('cat(exists("declared_package", inherits = FALSE))')).stdout
      ).toBe('FALSE')
      const isolated = startLoop(rscriptBin(), {}, root, true)
      try {
        const restored = await isolated.stage(code, {
          stage_restore: {
            input_path: checkpoint.input_path,
            expected_output_path: checkpoint.output_path
          }
        })
        expect(restored.error).toBeNull()
        expect(checkpointResponse(restored).stageComparison?.outcome).toBe('equal')
      } finally {
        isolated.child.stdin.end()
        await once(isolated.child, 'exit')
      }
    } finally {
      original.child.stdin.end()
      await once(original.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects user devices left open after the kernel capture device closes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-devices-'))
    const figures = join(root, 'figures')
    mkdirSync(figures)
    const loop = startLoop(rscriptBin(), { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures }, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    try {
      expect(
        checkpointResponse(await loop.stage('x <- 1', { stage_checkpoint: checkpoint }))
          .stageCheckpointCapture?.state
      ).toBe('available')
      const result = await loop.stage('dev.off(); pdf("user.pdf"); x <- 2', {
        stage_checkpoint: checkpoint
      })
      expect(result.error).toBeNull()
      expect(checkpointResponse(result).stageCheckpointCapture).toEqual({
        state: 'unavailable',
        reason: 'open-user-graphics-device'
      })
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    'base::Sys.setenv(OPEN_SCIENCE_STAGE_TEST = "changed")',
    'grDevices::pdf.options(width = 11)',
    'splines::ns(seq_len(12), df = 3)',
    'if (FALSE) ggplot2::theme_set(NULL)',
    'if (FALSE) circlize::circos.par(gap.degree = 5)',
    'if (FALSE) BiocParallel::register(NULL)'
  ])('rejects unsupported package state in this cell and later checkpoints: %s', async (code) => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-package-state-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    try {
      const changed = await loop.stage(code, { stage_checkpoint: checkpoint })
      expect(changed.error).toBeNull()
      expect(checkpointResponse(changed).stageCheckpointCapture?.state).toBe('unavailable')
      const later = await loop.stage('x <- 1', { stage_checkpoint: checkpoint })
      expect(later.error).toBeNull()
      expect(checkpointResponse(later).stageCheckpointCapture).toEqual({
        state: 'unavailable',
        reason: expect.stringMatching(/^unsupported-method-history:/)
      })
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['x <- get("old")', 'old <- 1'],
    ['x <- old()', 'old <- function() 1'],
    ['x <- old', 'old <- new.env()'],
    ['x <- 1', 'print.custom <- function(x, ...) cat("hidden method")'],
    ['x <- 1', 'base::registerS3method("print", "custom", function(x, ...) NULL)'],
    ['x <- getOption("error")', 'options(error = function() NULL)'],
    ['x <- old', 'old <- methods::new("externalptr")'],
    ['x <- old', 'old <- function() 1'],
    ['x <- old', 'dependency <- 1; old <- ~ dependency'],
    ['x <- old', 'makeActiveBinding("old", function() stop("must not force"), .GlobalEnv)'],
    ['x <- old', 'delayedAssign("old", stop("must not force"))'],
    ['x <- old', 'old <- file("open.txt", "w")'],
    ['x <- 1', 'pdf("open.pdf")']
  ])('marks unsupported state unavailable: %s / %s', async (code, setup) => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-unsupported-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    try {
      await loop.send(setup)
      const result = await loop.stage(code, {
        stage_checkpoint: {
          input_path: join(root, 'input.rds'),
          output_path: join(root, 'output.rds')
        }
      })
      expect(checkpointResponse(result).stageCheckpointCapture?.state).toBe('unavailable')
      const restore = await loop.stage('cat("must not execute")', {
        stage_restore: {
          input_path: join(root, 'missing.rds'),
          expected_output_path: join(root, 'output.rds')
        }
      })
      expect(restore.executionStarted).toBe(false)
      expect(restore.stdout).toBe('')
      expect(checkpointResponse(restore).stageComparison?.outcome).toBe('unavailable')
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supplements only missing roots while retaining current outputs and execution context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-supplement-'))
    const original = startLoop(rscriptBin(), {}, root, true)
    const entry = {
      input_path: join(root, 'entry-in.rds'),
      output_path: join(root, 'entry-out.rds')
    }
    const later = {
      input_path: join(root, 'later-in.rds'),
      output_path: join(root, 'later-out.rds')
    }
    const mutation = {
      input_path: join(root, 'mutation-in.rds'),
      output_path: join(root, 'mutation-out.rds')
    }
    const mutationCode =
      'resultTable$value <- 100; set.seed(999); options(scipen = 99); palette(c("red", "blue")); NULL'
    const laterCode = 'heat <- clean$value + resultTable$value'
    try {
      await original.send('x <- 2; clean <- data.frame(value = 5)')
      await original.stage('resultTable <- data.frame(value = x + 1)', { stage_checkpoint: entry })
      await original.stage(laterCode, { stage_checkpoint: later })
      const mutationCaptured = await original.stage(mutationCode, { stage_checkpoint: mutation })
      expect(mutationCaptured.stageCheckpointCapture?.state).toBe('available')
      const isolated = startLoop(rscriptBin(), {}, root, true)
      try {
        const first = await isolated.stage('resultTable <- data.frame(value = x + 1)', {
          stage_restore: {
            input_path: entry.input_path,
            expected_output_path: entry.output_path
          }
        })
        expect(checkpointResponse(first).stageComparison?.outcome).toBe('equal')
        const supplemented = await isolated.stage(laterCode, {
          stage_supplement: {
            input_path: later.input_path,
            expected_output_path: later.output_path,
            names: ['clean']
          }
        })
        expect(supplemented.error).toBeNull()
        expect(checkpointResponse(supplemented).stageComparison?.outcome).toBe('equal')
        await isolated.send('rm(clean)')
        const cleared = await isolated.stage(laterCode, {
          stage_supplement: {
            input_path: later.input_path,
            expected_output_path: later.output_path,
            names: ['clean']
          }
        })
        expect(cleared.executionStarted).toBe(false)
        expect(cleared.stageComparison).toEqual({
          outcome: 'unavailable',
          reason: 'missing-option-frontier'
        })
        const restarted = await isolated.stage('resultTable <- data.frame(value = x + 1)', {
          stage_restore: { input_path: entry.input_path, expected_output_path: entry.output_path }
        })
        expect(restarted.stageComparison?.outcome).toBe('equal')
        const currentContext = await isolated.stage(mutationCode, {
          stage_expected_output_path: mutation.output_path
        })
        expect(currentContext.error).toBeNull()
        expect(currentContext.stageComparison?.outcome).toBe('equal')
        const changed = await isolated.stage(laterCode, {
          stage_supplement: {
            input_path: later.input_path,
            expected_output_path: later.output_path,
            names: ['clean']
          }
        })
        expect(changed.error).toBeNull()
        expect(checkpointResponse(changed).stageComparison?.outcome).toBe('different')
        expect(changed.environmentOverlay?.executionContext?.before?.rRandomState).toEqual(
          currentContext.environmentOverlay?.executionContext?.after?.rRandomState
        )
        expect(
          (await isolated.send('cat(resultTable$value, heat, getOption("scipen"), palette()[1])'))
            .stdout
        ).toBe('100 105 99 red')
      } finally {
        isolated.child.stdin.end()
        await once(isolated.child, 'exit')
      }
    } finally {
      original.child.stdin.end()
      await once(original.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bounds private reference traversal and preserves cycles without merging equal environments', () => {
    const output = execFileSync(
      rscriptBin(),
      [
        '--vanilla',
        '-e',
        [
          `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
          'owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
          'namespace_state <- new.env(parent = emptyenv()); capture_r_random_state <- function() NULL; eval(owner)',
          'env <- environment(stage_checkpoint_owner$begin)',
          'e <- new.env(parent = baseenv()); f <- function() NULL; environment(f) <- e; e$self <- f',
          'other <- new.env(parent = baseenv()); g <- function() NULL; environment(g) <- other',
          'graph <- list(f, f, g, stats::dnorm); found <- env$collect_references(graph)',
          'stopifnot(length(found$values) == 2L, identical(found$values[[1]], e), identical(found$values[[2]], other))',
          'proof <- env$capture_reference_proof(graph); env$validate_reference_proof(proof)',
          'stopifnot(length(unique(proof$ids)) == 2L)',
          'mark <- list(count = length(env$capture_refs$values), bytes = env$capture_refs$bytes)',
          'fresh <- function() NULL; environment(fresh) <- new.env(parent = baseenv())',
          'failed_proof <- env$capture_reference_proof(list(fresh)); allocated <- env$capture_refs$next_id',
          'stopifnot(length(env$capture_refs$values) == 3L, env$capture_refs$bytes > mark$bytes)',
          'env$rollback_capture_references(mark)',
          'stopifnot(identical(env$capture_refs$ids, proof$ids), length(env$capture_refs$values) == mark$count, identical(env$capture_refs$bytes, mark$bytes), env$capture_refs$next_id == allocated)',
          'retry_proof <- env$capture_reference_proof(list(fresh))',
          'stopifnot(!identical(retry_proof$ids, failed_proof$ids), env$capture_refs$next_id == allocated + 1)',
          // An interrupt can abandon begin's state before the executor calls finish.
          'refs <- env$capture_refs; refs$pending <- mark',
          'stopifnot(is.null(env$begin(list(), expression(NULL))))',
          'stopifnot(is.null(refs$pending), identical(refs$ids, proof$ids), identical(refs$bytes, mark$bytes), refs$next_id == allocated + 1)',
          'captured_ids <- env$capture_refs$ids; captured_bytes <- env$capture_refs$bytes; captured_next <- env$capture_refs$next_id',
          'env$anchor_references(proof$ids, found$values, found$bytes)',
          'stopifnot(identical(tryCatch(env$anchor_references("different-id", list(e), 1), error = conditionMessage), "object-reference-identity-conflict"))',
          'env$reset_references(); env$replay_refs$ready <- TRUE',
          'input <- list(bindings = list(missing = graph), reference_values = found$values, references = proof)',
          'restored <- env$supplement_bindings(input, "missing")$missing',
          'stopifnot(identical(environment(restored[[1]]), environment(restored[[2]])), !identical(environment(restored[[1]]), environment(restored[[3]])))',
          'stopifnot(identical(environment(restored[[1]]), environment(environment(restored[[1]])$self)))',
          'stopifnot(identical(environment(restored[[4]]), asNamespace("stats")))',
          'stopifnot(identical(env$capture_refs$ids, captured_ids), identical(env$capture_refs$bytes, captured_bytes), env$capture_refs$next_id == captured_next)',
          'env$reset_references(); env$snapshot_budget_bytes <- 1',
          'stopifnot(identical(tryCatch(env$anchor_references("too-large", list(e), 2), error = conditionMessage), "object-reference-budget"), length(env$replay_refs$ids) == 0L)',
          'env$snapshot_budget_bytes <- 32 * 1024^2',
          'too_many <- lapply(seq_len(1025), function(i) { f <- function() NULL; environment(f) <- new.env(parent = baseenv()); f })',
          'stopifnot(identical(tryCatch(env$collect_references(too_many), error = conditionMessage), "object-reference-budget"))',
          'cat("bounded-reference-identities")'
        ].join('\n')
      ],
      { encoding: 'utf8' }
    )
    expect(output).toBe('bounded-reference-identities')
  })

  it.each(['cell-error', 'input-save', 'output-save', 'output-validation'] as const)(
    'rolls back failed capture reference admission: %s',
    async (failure) => {
      const root = mkdtempSync(join(tmpdir(), 'r-stage-reference-rollback-'))
      execFileSync(rscriptBin(), [
        '--vanilla',
        '-e',
        [
          'methods::setClass("StageQuotaBox", slots = c(callback = "function"))',
          'boxes <- lapply(seq_len(600), function(i) { f <- function() NULL; environment(f) <- new.env(parent = baseenv()); methods::new("StageQuotaBox", callback = f) })',
          'saveRDS(boxes, commandArgs(TRUE)[1]); saveRDS(list(function() NULL), commandArgs(TRUE)[2])'
        ].join('; '),
        join(root, 'many.rds'),
        join(root, 'invalid.rds')
      ])
      const loop = startLoop(rscriptBin(), {}, root, true)
      const checkpoint = (name: string): { input_path: string; output_path: string } => ({
        input_path: join(root, `${name}-in.rds`),
        output_path: join(root, `${name}-out.rds`)
      })
      try {
        if (failure === 'cell-error') {
          const setup = await loop.stage('obj <- readRDS("many.rds"); sqrt("bad"); NULL', {
            stage_checkpoint: checkpoint('setup')
          })
          expect(setup.error).toContain('non-numeric')
          expect(setup.stageCheckpointCapture).toEqual({
            state: 'unavailable',
            reason: 'cell-execution-failed'
          })
        } else if (failure !== 'output-save') {
          expect((await loop.send('obj <- readRDS("many.rds"); NULL')).error).toBeNull()
        }
        const failedPaths = checkpoint('failed')
        if (failure === 'input-save') failedPaths.input_path = join(root, 'missing', 'input.rds')
        if (failure === 'output-save') failedPaths.output_path = join(root, 'missing', 'output.rds')
        const code = {
          'cell-error': 'a <- obj; sqrt("bad"); NULL',
          'input-save': 'a <- obj; NULL',
          'output-save': 'obj <- readRDS("many.rds"); NULL',
          'output-validation': 'a <- obj; bad <- readRDS("invalid.rds"); NULL'
        }[failure]
        const failed = await loop.stage(code, { stage_checkpoint: failedPaths })
        expect(failed.stageCheckpointCapture?.state, JSON.stringify(failed)).toBe('unavailable')
        const reason =
          failed.stageCheckpointCapture?.state === 'unavailable'
            ? failed.stageCheckpointCapture.reason
            : undefined
        if (failure === 'cell-error') {
          expect(failed.error).toContain('non-numeric')
          expect(reason).toBe('cell-execution-failed')
        } else {
          expect(failed.error).toBeNull()
          expect(reason).toBe(
            failure === 'output-validation'
              ? 'unsupported-object-closure'
              : 'cannot open the connection'
          )
        }
        // A fresh 600-reference graph fits the 1024 admission limit only if the
        // unsuccessful capture's references were released in the same live kernel.
        const recoveredPaths = checkpoint('recovered')
        const recovered = await loop.stage('obj <- readRDS("many.rds"); NULL', {
          stage_checkpoint: recoveredPaths
        })
        expect(recovered.error).toBeNull()
        expect(recovered.stageCheckpointCapture?.state, JSON.stringify(recovered)).toBe('available')
        const ids = JSON.parse(
          execFileSync(
            rscriptBin(),
            [
              '--vanilla',
              '-e',
              'cat(jsonlite::toJSON(readRDS(commandArgs(TRUE)[1])$references$ids))',
              recoveredPaths.output_path
            ],
            { encoding: 'utf8' }
          )
        ) as string[]
        expect(ids.map((id) => Number(id.split(':').at(-1)))).toEqual(
          Array.from({ length: 600 }, (_, index) => index + 601)
        )
      } finally {
        loop.child.stdin.end()
        await once(loop.child, 'exit')
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('retains successful historical reference identities after a failed capture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-reference-history-'))
    execFileSync(rscriptBin(), [
      '--vanilla',
      '-e',
      [
        'methods::setClass("StageHistoryBox", slots = c(callback = "function"))',
        'f <- function() NULL; environment(f) <- new.env(parent = baseenv())',
        'saveRDS(methods::new("StageHistoryBox", callback = f), commandArgs(TRUE)[1])'
      ].join('; '),
      join(root, 'box.rds')
    ])
    const original = startLoop(rscriptBin(), {}, root, true)
    const isolated = startLoop(rscriptBin(), {}, root, true)
    const paths = (name: string): { input_path: string; output_path: string } => ({
      input_path: join(root, `${name}-in.rds`),
      output_path: join(root, `${name}-out.rds`)
    })
    const first = paths('first')
    const later = paths('later')
    const firstCode = 'a <- obj; NULL'
    const laterCode = 'z <- list(obj, a); NULL'
    try {
      expect((await original.send('obj <- readRDS("box.rds"); NULL')).error).toBeNull()
      expect(
        (await original.stage(firstCode, { stage_checkpoint: first })).stageCheckpointCapture?.state
      ).toBe('available')
      expect((await original.send('other <- readRDS("box.rds"); NULL')).error).toBeNull()
      const failed = await original.stage('b <- other; sqrt("bad"); NULL', {
        stage_checkpoint: paths('failed')
      })
      expect(failed.stageCheckpointCapture).toEqual({
        state: 'unavailable',
        reason: 'cell-execution-failed'
      })
      expect(
        (
          await original.stage('other <- readRDS("box.rds"); NULL', {
            stage_checkpoint: paths('independent')
          })
        ).stageCheckpointCapture?.state
      ).toBe('available')
      expect(
        (await original.stage(laterCode, { stage_checkpoint: later })).stageCheckpointCapture?.state
      ).toBe('available')
      const restored = await isolated.stage(firstCode, {
        stage_restore: { input_path: first.input_path, expected_output_path: first.output_path }
      })
      expect(restored.stageComparison?.outcome, JSON.stringify(restored)).toBe('equal')
      const historical = await isolated.stage(laterCode, {
        stage_expected_output_path: later.output_path
      })
      expect(historical.stageComparison?.outcome, JSON.stringify(historical)).toBe('equal')
      expect(
        (await isolated.send('cat(identical(environment(obj@callback), environment(a@callback)))'))
          .stdout
      ).toBe('TRUE')
    } finally {
      original.child.stdin.end()
      isolated.child.stdin.end()
      await Promise.all([once(original.child, 'exit'), once(isolated.child, 'exit')])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    'shared',
    'distinct',
    'created',
    'replaced',
    'current-write',
    'changed-created'
  ] as const)('preserves cross-stage private reference identities: %s', async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-reference-'))
    const fixture = join(root, 'box.rds')
    execFileSync(rscriptBin(), [
      '--vanilla',
      '-e',
      [
        'methods::setClass("StageAliasBox", slots = c(callback = "function", tag = "numeric"))',
        'f <- function() NULL; environment(f) <- new.env(parent = baseenv())',
        'saveRDS(methods::new("StageAliasBox", callback = f, tag = 1), commandArgs(TRUE)[1])'
      ].join('; '),
      fixture
    ])
    const original = startLoop(rscriptBin(), {}, root, true)
    const isolated = startLoop(rscriptBin(), {}, root, true)
    const entry = { input_path: join(root, 'a-in.rds'), output_path: join(root, 'a-out.rds') }
    const later = { input_path: join(root, 'b-in.rds'), output_path: join(root, 'b-out.rds') }
    const replacement = { input_path: join(root, 'c-in.rds'), output_path: join(root, 'c-out.rds') }
    const historical = { input_path: join(root, 'd-in.rds'), output_path: join(root, 'd-out.rds') }
    const replacementCode = `a <- readRDS(${JSON.stringify(fixture)}); NULL`
    const historicalCode = 'z2 <- list(obj, b); NULL'
    const created = scenario === 'created' || scenario === 'changed-created'
    const firstCode = created ? `a <- readRDS(${JSON.stringify(fixture)}); NULL` : 'a <- obj; NULL'
    const laterCode = 'z <- list(a, b); NULL'
    try {
      expect(
        (await original.send(`obj <- readRDS(${JSON.stringify(fixture)}); b <- obj; NULL`)).error
      ).toBeNull()
      const captured = await original.stage(firstCode, { stage_checkpoint: entry })
      expect(captured.stageCheckpointCapture?.state, JSON.stringify(captured)).toBe('available')
      if (scenario === 'replaced') {
        expect(
          (await original.stage(replacementCode, { stage_checkpoint: replacement }))
            .stageCheckpointCapture?.state
        ).toBe('available')
      }
      if (created) await original.send('b <- a; NULL')
      if (scenario === 'distinct') {
        await original.send(`b <- readRDS(${JSON.stringify(fixture)}); NULL`)
      }
      const capturedLater = await original.stage(laterCode, { stage_checkpoint: later })
      expect(capturedLater.stageCheckpointCapture?.state, JSON.stringify(capturedLater)).toBe(
        'available'
      )
      if (scenario === 'replaced') {
        expect(
          (await original.stage(historicalCode, { stage_checkpoint: historical }))
            .stageCheckpointCapture?.state
        ).toBe('available')
      }
      // These changed-source controls exercise the R owner directly. The host's source
      // checksum contract rejects edited code before a production restore request.
      const changed = scenario === 'current-write' || scenario === 'changed-created'
      const restored = await isolated.stage(
        changed ? `${firstCode}; a <- structure(a, tag = 99); NULL` : firstCode,
        {
          stage_restore: {
            input_path: entry.input_path,
            expected_output_path: entry.output_path
          }
        }
      )
      expect(restored.error, JSON.stringify(restored)).toBeNull()
      expect(restored.stageComparison?.outcome).toBe(changed ? 'different' : 'equal')
      if (scenario === 'replaced') {
        expect(
          (
            await isolated.stage(replacementCode, {
              stage_expected_output_path: replacement.output_path
            })
          ).stageComparison?.outcome
        ).toBe('equal')
      }
      const supplemented = await isolated.stage(laterCode, {
        stage_supplement: {
          input_path: later.input_path,
          expected_output_path: later.output_path,
          names: ['b']
        }
      })
      if (scenario === 'changed-created') {
        expect(supplemented.executionStarted).toBe(false)
        expect(supplemented.stageComparison).toEqual({
          outcome: 'unavailable',
          reason: 'unanchored-object-reference'
        })
        expect((await isolated.send('cat(a@tag, exists("b"))')).stdout).toBe('99 FALSE')
      } else {
        expect(supplemented.error, JSON.stringify(supplemented)).toBeNull()
        expect(supplemented.stageComparison?.outcome).toBe(changed ? 'different' : 'equal')
        if (scenario === 'replaced') {
          expect(
            (
              await isolated.stage(historicalCode, {
                stage_expected_output_path: historical.output_path
              })
            ).stageComparison?.outcome
          ).toBe('equal')
          expect(
            (
              await isolated.send(
                'cat(identical(environment(obj@callback), environment(b@callback)))'
              )
            ).stdout
          ).toBe('TRUE')
        }
        expect(
          (
            await isolated.send(
              'cat(identical(environment(a@callback), environment(b@callback)), a@tag, b@tag)'
            )
          ).stdout
        ).toBe(
          `${scenario === 'distinct' || scenario === 'replaced' ? 'FALSE' : 'TRUE'} ${changed ? 99 : 1} 1`
        )
      }
    } finally {
      original.child.stdin.end()
      isolated.child.stdin.end()
      await Promise.all([once(original.child, 'exit'), once(isolated.child, 'exit')])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['input-legacy', 'output-legacy', 'input-malformed', 'output-malformed'] as const)(
    'refuses legacy or malformed private reference proofs before executing: %s',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'r-stage-reference-proof-'))
      const original = startLoop(rscriptBin(), {}, root, true)
      const isolated = startLoop(rscriptBin(), {}, root, true)
      const checkpoint = {
        input_path: join(root, 'input.rds'),
        output_path: join(root, 'output.rds')
      }
      try {
        await original.send('x <- 1')
        const captured = await original.stage('y <- x; NULL', { stage_checkpoint: checkpoint })
        expect(captured.stageCheckpointCapture?.state).toBe('available')
        const path = scenario.startsWith('input') ? checkpoint.input_path : checkpoint.output_path
        const change = scenario.endsWith('legacy')
          ? `value$schema <- ${scenario.startsWith('input') ? 1 : 2}L`
          : 'value$references$ids <- c("duplicate", "duplicate")'
        execFileSync(rscriptBin(), [
          '--vanilla',
          '-e',
          `path <- commandArgs(TRUE)[1]; value <- readRDS(path); ${change}; saveRDS(value, path)`,
          path
        ])
        const rejected = await isolated.stage('y <- x; NULL', {
          stage_restore: {
            input_path: checkpoint.input_path,
            expected_output_path: checkpoint.output_path
          }
        })
        expect(rejected.executionStarted).toBe(false)
        expect(rejected.stageComparison).toEqual({
          outcome: 'unavailable',
          reason: scenario.endsWith('malformed')
            ? 'invalid-object-reference-proof'
            : scenario.startsWith('input')
              ? 'invalid-checkpoint-envelope'
              : 'unsupported-expected-output-format'
        })
        expect((await isolated.send('cat(exists("y"))')).stdout).toBe('FALSE')
      } finally {
        original.child.stdin.end()
        isolated.child.stdin.end()
        await Promise.all([once(original.child, 'exit'), once(isolated.child, 'exit')])
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each([
    [[], 'invalid-supplement-names'],
    [['unknown'], 'unknown-supplement-binding'],
    [['clean', 'clean'], 'invalid-supplement-names'],
    [['resultTable'], 'existing-supplement-binding']
  ])('rejects invalid or existing supplementary roots: %j', async (names, reason) => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-supplement-invalid-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    const code = 'answer <- clean$value + resultTable$value'
    try {
      await loop.send('clean <- data.frame(value = 5); resultTable <- data.frame(value = 3)')
      await loop.stage(code, { stage_checkpoint: checkpoint })
      await loop.send('rm(clean); resultTable$value <- 100')
      const rejected = await loop.stage(code, {
        stage_supplement: {
          input_path: checkpoint.input_path,
          expected_output_path: checkpoint.output_path,
          names
        }
      })
      expect(rejected.executionStarted).toBe(false)
      expect(checkpointResponse(rejected).stageComparison).toEqual({
        outcome: 'unavailable',
        reason
      })
      expect(
        (
          await loop.send(
            'cat(resultTable$value, exists("clean", envir = .GlobalEnv, inherits = FALSE))'
          )
        ).stdout
      ).toBe('100 FALSE')
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports legacy or malformed expected output as unavailable instead of matching it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-output-format-'))
    const loop = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    try {
      const captured = await loop.stage('x <- 1', { stage_checkpoint: checkpoint })
      expect(checkpointResponse(captured).stageCheckpointCapture?.state).toBe('available')
      const restored = await loop.stage('x <- 1', {
        stage_restore: {
          input_path: checkpoint.input_path,
          expected_output_path: checkpoint.input_path
        }
      })
      expect(restored.error).toBe('Stage restoration failed: unsupported-expected-output-format')
      expect(restored.executionStarted).toBe(false)
      expect(restored.stdout).toBe('')
      expect(checkpointResponse(restored).stageComparison).toEqual({
        outcome: 'unavailable',
        reason: 'unsupported-expected-output-format'
      })
    } finally {
      loop.child.stdin.end()
      await once(loop.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps expected-output inspection from preloading package callbacks or changing later context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-expected-isolation-'))
    const original = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    const code = 'library(DESeq2); NULL'
    try {
      const captured = await original.stage(code, { stage_checkpoint: checkpoint })
      expect(captured.error).toBeNull()
      expect(
        checkpointResponse(captured).stageCheckpointCapture,
        JSON.stringify(captured)
      ).toMatchObject({ state: 'available' })
      const outputShape = execFileSync(
        rscriptBin(),
        [
          '--vanilla',
          '-e',
          [
            'before <- loadedNamespaces()',
            `value <- readRDS(${JSON.stringify(checkpoint.output_path)})`,
            'stopifnot(identical(value$schema, 3L), is.raw(value$comparison), identical(loadedNamespaces(), before))',
            'cat("raw expected envelope does not load namespaces")'
          ].join('\n')
        ],
        { encoding: 'utf8' }
      )
      expect(outputShape).toBe('raw expected envelope does not load namespaces')
      const isolated = startLoop(rscriptBin(), {}, root, true)
      try {
        const restored = await isolated.stage(code, {
          stage_restore: {
            input_path: checkpoint.input_path,
            expected_output_path: checkpoint.output_path
          }
        })
        expect(restored.error).toBeNull()
        expect(checkpointResponse(restored).stageComparison, JSON.stringify(restored)).toEqual({
          outcome: 'equal'
        })
        const unchanged = await isolated.stage(code, {
          stage_expected_output_path: checkpoint.output_path
        })
        expect(unchanged.error).toBeNull()
        expect(checkpointResponse(unchanged).stageComparison, JSON.stringify(unchanged)).toEqual({
          outcome: 'equal'
        })
      } finally {
        isolated.child.stdin.end()
        await once(isolated.child, 'exit')
      }
    } finally {
      original.child.stdin.end()
      await once(original.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('keeps DESeqDataSet design columns isolated from same-named global factors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-design-mask-'))
    const original = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    const code =
      'dds <- DESeqDataSetFromMatrix(countData = clean, colData = samples, design = ~ condition); NULL'
    try {
      const setup = await original.send(
        [
          'library(DESeq2)',
          'condition <- factor(rep(c("control", "treated"), each = 3))',
          'clean <- matrix(seq_len(60), ncol = 6)',
          'samples <- DataFrame(condition)'
        ].join('\n')
      )
      expect(setup.error).toBeNull()
      const captured = await original.stage(code, { stage_checkpoint: checkpoint })
      expect(
        checkpointResponse(captured).stageCheckpointCapture,
        JSON.stringify(captured)
      ).toMatchObject({ state: 'available', inputNames: ['clean', 'samples', 'condition'] })
      const isolated = startLoop(rscriptBin(), {}, root, true)
      try {
        const restored = await isolated.stage(code, {
          stage_restore: {
            input_path: checkpoint.input_path,
            expected_output_path: checkpoint.output_path
          }
        })
        expect(restored.error).toBeNull()
        expect(checkpointResponse(restored).stageComparison?.outcome).toBe('equal')
        expect(
          (
            await isolated.send(
              'cat(identical(as.character(colData(dds)$condition), as.character(condition)))'
            )
          ).stdout
        ).toBe('TRUE')
      } finally {
        isolated.child.stdin.end()
        await once(isolated.child, 'exit')
      }
    } finally {
      original.child.stdin.end()
      await once(original.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it.each(['local', 'parametric'] as const)(
    'captures default DESeq with its %s fit and reproduces original live statistics in fresh R',
    async (fitType) => {
      const root = mkdtempSync(join(tmpdir(), 'r-stage-default-deseq-'))
      const paths = (name: string): { input_path: string; output_path: string } => ({
        input_path: join(root, `${name}-input.rds`),
        output_path: join(root, `${name}-output.rds`)
      })
      const fit = paths('fit')
      const results = paths('results')
      const fitCode = 'dds <- DESeq2::DESeq(dds, quiet = TRUE); NULL'
      const resultCode = 'result <- as.data.frame(DESeq2::results(dds)); NULL'
      const arithmetic = Array.from({ length: 1000 }, (_, index) => {
        const gene = index + 1
        const mean = 25 + ((gene * 97) % 1476)
        return Array.from({ length: 8 }, (_, sample) => {
          const effect = sample < 4 ? 1 : gene <= 100 ? 4 : gene <= 200 ? 0.25 : 1
          return Math.floor(
            mean *
              effect *
              (0.6 + ((gene * 193 + sample * 379 + gene * sample * 53) % 801) / 1000) +
              0.5
          )
        })
      })
      writeFileSync(join(root, 'counts.csv'), arithmetic.map((row) => row.join(',')).join('\n'))
      const setup = [
        'suppressPackageStartupMessages(library(DESeq2))',
        'set.seed(42)',
        fitType === 'local'
          ? 'counts <- as.matrix(utils::read.csv("counts.csv", header = FALSE))'
          : 'mu <- 2^rnorm(1000, 4, 2); counts <- matrix(rnbinom(6000, mu = mu, size = 1/(4/mu + 0.1)), nrow = 1000)',
        'rownames(counts) <- paste0("gene", seq_len(nrow(counts)))',
        'colnames(counts) <- paste0("sample", seq_len(ncol(counts)))',
        'samples <- data.frame(condition = factor(rep(c("control", "treated"), each = ncol(counts)/2)), row.names = colnames(counts))',
        'dds <- DESeq2::DESeqDataSetFromMatrix(counts, samples, ~ condition)',
        'NULL'
      ].join('\n')
      const dump = (name: string, includeResult = false): string =>
        `base::saveRDS(list(dds = dds, random = .Random.seed${includeResult ? ', result = result' : ''}), ${JSON.stringify(join(root, `${name}.rds`))}); NULL`
      const original = startLoop(rscriptBin(), {}, root, true)
      const replays: ReturnType<typeof startLoop>[] = []
      try {
        // A direct upstream R execution is independent of the checkpoint codec.
        execFileSync(
          rscriptBin(),
          ['--vanilla', '-e', [setup, fitCode, resultCode, dump('baseline', true)].join('\n')],
          { cwd: root }
        )
        expect((await original.send(setup)).error).toBeNull()
        const fitted = await original.stage(fitCode, { stage_checkpoint: fit })
        expect(fitted.error).toBeNull()
        expect(fitted.stageCheckpointCapture, JSON.stringify(fitted)).toMatchObject({
          state: 'available'
        })
        expect((await original.send(dump('before'))).error).toBeNull()
        const captured = await original.stage(resultCode, { stage_checkpoint: results })
        expect(captured.error).toBeNull()
        expect(captured.stageCheckpointCapture, JSON.stringify(captured)).toMatchObject({
          state: 'available'
        })
        expect((await original.send(dump('original', true))).error).toBeNull()
        for (const [name, code, checkpoint] of [
          ['replay-fit', fitCode, fit],
          ['replay-results', resultCode, results]
        ] as const) {
          const replay = startLoop(rscriptBin(), {}, root, true)
          replays.push(replay)
          const restored = await replay.stage(code, {
            stage_restore: {
              input_path: checkpoint.input_path,
              expected_output_path: checkpoint.output_path
            }
          })
          expect(restored.error, JSON.stringify(restored)).toBeNull()
          expect(restored.stageComparison, JSON.stringify(restored)).toEqual({ outcome: 'equal' })
          // Diagnostics run after certification, so their dynamic inspection does not
          // become an input to the history proof under test.
          if (name === 'replay-fit') expect((await replay.send(resultCode)).error).toBeNull()
          expect((await replay.send(dump(name, true))).error).toBeNull()
        }
        const checked = execFileSync(
          rscriptBin(),
          [
            '--vanilla',
            '-e',
            [
              'suppressPackageStartupMessages(library(DESeq2))',
              'baseline <- readRDS("baseline.rds"); before <- readRDS("before.rds"); original <- readRDS("original.rds")',
              'stopifnot(identical(serialize(before, NULL), serialize(original[c("dds", "random")], NULL)))',
              `stopifnot(identical(attr(dispersionFunction(baseline$dds), "fitType"), ${JSON.stringify(fitType)}))`,
              'for (name in c("original", "replay-fit", "replay-results")) {',
              'current <- readRDS(paste0(name, ".rds"))',
              'stopifnot(identical(current$result, baseline$result), identical(current$random, baseline$random))',
              'stopifnot(identical(counts(current$dds), counts(baseline$dds)), identical(sizeFactors(current$dds), sizeFactors(baseline$dds)), identical(dispersions(current$dds), dispersions(baseline$dds)))',
              'unseen <- c(0.125, 3.75, 17.25, 125.5, 2345.75, 99999)',
              'stopifnot(identical(dispersionFunction(current$dds)(unseen), dispersionFunction(baseline$dds)(unseen)))',
              '}',
              `nodes <- as.list(parse(file = ${JSON.stringify(LOOP)}))`,
              'owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("stage_checkpoint_owner")), nodes)[[1L]]',
              'namespace_state <- new.env(parent = emptyenv()); namespace_state$lazy_names <- character(); namespace_state$written_names <- character()',
              'rng_owner <- Filter(function(node) is.call(node) && identical(node[[1L]], as.name("<-")) && identical(node[[2L]], as.name("capture_r_random_state")), nodes)[[1L]]; eval(rng_owner)',
              'environment(capture_r_random_state) <- list2env(list(namespace_state = namespace_state), parent = baseenv()); eval(owner)',
              '.Random.seed <- baseline$random',
              'codec <- get("project_values", environment(stage_checkpoint_owner$begin))',
              'raw <- serialize(baseline$dds, NULL); rng <- .Random.seed; opts <- options(); namespaces <- loadedNamespaces()',
              'copy <- codec(list(baseline$dds))',
              'stopifnot(identical(raw, serialize(baseline$dds, NULL)), identical(rng, .Random.seed), identical(opts, options()), identical(namespaces, loadedNamespaces()))',
              'stopifnot(identical(environment(attr(copy[[1]], "dispersionFunction")), environment(attr(codec(copy)[[1]], "dispersionFunction"))))',
              'validator <- get("validate", environment(stage_checkpoint_owner$begin))',
              'bad <- copy; f <- attr(bad[[1]], "dispersionFunction"); badenv <- new.env(parent = parent.env(environment(f)))',
              'for (key in ls(environment(f), all.names = TRUE)) assign(key, get(key, environment(f)), badenv)',
              'badenv$hidden <- 1; environment(f) <- badenv; attr(bad[[1]], "dispersionFunction") <- f',
              'stopifnot(identical(tryCatch(codec(bad), error = conditionMessage), "unreviewed-dispersion-frame"))',
              'badenv$hidden <- NULL; rm("hidden", envir = badenv); delayedAssign("hidden", stop("must not force"), assign.env = badenv)',
              'stopifnot(identical(tryCatch(codec(bad), error = conditionMessage), "lazy-object-binding"))',
              'rm("hidden", envir = badenv); makeActiveBinding("hidden", function() stop("must not evaluate"), badenv)',
              'stopifnot(identical(tryCatch(codec(bad), error = conditionMessage), "active-object-binding"))',
              'bad <- copy; f <- attr(bad[[1]], "dispersionFunction"); body(f) <- quote(stop("must not execute")); attr(bad[[1]], "dispersionFunction") <- f',
              'stopifnot(identical(tryCatch({ validator(codec(bad)); "accepted" }, error = conditionMessage), "unreviewed-dispersion-closure"))',
              'if (identical(attr(dispersionFunction(baseline$dds), "fitType"), "local")) {',
              'bad <- copy; f <- attr(bad[[1]], "dispersionFunction"); badenv <- new.env(parent = parent.env(environment(f))); fit <- get("fit", environment(f))',
              'fit$call$basis <- quote(stop("must not execute")); fit$frame <- badenv; attr(fit$terms, ".Environment") <- badenv; badenv$fit <- fit',
              'environment(f) <- badenv; attr(bad[[1]], "dispersionFunction") <- f',
              'stopifnot(identical(tryCatch(codec(bad), error = conditionMessage), "unreviewed-local-dispersion-fit"))',
              '}',
              'owner_env <- environment(stage_checkpoint_owner$begin); owner_env$R.version <- list(major = "4", minor = "6.0")',
              'stopifnot(identical(tryCatch(owner_env$call_options("DESeq", list()), error = conditionMessage), "unreviewed-option-runtime"))',
              'cat("original-statistics-and-passive-codec")'
            ].join('\n')
          ],
          { cwd: root, encoding: 'utf8' }
        )
        expect(checked).toBe('original-statistics-and-passive-codec')
      } finally {
        original.child.stdin.end()
        for (const replay of replays) replay.child.stdin.end()
        await Promise.all([
          once(original.child, 'exit'),
          ...replays.map((replay) => once(replay.child, 'exit'))
        ])
        rmSync(root, { recursive: true, force: true })
      }
    },
    120_000
  )

  it('restores a fitted DESeqDataSet in a fresh loop and compares results without upstream runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-stage-deseq-'))
    const original = startLoop(rscriptBin(), {}, root, true)
    const checkpoint = {
      input_path: join(root, 'input.rds'),
      output_path: join(root, 'output.rds')
    }
    const code =
      'result <- as.data.frame(DESeq2::results(dds, contrast = c("condition", "treated", "control")))'
    try {
      const setup = await original.send(
        [
          'suppressPackageStartupMessages(library(DESeq2))',
          'set.seed(42)',
          'counts <- matrix(rnbinom(1000 * 6, mu = 100, size = 10), nrow = 1000)',
          'rownames(counts) <- paste0("gene", seq_len(nrow(counts)))',
          'colnames(counts) <- paste0("sample", seq_len(ncol(counts)))',
          'samples <- data.frame(condition = factor(rep(c("control", "treated"), each = 3)), row.names = colnames(counts))',
          'dds <- DESeqDataSetFromMatrix(counts, samples, ~ condition)',
          'dds <- DESeq(dds, fitType = "mean", quiet = TRUE)'
        ].join('\n')
      )
      expect(setup.error).toBeNull()
      const captured = await original.stage(code, { stage_checkpoint: checkpoint })
      expect(captured.error).toBeNull()
      expect(
        checkpointResponse(captured).stageCheckpointCapture?.state,
        JSON.stringify(checkpointResponse(captured).stageCheckpointCapture)
      ).toBe('available')
      expect(checkpointResponse(captured).stageCheckpointCapture).toMatchObject({
        state: 'available',
        inputNames: ['dds']
      })
      const isolated = startLoop(rscriptBin(), {}, root, true)
      try {
        const restored = await isolated.stage(code, {
          stage_restore: {
            input_path: checkpoint.input_path,
            expected_output_path: checkpoint.output_path
          }
        })
        expect(restored.error).toBeNull()
        expect(checkpointResponse(restored).stageComparison?.outcome).toBe('equal')
        expect(
          (
            await isolated.send(
              'cat(exists("counts", envir = .GlobalEnv, inherits = FALSE), exists("samples", envir = .GlobalEnv, inherits = FALSE))'
            )
          ).stdout
        ).toBe('FALSE FALSE')
      } finally {
        isolated.child.stdin.end()
        await once(isolated.child, 'exit')
      }
    } finally {
      original.child.stdin.end()
      await once(original.child, 'exit')
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})

gate('r_loop.R', () => {
  it.each([
    [false, false],
    [true, false],
    [true, true]
  ])(
    'attests only the first request of an uncustomized vanilla session (vanilla: %s, custom defaults: %s)',
    async (vanilla, customDefaults) => {
      const { child, send } = startLoop(
        rscriptBin(),
        {
          R_DEFAULT_PACKAGES: '',
          R_SCRIPT_DEFAULT_PACKAGES: customDefaults
            ? 'datasets,utils,grDevices,graphics,stats,methods'
            : ''
        },
        undefined,
        vanilla
      )
      try {
        const first = await send('x <- base::c(1)')
        expect(first.error).toBeNull()
        expect(first.environmentOverlay?.executionContext?.rPackages?.cleanSession).toBe(
          vanilla && !customDefaults
        )
        expect(first.environmentOverlay?.executionContext?.rPackages?.reads).toEqual(
          expect.arrayContaining([
            { name: '<-', package: 'base' },
            { name: '::', package: 'base' }
          ])
        )
        const second = await send('x <- 2')
        expect(second.error).toBeNull()
        expect(second.environmentOverlay?.executionContext?.rPackages?.cleanSession).toBe(false)
      } finally {
        if (child.exitCode === null) {
          const exited = once(child, 'exit')
          child.stdin.end()
          await exited
        }
      }
    }
  )
  it('keeps responding when a loaded package description becomes unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-missing-description-'))
    const library = join(root, 'library')
    const packagePath = execFileSync(
      rscriptBin(),
      ['--vanilla', '-e', 'cat(find.package("RColorBrewer"))'],
      { encoding: 'utf8' }
    ).trim()
    cpSync(packagePath, join(library, 'RColorBrewer'), { recursive: true })
    const { child, send } = startLoop(rscriptBin(), {}, root)
    try {
      const loaded = await send(
        `.libPaths(c(${JSON.stringify(library.replaceAll('\\', '/'))}, .libPaths())); library(RColorBrewer); saved_result <- 42; cat(getNamespaceInfo("RColorBrewer", "path"))`
      )
      expect(loaded.error).toBeNull()
      expect(loaded.stdout).toBe(join(library, 'RColorBrewer').replaceAll('\\', '/'))
      // Change only the private fixture, never the installed package or R's functions.
      rmSync(join(library, 'RColorBrewer', 'DESCRIPTION'))
      rmSync(join(library, 'RColorBrewer', 'Meta', 'package.rds'))
      const result = await send('cat("R kernel alive\\n"); list.files(".")')
      expect(result.error).toBeNull()
      expect(result.stdout).toContain('R kernel alive')
      expect(result.environmentOverlay?.packages).toContainEqual(
        expect.objectContaining({
          name: 'RColorBrewer',
          loadedState: 'attached',
          versionStatus: 'unavailable'
        })
      )
      const unavailable = result.environmentOverlay?.packages.find(
        (pkg) => pkg.name === 'RColorBrewer'
      )
      expect(unavailable?.priority).toBeUndefined()
      expect(unavailable?.builtForRuntime).toBeUndefined()
      expect(result.environmentOverlay?.packages).toContainEqual(
        expect.objectContaining({ name: 'base', priority: 'base' })
      )
      const next = await send('cat(saved_result)')
      expect(next.error).toBeNull()
      expect(next.stdout).toBe('42')
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit')
        child.stdin.end()
        await exited
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('replays selected cross-cell circlize configuration and reproduces the PNG', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-graphics-config-'))
    const originalDir = join(root, 'original')
    const replayDir = join(root, 'replay')
    mkdirSync(originalDir)
    mkdirSync(replayDir)
    const original = startLoop(rscriptBin(), {}, originalDir)
    const replay = startLoop(rscriptBin(), {}, replayDir)
    const scripts = [
      'library(circlize); circos.clear(); circos.par(start.degree=45)',
      'unrelated <- 99',
      'circlize::circos.par(gap.degree=3)',
      'png("plot.png"); circlize::chordDiagram(matrix(1:4, 2)); dev.off(); circlize::circos.clear()'
    ]
    const responses: KernelLoopResponse[] = []
    const runs: NotebookRunRecord[] = []
    try {
      for (const [index, script] of scripts.entries()) {
        const response = await original.send(script)
        expect(response.error).toBeNull()
        responses.push(response)
        runs.push({
          runId: String(index),
          cellId: String(index),
          script,
          source: 'agent',
          kernelKind: 'r',
          kernelEpochId: 'original',
          status: 'completed',
          startedAt: index,
          endedAt: index + 1,
          text: { stdout: response.stdout, stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: []
        })
      }
      const result = await createNotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      }).project({ projectId: 'p', sessionId: 's', completedRun: runs[3]! })
      expect(result.stalenessByRunId['3']).toEqual({ state: 'clear' })
      const selected = new Set(['3'])
      const visit = (id: string): void => {
        for (const upstream of result.dependenciesByRunId?.[id] ?? []) {
          if (!selected.has(upstream)) {
            selected.add(upstream)
            visit(upstream)
          }
        }
      }
      visit('3')
      expect([...selected].sort()).toEqual(['0', '2', '3'])
      for (const [index, script] of scripts.entries()) {
        if (!selected.has(String(index))) continue
        const response = await replay.send(
          restoreRRandomState(
            script,
            responses[index]?.environmentOverlay?.executionContext?.before.rRandomState
          )
        )
        expect(response.error).toBeNull()
      }
      expect(readFileSync(join(replayDir, 'plot.png'))).toEqual(
        readFileSync(join(originalDir, 'plot.png'))
      )
    } finally {
      original.child.kill()
      replay.child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it.each([
    'Mersenne-Twister',
    "L'Ecuyer-CMRG",
    'Wichmann-Hill',
    'Marsaglia-Multicarry',
    'Super-Duper',
    'Knuth-TAOCP',
    'Knuth-TAOCP-2002'
  ])('replays per-cell random sequences in a fresh kernel: %s', async (kind) => {
    const original = startLoop(rscriptBin(), {})
    const replay = startLoop(rscriptBin(), {})
    try {
      await original.send(`RNGkind("${kind}"); set.seed(123); invisible(runif(17))`)
      const code = 'cat(c(runif(10), rnorm(10), sample.int(100, 10)), sep="\\n")'
      for (let index = 0; index < 2; index++) {
        const result = await original.send(code)
        expect(result.error).toBeNull()
        const restored = await replay.send(
          restoreRRandomState(
            code,
            result.environmentOverlay?.executionContext?.before.rRandomState
          )
        )
        expect(restored.error).toBeNull()
        expect(restored.stdout).toEqual(result.stdout)
        // Unrelated random draws may be omitted from the selected replay scope.
        await original.send('invisible(runif(19))')
      }
    } finally {
      original.child.kill()
      replay.child.kill()
    }
  })

  it('preserves user error lines when restoring random state', async () => {
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      const source = 'x <- 1\nstop("expected")'
      const original = await send(source)
      const replay = await send(
        restoreRRandomState(
          source,
          original.environmentOverlay?.executionContext?.before.rRandomState
        )
      )
      expect(replay.error).toContain('expected')
      expect(original.errorLine).toBe(2)
      expect(replay.errorLine).toBe(original.errorLine)
      await send('delayedAssign(".Random.seed", stop("must not force"), assign.env=.GlobalEnv)')
      const guarded = await send('cat("unforced")')
      expect(guarded.error).toBeNull()
      expect(guarded.environmentOverlay?.executionContext?.before.rRandomState).toEqual({
        state: 'unavailable',
        reason: 'seed-unavailable'
      })
    } finally {
      child.kill()
    }
  })

  it('captures an unseeded first cell and rejects RNGs with hidden state', async () => {
    const original = startLoop(rscriptBin(), {})
    const replay = startLoop(rscriptBin(), {})
    try {
      const result = await original.send('cat(runif(5))')
      const state = result.environmentOverlay?.executionContext?.before.rRandomState
      expect(state?.state).toBe('available')
      const restored = await replay.send(restoreRRandomState('cat(runif(5))', state))
      expect(restored.stdout).toEqual(result.stdout)
      const unsupported = await original.send(
        'RNGkind(normal.kind="Box-Muller"); invisible(rnorm(1))'
      )
      expect(unsupported.environmentOverlay?.executionContext?.after.rRandomState).toEqual({
        state: 'unavailable',
        reason: 'unsupported-rng'
      })
    } finally {
      original.child.kill()
      replay.child.kill()
    }
  })

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'replays the reported ggrepel plot with frozen input and captured RNG state',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'repel-volcano-replay-'))
      let captured: KernelLoopResponse['environmentOverlay']
      const pngs: Buffer[] = []
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name)
          const dataRoot = join(sessionRoot, 'data')
          const figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          execFileSync(
            process.env.OPEN_SCIENCE_TEST_PYTHON!,
            [
              '-c',
              'import pandas as pd; pd.DataFrame([(f"Gene{i}",(i%3-1)*(i+0.5),10.0**(-i*7)) for i in range(1,13)],columns=["id","log2FoldChange","pvalue"]).to_excel("inputs/differential-results-333333333333.xlsx", index=False)'
            ],
            { cwd: dataRoot, timeout: 20000 }
          )
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          try {
            const script = repelVolcanoCells[4]!.script
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'r',
              code: script,
              runId: name
            })
            const response = await send(
              name === 'original'
                ? script
                : restoreRRandomState(script, captured?.executionContext?.before.rRandomState)
            )
            expect(response.error).toBeNull()
            if (name === 'original') captured = response.environmentOverlay
            expect(captured?.executionContext?.before.rRandomState?.state).toBe('available')
            const result = await observation.finish()
            expect(result.fileEvidence).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
            expect(result.confirmedReadPaths).toEqual([
              'data/inputs/differential-results-333333333333.xlsx'
            ])
            expect(readFileSync(join(dataRoot, 'volcano_plot.pdf')).subarray(0, 5).toString()).toBe(
              '%PDF-'
            )
            pngs.push(readFileSync(join(dataRoot, 'volcano_plot.png')))
          } finally {
            child.kill()
          }
        }
        expect(pngs[0]!.length).toBeGreaterThan(1000)
        expect(pngs[0]).toEqual(pngs[1])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'replays the piped volcano from its upstream data cells in a fresh R kernel',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'piped-volcano-replay-'))
      const runs: NotebookRunRecord[] = []
      const captured = new Map<string, KernelLoopResponse['environmentOverlay']>()
      const pngs: Buffer[] = []
      let required = new Set(pipedVolcanoCells.map((cell) => cell.runId))
      const analyzer = createNotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name)
          const dataRoot = join(sessionRoot, 'data')
          const figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          execFileSync(
            process.env.OPEN_SCIENCE_TEST_PYTHON!,
            [
              '-c',
              'import pandas as pd; pd.DataFrame([(f"Gene{i}",(i%3-1)*(i+0.5),10.0**(-i*7)) for i in range(1,13)],columns=["id","log2FoldChange","pvalue"]).to_excel("inputs/differential-results-333333333333.xlsx", index=False)'
            ],
            { cwd: dataRoot, timeout: 20000 }
          )
          writeFileSync(
            join(dataRoot, 'inputs/expression-matrix-444444444444.csv'),
            [
              'id,' + Array(12).fill('group').join(','),
              'id,' + Array.from({ length: 12 }, (_, i) => `sample${i}`).join(','),
              ...Array.from(
                { length: 12 },
                (_, i) =>
                  `Gene${i + 1},` +
                  Array(12)
                    .fill(i + 1)
                    .join(',')
              )
            ].join('\n') + '\n'
          )
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          try {
            for (const cell of pipedVolcanoCells.filter((cell) => required.has(cell.runId))) {
              const context = await analyzer.sourceFileAccessContext({
                projectId: 'p',
                sessionId: 's',
                currentRunId: cell.runId,
                language: 'r',
                kernelEpochId: 'epoch',
                environment: 'r'
              })
              const observation = await startWorkingFileObservation({
                dataRoot,
                notebookSessionRoot: sessionRoot,
                cwd: dataRoot,
                language: 'r',
                code: cell.script,
                runId: `${name}-${cell.runId}`,
                sourceFileAccessContext: context
              })
              const response = await send(
                name === 'original'
                  ? cell.script
                  : restoreRRandomState(
                      cell.script,
                      captured.get(cell.runId)?.executionContext?.before.rRandomState
                    )
              )
              expect(response.error, `cell ${cell.runId}`).toBeNull()
              const evidence = await observation.finish()
              expect(evidence.fileEvidence, `cell ${cell.runId}`).toMatchObject({
                state: 'available',
                fileReads: 'complete',
                writerAttribution: 'complete',
                reasonCodes: []
              })
              if (cell.runId === '2')
                expect(evidence.confirmedReadPaths).toEqual(
                  expect.arrayContaining([
                    'data/inputs/expression-matrix-444444444444.csv',
                    'data/inputs/differential-results-333333333333.xlsx'
                  ])
                )
              if (cell.runId === '4') {
                expect(evidence.confirmedReadPaths ?? []).toEqual([])
                expect(evidence.workingFiles.map((file) => file.relativePath)).toContain(
                  'data/diagonal_volcano_plot.png'
                )
              }
              if (name === 'original') {
                captured.set(cell.runId, response.environmentOverlay)
                runs.push({
                  runId: cell.runId,
                  cellId: cell.runId,
                  script: cell.script,
                  kernelKind: 'r',
                  kernelEpochId: 'epoch',
                  environment: 'r',
                  source: 'agent',
                  status: 'completed',
                  startedAt: runs.length,
                  endedAt: runs.length + 1,
                  text: { stdout: '', stderr: '', traceback: '', plain: [] },
                  outputs: [],
                  workingFiles: []
                })
              }
            }
            pngs.push(readFileSync(join(dataRoot, 'diagonal_volcano_plot.png')))
          } finally {
            child.kill()
          }
          if (name === 'original') {
            const projection = await analyzer.project({
              projectId: 'p',
              sessionId: 's',
              completedRun: runs.at(-1)!
            })
            expect(projection.stalenessByRunId['4']).toEqual({ state: 'clear' })
            required = new Set(['4'])
            for (const runId of required)
              for (const dependency of projection.dependenciesByRunId?.[runId] ?? [])
                required.add(dependency)
            expect([...required].sort()).toEqual(['2', '3', '4'])
          }
        }
        expect(pngs[0]!.length).toBeGreaterThan(1000)
        expect(pngs[1]).toEqual(pngs[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'replays the self-contained volcano after workbook probes and a failed RDS read',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'retry-volcano-replay-'))
      const pngs: Buffer[] = []
      let captured: KernelLoopResponse['environmentOverlay']
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name)
          const dataRoot = join(sessionRoot, 'data')
          const figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          execFileSync(
            process.env.OPEN_SCIENCE_TEST_PYTHON!,
            [
              '-c',
              'import pandas as pd; pd.DataFrame([(f"Gene{i}",(i%3-1)*(i+0.5),10.0**(-i*7)) for i in range(1,13)],columns=["id","log2FoldChange","pvalue"]).to_excel("inputs/differential-results-333333333333.xlsx",sheet_name="Sheet 1",index=False)'
            ],
            { cwd: dataRoot, timeout: 20000 }
          )
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          try {
            if (name === 'original') {
              writeFileSync(
                join(dataRoot, 'inputs/expression-matrix-444444444444.csv'),
                '#group,group1\nid,sample1\nGene1,1\nGene2,2\n'
              )
              for (const cell of retryVolcanoCells.slice(1, 8)) {
                const response = await send(cell.script)
                if (cell.status === 'failed') expect(response.error, cell.runId).toBeTruthy()
                else expect(response.error, cell.runId).toBeNull()
              }
            }
            const script = retryVolcanoCells[8]!.script
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'r',
              code: script,
              runId: name
            })
            const response = await send(
              name === 'original'
                ? script
                : restoreRRandomState(script, captured?.executionContext?.before.rRandomState)
            )
            expect(response.error).toBeNull()
            if (name === 'original') captured = response.environmentOverlay
            expect(captured?.executionContext?.before.rRandomState?.state).toBe('available')
            const evidence = await observation.finish()
            expect(evidence.fileEvidence).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
            expect(evidence.confirmedReadPaths).toEqual([
              'data/inputs/differential-results-333333333333.xlsx'
            ])
            pngs.push(readFileSync(join(dataRoot, 'Synthetic volcano plot.png')))
          } finally {
            child.kill()
          }
        }
        expect(pngs[0]!.length).toBeGreaterThan(1000)
        expect(pngs[1]).toEqual(pngs[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'captures and replays the aggregate volcano statistics and plots from CSV',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'aggregate-volcano-native-'))
      let captured: KernelLoopResponse['environmentOverlay']
      const outputs: Buffer[][] = []
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name),
            dataRoot = join(sessionRoot, 'data'),
            figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          execFileSync(
            process.env.OPEN_SCIENCE_TEST_PYTHON!,
            [
              '-c',
              'import csv,math; rows=[ ["#group"]+["group"]*12,["id"]+[f"sample{j}" for j in range(12)] ]; rows += [[f"Gene{i}"]+[i+(j%3)*0.1+(0 if j<6 else (i*0.35 if j<9 else math.sin(i)*3)) for j in range(12)] for i in range(1,9)]; rows += [rows[2], ["Constant"]+[4]*12]; f=open("inputs/expression-matrix-444444444444.csv","w"); csv.writer(f).writerows(rows); f.close()'
            ],
            { cwd: dataRoot, timeout: 20000 }
          )
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          try {
            const script = aggregateVolcanoCells[3]!.script
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'r',
              code: script,
              runId: name
            })
            const response = await send(
              name === 'original'
                ? script
                : restoreRRandomState(script, captured?.executionContext?.before.rRandomState)
            )
            expect(response.error).toBeNull()
            if (name === 'original') captured = response.environmentOverlay
            const evidence = await observation.finish()
            expect(evidence.fileEvidence).toMatchObject(partialRColumnEvidence)
            expect(evidence.confirmedReadPaths).toBeUndefined()
            expect(evidence.workingFiles.map((file) => file.relativePath).sort()).toEqual([
              'data/diagonal_volcano.pdf',
              'data/diagonal_volcano.png',
              'data/diagonal_volcano_stats.csv'
            ])
            const csv = readFileSync(join(dataRoot, 'diagonal_volcano_stats.csv'))
            expect(csv.toString()).toContain('"Constant",0,0,1,1')
            expect(
              readFileSync(join(dataRoot, 'diagonal_volcano.pdf')).subarray(0, 5).toString()
            ).toBe('%PDF-')
            outputs.push([csv, readFileSync(join(dataRoot, 'diagonal_volcano.png'))])
          } finally {
            child.kill()
          }
        }
        expect(outputs[1]).toEqual(outputs[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'captures and replays finite volcano columns with missing and zero p-values',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'finite-volcano-native-'))
      let captured: KernelLoopResponse['environmentOverlay']
      const outputs: Buffer[][] = []
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name)
          const dataRoot = join(sessionRoot, 'data')
          const figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          execFileSync(
            process.env.OPEN_SCIENCE_TEST_PYTHON!,
            [
              '-c',
              'import pandas as pd; rows=[(f"Gene{i}",(i%3-1)*(i+0.5),10.0**(-i)) for i in range(1,13)]; rows += [("ZeroP",2,0),("MissingP",-2,None)]; pd.DataFrame(rows,columns=["id","log2FoldChange","pvalue"]).to_excel("inputs/differential-results-333333333333.xlsx",sheet_name="Sheet 1",index=False)'
            ],
            { cwd: dataRoot, timeout: 20000 }
          )
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          try {
            const script = finiteVolcanoCells[8]!.script
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'r',
              code: script,
              runId: name
            })
            const response = await send(
              name === 'original'
                ? script
                : restoreRRandomState(script, captured?.executionContext?.before.rRandomState)
            )
            expect(response.error).toBeNull()
            if (name === 'original') captured = response.environmentOverlay
            expect(captured?.executionContext?.before.rRandomState?.state).toBe('available')
            const evidence = await observation.finish()
            expect(evidence.fileEvidence).toMatchObject(partialRColumnEvidence)
            expect(evidence.confirmedReadPaths).toBeUndefined()
            expect(evidence.workingFiles.map((file) => file.relativePath).sort()).toEqual([
              'data/diagonal_volcano.png',
              'data/volcano_data.csv'
            ])
            const csv = readFileSync(join(dataRoot, 'volcano_data.csv'))
            expect(csv.toString()).toContain('"MissingP",-2,NA,NA,"NS"')
            const png = readFileSync(join(dataRoot, 'diagonal_volcano.png'))
            expect(png.length).toBeGreaterThan(1000)
            outputs.push([csv, png])
          } finally {
            child.kill()
          }
        }
        expect(outputs[1]).toEqual(outputs[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'captures and replays the joined expression and differential table pipeline',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'joined-volcano-native-'))
      const outputs: Buffer[][] = []
      let captured: KernelLoopResponse['environmentOverlay']
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name)
          const dataRoot = join(sessionRoot, 'data')
          const figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          execFileSync(
            process.env.OPEN_SCIENCE_TEST_PYTHON!,
            [
              '-c',
              [
                'import pandas as pd',
                'rows=[(f"Gene{i}", (i%3-1)*2.0, 0 if i==1 else (0.5 if i%3==1 else 0.001)) for i in range(1,25)]',
                'rows += [rows[0], ("MissingP", 2, None)]',
                'pd.DataFrame(rows,columns=["id","log2FoldChange","pvalue"]).to_excel("inputs/differential-results-333333333333.xlsx",sheet_name="Sheet 1",index=False)',
                'samples=[f"s{i}" for i in range(12)]',
                'expr=pd.DataFrame([[r[0]]+[6+i/5+j/50+(r[1] if j>=6 else 0) for j in range(12)] for i,r in enumerate(rows)],columns=["id"]+samples)',
                'path="inputs/expression-matrix-444444444444.csv"',
                'with open(path,"w") as f: f.write("#group,"+",".join(["group1"]*6+["group2"]*6)+"\\n")',
                'expr.to_csv(path,mode="a",index=False)'
              ].join('\n')
            ],
            { cwd: dataRoot, timeout: 20000 }
          )
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          try {
            const indices = name === 'original' ? [2, 3, 4, 5, 6, 12] : [2, 4, 5, 12]
            const script = indices.map((i) => joinedVolcanoCells[i].script).join('\n')
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'r',
              code: script,
              runId: name
            })
            const result = await send(
              name === 'original'
                ? script
                : restoreRRandomState(script, captured?.executionContext?.before.rRandomState)
            )
            expect(result.error).toBeNull()
            if (name === 'original') captured = result.environmentOverlay
            const evidence = await observation.finish()
            // Both pipelines retain calls on columns whose dispatch is not statically proven.
            expect(evidence.fileEvidence).toMatchObject(partialRColumnEvidence)
            expect(evidence.confirmedReadPaths).toBeUndefined()
            expect(evidence.workingFiles.map((f) => f.relativePath).sort()).toEqual([
              'data/diagonal_volcano.pdf',
              'data/diagonal_volcano.png',
              'data/diagonal_volcano_data.csv'
            ])
            expect(
              readFileSync(join(dataRoot, 'diagonal_volcano.pdf')).subarray(0, 5).toString()
            ).toBe('%PDF-')
            outputs.push(
              ['diagonal_volcano_data.csv', 'diagonal_volcano.png'].map((file) =>
                readFileSync(join(dataRoot, file))
              )
            )
          } finally {
            child.kill()
          }
        }
        expect(outputs[1]).toEqual(outputs[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'replays Python preparation and R column extraction in fresh kernels',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cross-language-native-'))
      const outputs: Buffer[] = []
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name),
            dataRoot = join(sessionRoot, 'data'),
            figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(join(dataRoot, 'processed'))
          mkdirSync(figures)
          execFileSync(
            process.env.OPEN_SCIENCE_TEST_PYTHON!,
            [
              '-c',
              `import pandas as pd
ids=[f"Gene{i}" for i in range(1,25)]
pd.DataFrame({"id":ids,"log2FoldChange":[-3,0,3]*8,"pvalue":[.001,.5,.01]*8}).to_excel("inputs/differential-results-333333333333.xlsx",sheet_name="Sheet 1",index=False)
with open("inputs/expression-matrix-444444444444.csv","w") as f:
 f.write("annotation\\n")
 pd.DataFrame({"id":ids,"S1":range(24)}).to_csv(f,index=False)
`
            ],
            { cwd: dataRoot, timeout: 30000 }
          )
          const pythonObservation = await startWorkingFileObservation({
            dataRoot,
            notebookSessionRoot: sessionRoot,
            cwd: dataRoot,
            language: 'python',
            code: crossLanguageVolcanoCells[5].script,
            runId: `${name}-python`
          })
          execFileSync(
            process.env.OPEN_SCIENCE_TEST_PYTHON!,
            ['-c', crossLanguageVolcanoCells[5].script],
            { cwd: dataRoot, timeout: 30000 }
          )
          const pythonEvidence = await pythonObservation.finish()
          expect(pythonEvidence.fileEvidence).toMatchObject({
            state: 'available',
            fileReads: 'complete',
            writerAttribution: 'complete',
            reasonCodes: []
          })
          expect(pythonEvidence.confirmedReadPaths?.slice().sort()).toEqual([
            'data/inputs/differential-results-333333333333.xlsx',
            'data/inputs/expression-matrix-444444444444.csv'
          ])
          expect(pythonEvidence.workingFiles.map((f) => f.relativePath)).toEqual([
            'data/processed/diff_results.csv'
          ])
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          try {
            if (name === 'original')
              for (const index of [6, 7])
                expect((await send(crossLanguageVolcanoCells[index].script)).error).toBeNull()
            expect((await send('set.seed(42)')).error).toBeNull()
            const script = crossLanguageVolcanoCells[8].script
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'r',
              code: script,
              runId: `${name}-r`
            })
            expect((await send(script)).error).toBeNull()
            const evidence = await observation.finish()
            expect(evidence.fileEvidence).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
            expect(evidence.confirmedReadPaths).toEqual(['data/processed/diff_results.csv'])
            expect(evidence.workingFiles.map((f) => f.relativePath).sort()).toEqual([
              'data/processed/diagonal_volcano.pdf',
              'data/processed/diagonal_volcano.png'
            ])
            expect(
              readFileSync(join(dataRoot, 'processed/diagonal_volcano.pdf'))
                .subarray(0, 4)
                .toString()
            ).toBe('%PDF')
            outputs.push(readFileSync(join(dataRoot, 'processed/diagonal_volcano.png')))
          } finally {
            child.kill()
          }
        }
        expect(outputs[0].length).toBeGreaterThan(1000)
        expect(outputs[1]).toEqual(outputs[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'captures native and magrittr pipes between Python kernels',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pipe-roundtrip-')),
        sessionRoot = join(root, 'session'),
        dataRoot = join(sessionRoot, 'data'),
        figures = join(sessionRoot, 'figures')
      mkdirSync(dataRoot, { recursive: true })
      mkdirSync(figures)
      const { child, send } = startLoop(
        rscriptBin(),
        { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
        dataRoot
      )
      try {
        execFileSync(
          process.env.OPEN_SCIENCE_TEST_PYTHON!,
          [
            '-c',
            'import pandas as pd\npd.DataFrame({"id":["A","B"],"value":[2,3]}).to_csv("input.csv",index=False)'
          ],
          { cwd: dataRoot, timeout: 30000 }
        )
        const script = `library(dplyr)
df<-read.csv("input.csv")
df<-df %>% mutate(.data=., doubled=value*2)
df<-df |> mutate(.data=_, total=doubled+value)
write.csv(df,"result.csv",row.names=FALSE)`
        const observation = await startWorkingFileObservation({
          dataRoot,
          notebookSessionRoot: sessionRoot,
          cwd: dataRoot,
          language: 'r',
          code: script,
          runId: 'r-pipes'
        })
        expect((await send(script)).error).toBeNull()
        const evidence = await observation.finish()
        expect(evidence.fileEvidence).toMatchObject({
          state: 'available',
          fileReads: 'complete',
          writerAttribution: 'complete',
          reasonCodes: []
        })
        expect(evidence.confirmedReadPaths).toEqual(['data/input.csv'])
        expect(evidence.workingFiles.map((f) => f.relativePath)).toEqual(['data/result.csv'])
        const check = execFileSync(
          process.env.OPEN_SCIENCE_TEST_PYTHON!,
          [
            '-c',
            'import pandas as pd\ndf=pd.read_csv("result.csv")\nassert df["total"].tolist()==[6,9]\nprint("ok")'
          ],
          { cwd: dataRoot, timeout: 30000, encoding: 'utf8' }
        )
        expect(check.trim()).toBe('ok')
      } finally {
        child.kill()
        rmSync(root, { recursive: true, force: true })
      }
    },
    60000
  )

  it('reports parse failures before executing any statement and preserves the next request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-parse-failure-')),
      figures = join(root, 'figures')
    mkdirSync(figures)
    const { child, send } = startLoop(
      rscriptBin(),
      { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
      root
    )
    try {
      expect((await send('sentinel <- 7')).error).toBeNull()
      const result = await send('sentinel <- 99\nwriteLines("wrong", "should-not-exist.txt")\n)')
      expect(result.error).toContain('unexpected')
      expect(existsSync(join(root, 'should-not-exist.txt'))).toBe(false)
      expect((await send('stopifnot(sentinel == 7); cat("unchanged")')).stdout).toContain(
        'unchanged'
      )
      const reported = await send(layeredVolcanoCells[6].script)
      expect(reported.error).toContain('unexpected')
      expect((await send('cat("next request")')).error).toBeNull()
    } finally {
      child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('replays the contrast plot with its three upstream R preparation cells', async () => {
    const root = mkdtempSync(join(tmpdir(), 'contrasts-native-'))
    const outputs: Buffer[] = []
    const captured = new Map<string, KernelLoopResponse['environmentOverlay']>()
    try {
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name),
          dataRoot = join(sessionRoot, 'data'),
          figures = join(sessionRoot, 'figures')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        mkdirSync(figures)
        // Small synthetic expression matrix; no user data is opened.
        const samples = [
          'CohortActrl1',
          'CohortActrl2',
          'CohortActrl4',
          'CohortAsi1',
          'CohortAsi2',
          'CohortAsi5',
          'CohortBctrl1',
          'CohortBctrl2',
          'CohortBctrl4',
          'CohortBsi1',
          'CohortBsi2',
          'CohortBsi3'
        ]
        const csv = [
          ['group', ...samples.map((_, i) => (i < 6 ? 'CohortA' : 'CohortB'))].join(','),
          ['id', ...samples].join(','),
          ...Array.from({ length: 12 }, (_, g) =>
            [
              'Gene' + g,
              ...samples.map(
                (_, i) =>
                  10 +
                  g / 10 +
                  (i % 3) * 0.13 +
                  ([1, 3].includes(Math.floor(i / 3))
                    ? i < 6
                      ? (g - 6) / 2
                      : Math.sin(g * 0.55) * 2
                    : 0)
              )
            ].join(',')
          )
        ].join('\n')
        writeFileSync(join(dataRoot, 'inputs/expression-matrix-444444444444.csv'), csv)
        const { child, send } = startLoop(
          rscriptBin(),
          { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
          dataRoot
        )
        const runs: NotebookRunRecord[] = []
        const analyzer = createNotebookDependencyAnalyzer({
          storageRoot: sessionRoot,
          repository: { readSessionRuns: async () => runs }
        })
        try {
          for (const cell of contrastsVolcanoCells.slice(3)) {
            const runId = String(cell.index)
            const context = await analyzer.sourceFileAccessContext({
              projectId: 'p',
              sessionId: 's',
              currentRunId: runId,
              language: 'r',
              environment: 'r',
              kernelEpochId: 'epoch'
            })
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'r',
              code: cell.script,
              runId: `${name}-${runId}`,
              sourceFileAccessContext: context
            })
            const result = await send(
              name === 'original'
                ? cell.script
                : restoreRRandomState(
                    cell.script,
                    captured.get(runId)?.executionContext?.before.rRandomState
                  )
            )
            if (name === 'original') captured.set(runId, result.environmentOverlay)
            expect(result.environmentOverlay?.executionContext?.before.rRandomState?.state).toBe(
              'available'
            )
            expect(result.error, `cell ${cell.index}`).toBeNull()
            const evidence = await observation.finish()
            expect(evidence.fileEvidence, `${name} cell ${cell.index}`).toMatchObject(
              cell.index === 4 || cell.index === 5
                ? partialRColumnEvidence
                : {
                    state: cell.index === 3 ? 'available' : 'partial',
                    fileReads: cell.index === 3 ? 'complete' : 'partial',
                    writerAttribution: 'complete',
                    reasonCodes:
                      cell.index === 3
                        ? []
                        : ['file-reads-not-observed', 'source-analysis-unsupported-call']
                  }
            )
            expect(evidence.confirmedReadPaths ?? []).toEqual(
              cell.index === 3 ? ['data/inputs/expression-matrix-444444444444.csv'] : []
            )
            if (cell.index === 6)
              expect(evidence.workingFiles.map((f) => f.relativePath).sort()).toEqual([
                'data/diagonal_volcano.pdf',
                'data/diagonal_volcano.png'
              ])
            runs.push({
              runId,
              cellId: runId,
              kernelKind: 'r',
              kernelEpochId: 'epoch',
              environment: 'r',
              source: 'agent',
              status: 'completed',
              kernelDispatched: true,
              startedAt: cell.index,
              endedAt: cell.index + 1,
              script: cell.script,
              text: { stdout: '', stderr: '', traceback: '', plain: [] },
              outputs: [],
              workingFiles: []
            })
          }
          outputs.push(readFileSync(join(dataRoot, 'diagonal_volcano.png')))
        } finally {
          child.kill()
        }
      }
      expect(outputs[0].length).toBeGreaterThan(1000)
      expect(createHash('sha256').update(outputs[1]).digest('hex')).toBe(
        createHash('sha256').update(outputs[0]).digest('hex')
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it('captures and replays a generated RDS data frame across fresh R kernels', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rds-clean-native-'))
    const hashes: string[] = []
    let captured: KernelLoopResponse['environmentOverlay']
    try {
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name),
          dataRoot = join(sessionRoot, 'data'),
          figures = join(sessionRoot, 'figures')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        mkdirSync(figures)
        const runs: NotebookRunRecord[] = []
        const analyzer = createNotebookDependencyAnalyzer({
          storageRoot: root,
          repository: { readSessionRuns: async () => runs }
        })
        for (const index of [7, 8]) {
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          const runId = `${name}-${index}`
          try {
            if (index === 7)
              expect(
                (
                  await send(
                    'openxlsx::write.xlsx(data.frame(id=paste0("Gene",1:12),log2FoldChange=seq(-3,3,length.out=12),pvalue=10^(-seq(1,6,length.out=12))),"inputs/differential-results-333333333333.xlsx")'
                  )
                ).error
              ).toBeNull()
            const script = rdsCleanVolcanoCells[index].script
            const context = await analyzer.sourceFileAccessContext({
              projectId: 'p',
              sessionId: 's',
              currentRunId: runId,
              language: 'r',
              environment: 'r',
              kernelEpochId: runId
            })
            // Partial writer evidence must not certify a serialized value for the next kernel.
            if (index === 8) expect(context?.serializedValueFiles).toBeUndefined()
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'r',
              code: script,
              runId,
              sourceFileAccessContext: context
            })
            const result = await send(
              index === 8 && name === 'replay'
                ? restoreRRandomState(script, captured?.executionContext?.before.rRandomState)
                : script
            )
            expect(result.error, `${name} cell ${index}`).toBeNull()
            if (index === 8 && name === 'original') captured = result.environmentOverlay
            const evidence = await observation.finish()
            expect(evidence.fileEvidence, `${name} cell ${index}`).toMatchObject(
              partialRColumnEvidence
            )
            expect(evidence.confirmedReadPaths).toBeUndefined()
            expect(evidence.workingFiles.map((f) => f.relativePath)).toContain(
              index === 7 ? 'data/diff_df_clean.rds' : 'data/diagonal_volcano.png'
            )
            runs.push({
              runId,
              cellId: runId,
              kernelKind: 'r',
              kernelEpochId: runId,
              environment: 'r',
              source: 'agent',
              status: 'completed',
              kernelDispatched: true,
              startedAt: index,
              endedAt: index + 1,
              script,
              text: { stdout: '', stderr: '', traceback: '', plain: [] },
              outputs: [],
              workingFiles: evidence.workingFiles,
              fileEvidence: evidence.fileEvidence
            })
            const projection = await analyzer.project({
              projectId: 'p',
              sessionId: 's',
              throughRunId: runId
            })
            expect(projection.stalenessByRunId[runId], JSON.stringify(projection)).toEqual({
              state: 'unknown',
              reasons: ['external-state', 'opaque-call']
            })
          } finally {
            child.kill()
          }
        }
        hashes.push(
          createHash('sha256')
            .update(readFileSync(join(dataRoot, 'diagonal_volcano.png')))
            .digest('hex')
        )
      }
      expect(hashes[1]).toBe(hashes[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it.each([
    {
      label: 'Venn RDS recovery',
      cells: vennRdsCells,
      original: [1, 2, 3, 4, 5, 6, 7],
      replay: [1, 7],
      failed: [2, 4],
      outputs: ['proportional_venn.png']
    },
    {
      label: 'Venn package recovery',
      cells: vennPackageCells,
      original: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11],
      replay: [2, 11],
      failed: [3, 5],
      outputs: ['venn_proportional.png', 'venn_basic.png']
    }
  ])(
    'captures $label and skips failed cells in a fresh replay',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'venn-rds-native-'))
      const hashes: string[][] = []
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name),
            dataRoot = join(sessionRoot, 'data'),
            figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          const runs: NotebookRunRecord[] = []
          const analyzer = createNotebookDependencyAnalyzer({
            storageRoot: root,
            repository: { readSessionRuns: async () => runs }
          })
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          try {
            expect(
              (
                await send(
                  'openxlsx::write.xlsx(data.frame(A=c("a","b","c",NA),B=c("b","d",NA,NA),C=c("a","e","f",NA),D=c("b","e",NA,NA),E=c("a","d","g","h")),"inputs/set-membership-111111111111.xlsx",sheetName="5 groups")'
                )
              ).error
            ).toBeNull()
            for (const index of name === 'original' ? scenario.original : scenario.replay) {
              const runId = `${name}-${index}`
              const script = scenario.cells[index]
              const context = await analyzer.sourceFileAccessContext({
                projectId: 'p',
                sessionId: 's',
                currentRunId: runId,
                language: 'r',
                environment: 'r',
                kernelEpochId: name
              })
              if (index === scenario.replay.at(-1))
                expect(
                  context?.serializedValueFiles?.some((file) => file.path === 'data/sets.rds')
                ).toBe(true)
              const observation = await startWorkingFileObservation({
                dataRoot,
                notebookSessionRoot: sessionRoot,
                cwd: dataRoot,
                language: 'r',
                code: script,
                runId,
                sourceFileAccessContext: context
              })
              const result = await send(script)
              const failed = scenario.failed.includes(index)
              if (failed) expect(result.error).not.toBeNull()
              else expect(result.error, `${name} cell ${index}`).toBeNull()
              const evidence = await observation.finish()
              if (scenario.replay.includes(index)) {
                expect(evidence.fileEvidence, `${name} cell ${index}`).toMatchObject({
                  state: 'available',
                  fileReads: 'complete',
                  writerAttribution: 'complete',
                  reasonCodes: []
                })
                expect(evidence.confirmedReadPaths).toEqual([
                  index === scenario.replay[0]
                    ? 'data/inputs/set-membership-111111111111.xlsx'
                    : 'data/sets.rds'
                ])
                expect(evidence.workingFiles.map((file) => file.relativePath)).toContain(
                  index === scenario.replay[0] ? 'data/sets.rds' : `data/${scenario.outputs[0]}`
                )
              }
              runs.push({
                runId,
                cellId: runId,
                kernelKind: 'r',
                kernelEpochId: name,
                environment: 'r',
                source: 'agent',
                status: failed ? 'failed' : 'completed',
                kernelDispatched: true,
                startedAt: index,
                endedAt: index + 1,
                script,
                text: { stdout: '', stderr: '', traceback: '', plain: [] },
                outputs: [],
                workingFiles: evidence.workingFiles,
                fileEvidence: evidence.fileEvidence,
                environmentManifest: {
                  schemaVersion: 1,
                  captureKind: 'completed-run',
                  capturedAt: '2026-09-10T00:00:00Z',
                  installedInventory: {
                    capturedAt: '2026-09-10T00:00:00Z',
                    source: 'full-scan',
                    validation: 'full-scan'
                  },
                  kernelKind: 'r',
                  environmentName: 'r',
                  runtimeSource: 'managed',
                  inventorySources: ['kernel-native'],
                  packages: result.environmentOverlay?.packages ?? [],
                  complete: true,
                  captureStatus: 'complete',
                  executionContext: result.environmentOverlay?.executionContext
                }
              })
              const projection = await analyzer.project({
                projectId: 'p',
                sessionId: 's',
                throughRunId: runId
              })
              if (scenario.replay.includes(index))
                expect(projection.stalenessByRunId[runId], JSON.stringify(projection)).toEqual({
                  ...(scenario.label === 'Venn RDS recovery' && name === 'original' && index === 7
                    ? { state: 'unknown', reasons: ['external-state', 'opaque-call'] }
                    : { state: 'clear' })
                })
              if (index === scenario.replay.at(-1))
                expect(projection.dependenciesByRunId?.[runId]).toEqual(
                  scenario.label === 'Venn RDS recovery' && name === 'original' ? undefined : []
                )
            }
          } finally {
            child.kill()
          }
          hashes.push(
            scenario.outputs.map((file) =>
              createHash('sha256')
                .update(readFileSync(join(dataRoot, file)))
                .digest('hex')
            )
          )
        }
        expect(hashes[1]).toEqual(hashes[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it('replays the layered volcano after a rejected plot and a missing RDS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'layered-volcano-native-')),
      outputs: Buffer[] = []
    try {
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name),
          dataRoot = join(sessionRoot, 'data'),
          figures = join(sessionRoot, 'figures')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        mkdirSync(figures)
        const { child, send } = startLoop(
          rscriptBin(),
          { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
          dataRoot
        )
        try {
          expect(
            (
              await send(
                'openxlsx::write.xlsx(data.frame(id=paste0("Gene",1:24),log2FoldChange=rep(c(-3,0,3),8),pvalue=rep(c(.001,.5,.01),8)),"inputs/differential-results-333333333333.xlsx",sheetName="Sheet 1")'
              )
            ).error
          ).toBeNull()
          if (name === 'original') {
            expect((await send(layeredVolcanoCells[5].script)).error).toBeNull()
            expect((await send(layeredVolcanoCells[6].script)).error).not.toBeNull()
            expect((await send(layeredVolcanoCells[8].script)).error).not.toBeNull()
          }
          const script = layeredVolcanoCells[11].script
          const observation = await startWorkingFileObservation({
            dataRoot,
            notebookSessionRoot: sessionRoot,
            cwd: dataRoot,
            language: 'r',
            code: script,
            runId: `${name}-final`
          })
          expect((await send(script)).error).toBeNull()
          const evidence = await observation.finish()
          expect(evidence.fileEvidence).toMatchObject(partialRColumnEvidence)
          expect(evidence.confirmedReadPaths).toBeUndefined()
          expect(evidence.workingFiles.map((f) => f.relativePath).sort()).toEqual([
            'data/diagonal_volcano.pdf',
            'data/diagonal_volcano.png'
          ])
          outputs.push(readFileSync(join(dataRoot, 'diagonal_volcano.png')))
        } finally {
          child.kill()
        }
      }
      expect(outputs[0].length).toBeGreaterThan(1000)
      expect(outputs[1]).toEqual(outputs[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it('replays the conditional-column volcano after a failed legend layer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'with-volcano-native-'))
    const outputs: Buffer[] = []
    try {
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name),
          dataRoot = join(sessionRoot, 'data'),
          figures = join(sessionRoot, 'figures')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        mkdirSync(figures)
        const { child, send } = startLoop(
          rscriptBin(),
          { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
          dataRoot
        )
        try {
          const setup =
            await send(`openxlsx::write.xlsx(data.frame(id=paste0("Gene",1:24),log2FoldChange=rep(c(-3,0,3),8),pvalue=rep(c(.001,.5,.01),8)),"inputs/differential-results-333333333333.xlsx")
set.seed(42)`)
          expect(setup.error).toBeNull()
          if (name === 'original') {
            expect(
              (
                await send(
                  'writeLines(c("#group,group1,group2","id,S1,S2","Gene1,1,2"),"inputs/expression-matrix-444444444444.csv")'
                )
              ).error
            ).toBeNull()
            expect((await send(withVolcanoCells[6].script)).error).toBeNull()
            const inspection = await send(withVolcanoCells[7].script)
            expect(inspection.error).not.toBeNull()
          }
          expect((await send('set.seed(42)')).error).toBeNull()
          const script = withVolcanoCells[8].script
          const observation = await startWorkingFileObservation({
            dataRoot,
            notebookSessionRoot: sessionRoot,
            cwd: dataRoot,
            language: 'r',
            code: script,
            runId: name
          })
          const result = await send(script)
          expect(result.error).toBeNull()
          const evidence = await observation.finish()
          expect(evidence.fileEvidence).toMatchObject({
            state: 'available',
            fileReads: 'complete',
            writerAttribution: 'complete',
            reasonCodes: []
          })
          expect(evidence.confirmedReadPaths).toEqual([
            'data/inputs/differential-results-333333333333.xlsx'
          ])
          expect(evidence.workingFiles.map((f) => f.relativePath)).toEqual([
            'data/diagonal_volcano.png'
          ])
          const png = readFileSync(join(dataRoot, 'diagonal_volcano.png'))
          expect(png.length).toBeGreaterThan(1000)
          outputs.push(png)
        } finally {
          child.kill()
        }
      }
      expect(outputs[1]).toEqual(outputs[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it('replays the self-contained volcano independently of font inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'font-volcano-native-'))
    const outputs: Buffer[] = []
    try {
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name),
          dataRoot = join(sessionRoot, 'data'),
          figures = join(sessionRoot, 'figures')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        mkdirSync(figures)
        const { child, send } = startLoop(
          rscriptBin(),
          { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
          dataRoot
        )
        try {
          const setup =
            await send(`openxlsx::write.xlsx(data.frame(id=paste0("Gene",1:24),log2FoldChange=rep(c(-3,0,3),8),pvalue=rep(c(.001,.5,.01),8)),"inputs/differential-results-333333333333.xlsx")
set.seed(42)`)
          expect(setup.error).toBeNull()
          if (name === 'original') {
            const inspection = await send(fontFallbackVolcanoCells[10].script)
            expect(inspection.error).toBeNull()
          }
          const script = fontFallbackVolcanoCells[12].script
          const observation = await startWorkingFileObservation({
            dataRoot,
            notebookSessionRoot: sessionRoot,
            cwd: dataRoot,
            language: 'r',
            code: script,
            runId: name
          })
          const result = await send(script)
          expect(result.error).toBeNull()
          const evidence = await observation.finish()
          expect(evidence.fileEvidence).toMatchObject({
            state: 'available',
            fileReads: 'complete',
            writerAttribution: 'complete',
            reasonCodes: []
          })
          expect(evidence.confirmedReadPaths).toEqual([
            'data/inputs/differential-results-333333333333.xlsx'
          ])
          expect(evidence.workingFiles.map((f) => f.relativePath)).toEqual([
            'data/diagonal_volcano.png'
          ])
          const png = readFileSync(join(dataRoot, 'diagonal_volcano.png'))
          expect(png.length).toBeGreaterThan(1000)
          outputs.push(png)
        } finally {
          child.kill()
        }
      }
      expect(outputs[1]).toEqual(outputs[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it('captures the RDS envelope and replays only preparation and the final plot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rds-envelope-native-'))
    const outputs: Buffer[] = []
    try {
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name),
          dataRoot = join(sessionRoot, 'data'),
          figures = join(sessionRoot, 'figures')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        mkdirSync(figures)
        const { child, send } = startLoop(
          rscriptBin(),
          { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
          dataRoot
        )
        try {
          const setup =
            await send(`samples<-c("CohortActrl1","CohortActrl2","CohortActrl4","CohortAsi1","CohortAsi2","CohortAsi5","CohortBctrl1","CohortBctrl2","CohortBctrl4","CohortBsi1","CohortBsi2","CohortBsi3")
values<-t(sapply(1:24,function(i) 5+i/10+(0:11 %% 3)*.05+ifelse(0:11 %in% 3:5,(i %% 4 >= 2)*1.5,ifelse(0:11 >= 9,(i %% 2)*1.4,0))))
dat<-data.frame(id=paste0("Gene",1:24),values,check.names=FALSE);names(dat)<-c("id",samples)
writeLines(paste(c("#group",rep(c("group1","group2"),each=6)),collapse=","),"inputs/expression-matrix-444444444444.csv")
write.table(dat,"inputs/expression-matrix-444444444444.csv",sep=",",row.names=FALSE,col.names=TRUE,append=TRUE,quote=FALSE)
openxlsx::write.xlsx(data.frame(id=dat$id,log2FoldChange=1:24/10,pvalue=.01),"inputs/differential-results-333333333333.xlsx")
set.seed(42)`)
          expect(setup.error).toBeNull()
          for (const index of [4, 8]) {
            if (index === 8 && name === 'original') {
              for (const failed of [5, 6]) {
                const result = await send(rdsEnvelopeCells[failed].script)
                expect(result.error).not.toBeNull()
              }
              expect((await send(rdsEnvelopeCells[7].script)).error).toBeNull()
            }
            // Match the captured RNG boundary; earlier plotting consumes randomness.
            expect((await send('set.seed(42)')).error).toBeNull()
            const script = rdsEnvelopeCells[index].script
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'r',
              code: script,
              runId: `${name}-${index}`
            })
            const result = await send(script)
            expect(result.error).toBeNull()
            const evidence = await observation.finish()
            expect(evidence.fileEvidence).toMatchObject(partialRColumnEvidence)
            expect(evidence.confirmedReadPaths).toBeUndefined()
            expect(evidence.workingFiles.map((f) => f.relativePath)).toEqual([
              index === 4 ? 'data/merged_diff_expr.rds' : 'data/diagonal_volcano.png'
            ])
          }
          outputs.push(readFileSync(join(dataRoot, 'diagonal_volcano.png')))
        } finally {
          child.kill()
        }
      }
      expect(outputs[1]).toEqual(outputs[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it('captures and replays marginal volcano inputs and patchwork output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marginal-volcano-native-'))
    const outputs: Buffer[] = []
    try {
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name),
          dataRoot = join(sessionRoot, 'data'),
          figures = join(sessionRoot, 'figures')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        mkdirSync(figures)
        const { child, send } = startLoop(
          rscriptBin(),
          { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
          dataRoot
        )
        try {
          const setup =
            await send(`samples<-c("CohortActrl1","CohortActrl2","CohortActrl4","CohortAsi1","CohortAsi2","CohortAsi5","CohortBctrl1","CohortBctrl2","CohortBctrl4","CohortBsi1","CohortBsi2","CohortBsi3")
values<-t(sapply(1:24,function(i) 5+i/10+(0:11 %% 3)*.05+ifelse(0:11 %in% 3:5,(i %% 4 >= 2)*1.5,ifelse(0:11 >= 9,(i %% 2)*1.4,0))))
dat<-data.frame(id=paste0("Gene",1:24),values,check.names=FALSE);names(dat)<-c("id",samples)
writeLines(paste(c("#group",rep(c("group1","group2"),each=6)),collapse=","),"inputs/expression-matrix-444444444444.csv")
write.table(dat,"inputs/expression-matrix-444444444444.csv",sep=",",row.names=FALSE,col.names=TRUE,append=TRUE,quote=FALSE)
openxlsx::write.xlsx(data.frame(id=dat$id,log2FoldChange=1:24/10,pvalue=.01),"inputs/differential-results-333333333333.xlsx")
set.seed(42)`)
          expect(setup.error).toBeNull()
          if (name === 'original') {
            const failure = await send(marginalVolcanoCells[8].script)
            expect(failure.error).toContain("'names' attribute")
          }
          const script = [9, 10, 11].map((index) => marginalVolcanoCells[index].script).join('\n')
          const observation = await startWorkingFileObservation({
            dataRoot,
            notebookSessionRoot: sessionRoot,
            cwd: dataRoot,
            language: 'r',
            code: script,
            runId: name
          })
          const response = await send(script)
          expect(response.error).toBeNull()
          const evidence = await observation.finish()
          expect(evidence.fileEvidence).toMatchObject({
            state: 'available',
            fileReads: 'complete',
            writerAttribution: 'complete',
            reasonCodes: []
          })
          expect(evidence.confirmedReadPaths?.sort()).toEqual(
            [
              'data/inputs/expression-matrix-444444444444.csv',
              'data/inputs/differential-results-333333333333.xlsx'
            ].sort()
          )
          expect(evidence.workingFiles.map((file) => file.relativePath)).toEqual([
            'data/diagonal_volcano_plot.png'
          ])
          const png = readFileSync(join(dataRoot, 'diagonal_volcano_plot.png'))
          expect(png.length).toBeGreaterThan(1000)
          outputs.push(png)
        } finally {
          child.kill()
        }
      }
      expect(outputs[1]).toEqual(outputs[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it('rebuilds and replays the cross-cell Welch pipeline after a failed classification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'welch-volcano-native-'))
    let captured: KernelLoopResponse['environmentOverlay']
    const outputs: Buffer[][] = []
    try {
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name)
        const dataRoot = join(sessionRoot, 'data')
        const figures = join(sessionRoot, 'figures')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        mkdirSync(figures)
        const samples = [
          'CohortActrl1',
          'CohortActrl2',
          'CohortActrl4',
          'CohortAsi1',
          'CohortAsi2',
          'CohortAsi5',
          'CohortBctrl1',
          'CohortBctrl2',
          'CohortBctrl4',
          'CohortBsi1',
          'CohortBsi2',
          'CohortBsi3'
        ]
        const rows: Array<Array<string | number>> = [
          ['#group', ...samples.map((_, j) => (j < 6 ? 'group1' : 'group2'))],
          ['id', ...samples],
          ...Array.from({ length: 20 }, (_, index) => {
            const i = index + 1
            return [
              `Gene${i}`,
              ...samples.map(
                (_, j) => i + (j % 3) * 0.1 + (j >= 3 && j < 6 ? i * 0.1 : j >= 9 ? i * 0.3 : 0)
              )
            ]
          })
        ]
        rows.push(rows[2], ['Constant', ...samples.map(() => 4)])
        writeFileSync(
          join(dataRoot, 'inputs/expression-matrix-444444444444.csv'),
          rows.map((row) => row.join(',')).join('\n') + '\n'
        )
        const { child, send } = startLoop(
          rscriptBin(),
          { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
          dataRoot
        )
        try {
          if (name === 'original') {
            const failed = await send(
              [2, 3, 4, 5].map((index) => welchVolcanoCells[index]!.script).join('\n')
            )
            expect(failed.error).toContain('case_when')
          }
          const script = [2, 3, 4, 6, 7].map((index) => welchVolcanoCells[index]!.script).join('\n')
          const observation = await startWorkingFileObservation({
            dataRoot,
            notebookSessionRoot: sessionRoot,
            cwd: dataRoot,
            language: 'r',
            code: script,
            runId: name
          })
          const response = await send(
            name === 'original'
              ? script
              : restoreRRandomState(script, captured?.executionContext?.before.rRandomState)
          )
          expect(response.error).toBeNull()
          if (name === 'original') captured = response.environmentOverlay
          expect(captured?.executionContext?.before.rRandomState?.state).toBe('available')
          const evidence = await observation.finish()
          expect(evidence.fileEvidence).toMatchObject({
            state: 'available',
            fileReads: 'complete',
            writerAttribution: 'complete',
            reasonCodes: []
          })
          expect(evidence.confirmedReadPaths).toEqual([
            'data/inputs/expression-matrix-444444444444.csv'
          ])
          expect(evidence.workingFiles.map((file) => file.relativePath).sort()).toEqual(
            ['data/diagonal_volcano.png', 'data/diagonal_volcano_diff.csv'].sort()
          )
          const csv = readFileSync(join(dataRoot, 'diagonal_volcano_diff.csv'))
          expect(csv.toString()).toContain('CohortA_log2FoldChange')
          expect(csv.toString()).toContain('Constant')
          const png = readFileSync(join(dataRoot, 'diagonal_volcano.png'))
          expect(png.length).toBeGreaterThan(1000)
          outputs.push([csv, png])
        } finally {
          child.kill()
        }
      }
      expect(outputs[1]).toEqual(outputs[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it('captures bounded R random state before and after each cell', async () => {
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      await send('set.seed(123)')
      const first = await send('cat(runif(5))')
      const context = first.environmentOverlay?.executionContext
      expect(context?.before).toHaveProperty('rRandomState.state', 'available')
      expect(context?.after).toHaveProperty('rRandomState.state', 'available')
      expect(context?.before).not.toEqual(context?.after)
    } finally {
      child.kill()
    }
  })

  it.skipIf(!process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'captures Excel to RDS to PNG across cells and replays in a fresh kernel',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'rds-chord-replay-'))
      const plot = rdsChordCells[4]!.script.replace('circos.par(', 'circos.clear()\ncircos.par(')
      const hashes: Buffer[][] = []
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name)
          const dataRoot = join(sessionRoot, 'data')
          const figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          execFileSync(
            process.env.OPEN_SCIENCE_TEST_PYTHON!,
            [
              '-c',
              'import pandas as pd; pd.DataFrame([(f"Gene{i}",f"S{j}",float(i+j)) for i in range(1,7) for j in range(1,11)],columns=["from","to","value"]).to_excel("inputs/edge-weights-222222222222.xlsx",index=False)'
            ],
            { cwd: dataRoot, timeout: 20_000 }
          )
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          try {
            if (name === 'original')
              expect((await send(rdsChordCells[2]!.script)).error).toContain('mixedsort')
            for (const [index, script] of [
              rdsChordCells[3]!.script,
              `set.seed(42)\n${plot}`
            ].entries()) {
              const observation = await startWorkingFileObservation({
                dataRoot,
                notebookSessionRoot: sessionRoot,
                cwd: dataRoot,
                language: 'r',
                code: script,
                runId: `${name}-${index}`
              })
              const response = await send(script)
              expect(response.error).toBeNull()
              const evidence = await observation.finish()
              expect(evidence.fileEvidence).toMatchObject(partialRColumnEvidence)
              expect(evidence.confirmedReadPaths).toBeUndefined()
              expect(evidence.workingFiles.map((file) => file.relativePath)).toEqual([
                index === 0 ? 'data/chord_matrix.rds' : 'data/chord_diagram.png'
              ])
            }
            // Only the tiny synthetic test outputs are read here, never user RDS data.
            hashes.push(
              ['chord_matrix.rds', 'chord_diagram.png'].map((file) =>
                readFileSync(join(dataRoot, file))
              )
            )
          } finally {
            child.kill()
          }
        }
        expect(hashes[1]).toEqual(hashes[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000
  )

  it('captures equivalent R pipelines through path construction, reads, callbacks and writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-pipe-equivalence-'))
    const results: Buffer[][] = []
    const direct = `file_path <- file.path("inputs", "source.csv")
df <- read.csv(file_path)
out <- subset(df, value > 0)
values <- as.character(na.omit(out$value))
sets <- lapply(list(A=values, B=c("2","3")), unique)
joined <- Reduce(union, sets)
writeLines(joined, con="out.txt")
write.csv(out, file="out.csv", row.names=FALSE)`
    const piped = `file_path <- "inputs" |> file.path("source.csv")
df <- file_path |> read.csv()
out <- df |> subset(value > 0)
values <- out$value |> na.omit() |> as.character()
sets <- list(A=values, B=c("2","3")) |> lapply(unique)
joined <- sets |> Reduce(f=union)
joined |> writeLines(con="out.txt")
out |> write.csv(file="out.csv", row.names=FALSE)`
    try {
      for (const [index, source] of [direct, piped, piped.replaceAll('|>', '%>%')].entries()) {
        const sessionRoot = join(root, String(index)),
          dataRoot = join(sessionRoot, 'data')
        mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
        writeFileSync(join(dataRoot, 'inputs/source.csv'), 'value\n1\n2\nNA\n-1\n')
        const script = `library(magrittr)\n${source}`
        const { child, send } = startLoop(rscriptBin(), {}, dataRoot)
        try {
          const observation = await startWorkingFileObservation({
            dataRoot,
            notebookSessionRoot: sessionRoot,
            cwd: dataRoot,
            language: 'r',
            code: script,
            runId: `pipe-${index}`
          })
          const response = await send(script)
          expect(response.error).toBeNull()
          const evidence = await observation.finish()
          expect(evidence.fileEvidence).toMatchObject({
            state: 'available',
            fileReads: 'complete',
            writerAttribution: 'complete',
            reasonCodes: []
          })
          expect(evidence.confirmedReadPaths).toEqual(['data/inputs/source.csv'])
          expect(evidence.workingFiles.map((f) => f.relativePath).sort()).toEqual([
            'data/out.csv',
            'data/out.txt'
          ])
          results.push(['out.csv', 'out.txt'].map((file) => readFileSync(join(dataRoot, file))))
        } finally {
          child.kill()
        }
      }
      expect(results[1]).toEqual(results[0])
      expect(results[2]).toEqual(results[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120000)

  it.each([
    {
      label: 'Venn preparation',
      cells: vennCells,
      original: [0, 1, 2, 3],
      replay: [2, 3],
      dependencies: [2],
      inputCells: [0, 1, 2],
      partialCells: [],
      failedCells: [],
      outputs: ['proportional_venn_5sets.png']
    },
    {
      label: 'Venn string cleaning',
      cells: mixedVennCells,
      original: [2],
      replay: [2],
      dependencies: [],
      inputCells: [2],
      partialCells: [],
      failedCells: [],
      outputs: ['venn_5sets.png']
    },
    {
      label: 'VennDiagram device recovery',
      cells: vennDeviceCells,
      original: [11],
      replay: [11],
      dependencies: [],
      inputCells: [11],
      partialCells: [],
      failedCells: [],
      outputs: ['venn_5sets_proportional.png'],
      logPrefix: 'data/venn_5sets_proportional.png.'
    },
    {
      label: 'Venn namespace probe and region export recovery',
      cells: vennRegionCells,
      original: [0, 1, 2, 3, 4, 5, 6],
      replay: [5, 6],
      dependencies: [],
      inputCells: [0, 1, 3, 4, 5, 6],
      partialCells: [4],
      failedCells: [4],
      outputs: ['proportional_venn_diagram.png'],
      earlyOutputs: ['venn_5set.png'],
      previousOutput: 'venn_intersections.csv',
      byteOutputs: ['proportional_venn_diagram.png', 'venn_intersections.csv']
    },
    {
      label: 'Venn conditional intersection reporting',
      cells: vennRegionChainCells.slice(2).map((cell) => cell.script),
      original: [0, 1, 2],
      replay: [0, 1, 2],
      dependencies: [0, 1],
      inputCells: [0],
      partialCells: [],
      failedCells: [],
      outputs: ['proportional_venn_5sets.png']
    },
    {
      label: 'Venn font-error recovery with captured formatting',
      cells: [readFileSync(join(__dirname, 'reported-venn-font-recovery.R'), 'utf8')],
      original: [0],
      replay: [0],
      dependencies: [],
      inputCells: [0],
      partialCells: [],
      columnPartialCells: [0],
      failedCells: [],
      outputs: ['proportional_venn_5sets.png']
    },
    {
      label: 'Venn captured-column callback and CSV export recovery',
      cells: [readFileSync(join(__dirname, 'reported-venn-export-recovery.R'), 'utf8')],
      original: [0],
      replay: [0],
      dependencies: [],
      inputCells: [0],
      partialCells: [],
      columnPartialCells: [0],
      failedCells: [],
      outputs: ['proportional_venn_5sets.png', 'venn_region_counts.csv']
    },
    {
      label: 'Venn formatting across cells',
      cells: [
        'options(scipen=999)',
        readFileSync(join(__dirname, 'reported-venn-font-recovery.R'), 'utf8').replace(
          'options(scipen = 999)',
          ''
        )
      ],
      original: [0, 1],
      replay: [0, 1],
      dependencies: [0],
      inputCells: [1],
      partialCells: [],
      columnPartialCells: [1],
      failedCells: [],
      outputs: ['proportional_venn_5sets.png']
    },
    {
      label: 'Venn mapped regions across cells',
      cells: [
        'library(readxl);library(ggVennDiagram);df<-read_excel("inputs/set-membership-111111111111.xlsx",sheet="5 groups");sets<-lapply(df,function(x) unique(na.omit(x)))',
        'unrelated<-42',
        'tables<-lapply(list(sets),function(x) process_region_data(Venn(x)));write.csv(tables[[1]][c("id","name","count")],"regions.csv",row.names=FALSE)'
      ],
      original: [0, 1, 2],
      replay: [0, 2],
      dependencies: [0],
      inputCells: [0],
      partialCells: [],
      failedCells: [],
      outputs: ['regions.csv']
    },
    {
      label: 'Venn distiller scales',
      cells: vennCounterCells,
      original: [2],
      replay: [2],
      dependencies: [],
      inputCells: [2],
      partialCells: [],
      failedCells: [],
      outputs: ['venn_5sets.png', 'venn_5sets.pdf'],
      byteOutputs: ['venn_5sets.png']
    },
    {
      label: 'Venn layer fonts after a failed theme change',
      cells: vennLayerCells,
      original: [0, 1, 2, 3, 4, 5, 6],
      replay: [6],
      dependencies: [],
      inputCells: [0, 1, 2, 4, 5, 6],
      partialCells: [2, 3, 4],
      failedCells: [4],
      outputs: ['proportional_venn_5sets.png', 'proportional_venn_5sets_hires.png']
    },
    {
      label: 'Venn partition recovery',
      cells: vennPartitionCells,
      original: [0, 1, 2, 3, 4, 5, 6],
      replay: [5, 6],
      dependencies: [],
      inputCells: [0, 1, 3, 4, 5, 6],
      partialCells: [2, 4],
      failedCells: [4],
      outputs: ['venn_proportional_5sets.png', 'venn_proportional_5sets.pdf'],
      earlyOutputs: ['venn_proportional_5sets.png', 'venn_proportional_5sets.pdf'],
      previousOutput: 'venn_region_counts.csv',
      // PDF metadata contains wall-clock timestamps; compare PNG/CSV bytes and
      // separately verify PDF capture and generation in both fresh kernels.
      byteOutputs: ['venn_proportional_5sets.png', 'venn_region_counts.csv']
    }
  ])(
    'captures $label and replays its outputs without the inspection cells',
    async (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'venn-native-'))
      const outputs: Buffer[][] = []
      try {
        for (const name of ['original', 'replay']) {
          const sessionRoot = join(root, name),
            dataRoot = join(sessionRoot, 'data'),
            figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          if (name === 'original') {
            // The fixture is synthetic and created outside the Notebook kernel so
            // neither preparation nor replay inherits workbook-generation variables.
            execFileSync(
              rscriptBin(),
              [
                '-e',
                'openxlsx::write.xlsx(data.frame(A=c("a","b","c",NA),B=c("b","d",NA,NA),C=c("a","e","f",NA),D=c("b","e",NA,NA),E=c("a","d","g","h")),"inputs/set-membership-111111111111.xlsx",sheetName="5 groups")'
              ],
              { cwd: dataRoot, timeout: 20000 }
            )
          } else
            cpSync(join(root, 'original/data/inputs'), join(dataRoot, 'inputs'), {
              recursive: true
            })
          const { child, send } = startLoop(
            rscriptBin(),
            { OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures },
            dataRoot
          )
          const runs: NotebookRunRecord[] = []
          const analyzer = createNotebookDependencyAnalyzer({
            storageRoot: sessionRoot,
            repository: { readSessionRuns: async () => runs }
          })
          try {
            for (const index of name === 'original' ? scenario.original : scenario.replay) {
              const script = scenario.cells[index]
              const runId = `${name}-${index}`
              const sourceFileAccessContext = await analyzer.sourceFileAccessContext({
                projectId: 'p',
                sessionId: name,
                currentRunId: runId,
                language: 'r',
                environment: 'r',
                kernelEpochId: name
              })
              const observation = await startWorkingFileObservation({
                dataRoot,
                notebookSessionRoot: sessionRoot,
                cwd: dataRoot,
                language: 'r',
                code: script,
                runId,
                sourceFileAccessContext
              })
              const response = await send(script)
              const failed = scenario.failedCells.some((failedIndex) => failedIndex === index)
              if (failed) expect(response.error, `cell ${index}`).not.toBeNull()
              else expect(response.error, `cell ${index}`).toBeNull()
              const evidence = await observation.finish()
              if (!scenario.partialCells.some((partialIndex) => partialIndex === index)) {
                expect(evidence.fileEvidence, `cell ${index}`).toMatchObject(
                  scenario.columnPartialCells?.some((cell) => cell === index)
                    ? partialRColumnEvidence
                    : {
                        state: 'available',
                        fileReads: 'complete',
                        writerAttribution: 'complete',
                        reasonCodes: []
                      }
                )
                expect(
                  scenario.columnPartialCells?.some((cell) => cell === index)
                    ? evidence.confirmedReadPaths
                    : (evidence.confirmedReadPaths ?? [])
                ).toEqual(
                  scenario.columnPartialCells?.some((cell) => cell === index)
                    ? undefined
                    : scenario.inputCells.includes(index)
                      ? ['data/inputs/set-membership-111111111111.xlsx']
                      : []
                )
                const files = evidence.workingFiles.map((file) => file.relativePath)
                if (scenario.logPrefix) {
                  const logs = files.filter(
                    (path) => path.startsWith(scenario.logPrefix!) && path.endsWith('.log')
                  )
                  expect(logs).toHaveLength(1)
                  expect(readFileSync(join(sessionRoot, logs[0]!), 'utf8')).toContain('filename')
                }
                expect(
                  files
                    .filter((path) => !scenario.logPrefix || !path.startsWith(scenario.logPrefix))
                    .sort()
                ).toEqual(
                  index === scenario.replay.at(-1)
                    ? scenario.outputs.map((file) => `data/${file}`).sort()
                    : index === 5
                      ? [`data/${scenario.previousOutput ?? 'proportional_venn_5sets.png'}`]
                      : index === 3
                        ? (scenario.earlyOutputs ?? []).map((file) => `data/${file}`).sort()
                        : []
                )
              }
              runs.push({
                runId,
                cellId: String(index),
                source: 'agent',
                kernelKind: 'r',
                kernelEpochId: name,
                environment: 'r',
                script,
                status: failed ? 'failed' : 'completed',
                kernelDispatched: true,
                startedAt: index,
                endedAt: index + 1,
                text: { stdout: response.stdout, stderr: '', traceback: '', plain: [] },
                outputs: [],
                workingFiles: [],
                environmentManifest: {
                  schemaVersion: 1,
                  captureKind: 'completed-run',
                  capturedAt: '2026-09-09T00:00:00Z',
                  installedInventory: {
                    capturedAt: '2026-09-09T00:00:00Z',
                    source: 'full-scan',
                    validation: 'full-scan'
                  },
                  kernelKind: 'r',
                  environmentName: 'r',
                  runtimeSource: 'managed',
                  inventorySources: ['kernel-native'],
                  packages: response.environmentOverlay?.packages ?? [],
                  complete: true,
                  captureStatus: 'complete',
                  executionContext: response.environmentOverlay?.executionContext
                }
              })
            }
            const projection = await analyzer.project({
              projectId: 'p',
              sessionId: name,
              throughRunId: `${name}-${scenario.replay.at(-1)}`
            })
            expect(projection.stalenessByRunId[`${name}-${scenario.replay.at(-1)}`]).toEqual(
              scenario.columnPartialCells?.length
                ? { state: 'unknown', reasons: ['external-state', 'opaque-call'] }
                : { state: 'clear' }
            )
            expect(projection.dependenciesByRunId?.[`${name}-${scenario.replay.at(-1)}`]).toEqual(
              scenario.columnPartialCells?.length
                ? undefined
                : scenario.dependencies.map((index) => `${name}-${index}`)
            )
            for (const file of scenario.outputs.filter((file) => file.endsWith('.pdf'))) {
              const pdf = readFileSync(join(dataRoot, file))
              expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
              expect(pdf.length).toBeGreaterThan(1000)
            }
            outputs.push(
              (scenario.byteOutputs ?? scenario.outputs).map((file) =>
                readFileSync(join(dataRoot, file))
              )
            )
          } finally {
            child.kill()
          }
        }
        for (const output of outputs[0]) expect(output.length).toBeGreaterThan(100)
        expect(outputs[1]).toEqual(outputs[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    120000
  )

  it('replays only required package and variable cells in a fresh R kernel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r-package-cell-replay-'))
    const originalDir = join(root, 'original')
    const replayDir = join(root, 'replay')
    mkdirSync(originalDir)
    mkdirSync(replayDir)
    const original = startLoop(rscriptBin(), {}, originalDir)
    const replay = startLoop(rscriptBin(), {}, replayDir)
    try {
      const scripts = [
        'library(RColorBrewer)',
        'unrelated <- 99',
        'n <- 3',
        'palette <- brewer.pal(n, "Set1"); writeLines(palette, "palette.txt")'
      ]
      const runs: NotebookRunRecord[] = []
      for (const [index, script] of scripts.entries()) {
        const response = await original.send(script)
        expect(response.error).toBeNull()
        expect(response.environmentOverlay?.executionContext?.rPackages?.complete).toBe(true)
        runs.push({
          runId: `run-${index}`,
          cellId: `cell-${index}`,
          source: 'agent',
          kernelKind: 'r',
          kernelEpochId: 'original',
          environment: 'default-r',
          script,
          status: 'completed',
          kernelDispatched: true,
          startedAt: index,
          endedAt: index + 1,
          text: { stdout: response.stdout, stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: [],
          environmentManifest: {
            schemaVersion: 1,
            captureKind: 'completed-run',
            capturedAt: '2026-09-09T00:00:00Z',
            installedInventory: {
              capturedAt: '2026-09-09T00:00:00Z',
              source: 'full-scan',
              validation: 'full-scan'
            },
            kernelKind: 'r',
            environmentName: 'default-r',
            runtimeSource: 'managed',
            inventorySources: ['kernel-native'],
            packages: response.environmentOverlay?.packages ?? [],
            complete: true,
            captureStatus: 'complete',
            executionContext: response.environmentOverlay?.executionContext
          }
        })
      }
      const analyzer = createNotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const projection = await analyzer.project({
        projectId: 'p',
        sessionId: 's',
        completedRun: runs[3]!
      })
      expect(projection.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
      expect(projection.dependenciesByRunId?.['run-3']).toEqual(['run-0', 'run-2'])
      for (const index of [0, 2, 3]) expect((await replay.send(scripts[index]!)).error).toBeNull()
      expect(readFileSync(join(replayDir, 'palette.txt'))).toEqual(
        readFileSync(join(originalDir, 'palette.txt'))
      )
      // Re-loading the projection from disk must preserve package-based edges.
      const reopened = createNotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      expect(
        (await reopened.project({ projectId: 'p', sessionId: 's', completedRun: runs[3]! }))
          .dependenciesByRunId
      ).toEqual(projection.dependenciesByRunId)
    } finally {
      original.child.kill()
      replay.child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([
    {
      label: 'active function',
      binding:
        'makeActiveBinding("foo", function(value) { state$n <- state$n + 1L; function() state$n }, .GlobalEnv)',
      code: 'foo()',
      output: '[1] 1',
      count: '1',
      error: false
    },
    {
      label: 'unreached active function',
      binding:
        'makeActiveBinding("foo", function(value) { state$n <- state$n + 1L; stop("binding failed") }, .GlobalEnv)',
      code: 'if (FALSE) foo()',
      output: '',
      count: '0',
      error: false
    },
    {
      label: 'unreached lazy function',
      binding:
        'delayedAssign("foo", { state$n <- state$n + 1L; stop("binding failed") }, assign.env = .GlobalEnv)',
      code: 'if (FALSE) foo()',
      output: '',
      count: '0',
      error: false
    },
    {
      label: 'throwing active function',
      binding:
        'makeActiveBinding("foo", function(value) { state$n <- state$n + 1L; stop("binding failed") }, .GlobalEnv)',
      code: 'foo()',
      output: '',
      count: '1',
      error: true
    },
    {
      label: 'throwing lazy function',
      binding:
        'delayedAssign("foo", { state$n <- state$n + 1L; stop("binding failed") }, assign.env = .GlobalEnv)',
      code: 'foo()',
      output: '',
      count: '1',
      error: true
    }
  ])(
    'keeps checkpoint observation passive for $label without checkpoint requests',
    async ({ binding, code, output, count, error }) => {
      const root = mkdtempSync(join(tmpdir(), 'r-passive-checkpoint-observer-'))
      const loop = startLoop(rscriptBin(), {}, root, true)
      try {
        expect((await loop.send(`state <- new.env(); state$n <- 0L; ${binding}`)).error).toBeNull()
        const result = await loop.send(code)
        expect(result.stdout).toBe(output)
        if (error) expect(result.error).toContain('binding failed')
        else expect(result.error).toBeNull()
        expect((await loop.send('cat(state$n)')).stdout).toBe(count)
        const refused = await loop.stage('x <- 1', {
          stage_checkpoint: {
            input_path: join(root, 'input.rds'),
            output_path: join(root, 'output.rds')
          }
        })
        expect(refused.stageCheckpointCapture).toMatchObject({
          state: 'unavailable',
          reason: expect.stringMatching(/^unsupported-method-history:/)
        })
        expect((await loop.send('cat(state$n)')).stdout).toBe(count)
      } finally {
        loop.child.stdin.end()
        await once(loop.child, 'exit')
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it('captures ordered package bindings across cells without forcing user bindings', async () => {
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      const setup = await send('library(dplyr); library(splines)')
      expect(setup.error).toBeNull()
      const loaded = setup.environmentOverlay?.executionContext?.rPackages
      expect(loaded?.after.slice(0, 2)).toEqual(['splines', 'dplyr'])
      const used = await send('result <- filter(data.frame(x=1:3), x>1); basis <- ns(1:10, df=3)')
      expect(used.error).toBeNull()
      expect(used.environmentOverlay?.executionContext?.rPackages).toMatchObject({
        complete: true,
        reads: expect.arrayContaining([
          { name: 'filter', package: 'dplyr' },
          { name: 'ns', package: 'splines' }
        ])
      })
      const removed = await send('detach("package:dplyr"); result <- filter(1:3, rep(1,3))')
      expect(removed.error).toBeNull()
      expect(removed.environmentOverlay?.executionContext?.rPackages?.after).not.toContain('dplyr')
      expect(removed.environmentOverlay?.executionContext?.rPackages?.reads).toContainEqual({
        name: 'filter',
        package: 'stats'
      })
      const guarded = await send(
        'makeActiveBinding("active_probe", function() stop("forced active binding"), globalenv()); delayedAssign("lazy_probe", stop("forced promise")); if (FALSE) { active_probe(); lazy_probe() }'
      )
      expect(guarded.error).toBeNull()
      expect(guarded.environmentOverlay?.executionContext?.rPackages?.complete).toBe(true)
      expect(JSON.stringify(guarded.environmentOverlay?.executionContext?.rPackages)).not.toContain(
        'forced'
      )
    } finally {
      child.kill()
    }
  }, 60_000)

  it('bounds package binding observation and reports truncation', async () => {
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      const result = await send(Array.from({ length: 1500 }, () => 'invisible(1 + 1)').join('\n'))
      expect(result.error).toBeNull()
      expect(result.environmentOverlay?.executionContext?.rPackages?.complete).toBe(false)
    } finally {
      child.kill()
    }
  }, 60_000)

  it('captures execution context before and after a cell without copying credentials', async () => {
    const { child, send } = startLoop(rscriptBin(), {
      OMP_NUM_THREADS: '2',
      OPEN_SCIENCE_TEST_SECRET: 'private-value'
    })
    try {
      const result = await send('Sys.setenv(OMP_NUM_THREADS = "3")')
      expect(result.error).toBeNull()
      expect(result.environmentOverlay?.executionContext?.before.threadLimits.OMP_NUM_THREADS).toBe(
        '2'
      )
      expect(result.environmentOverlay?.executionContext?.after.threadLimits.OMP_NUM_THREADS).toBe(
        '3'
      )
      expect(JSON.stringify(result.environmentOverlay?.executionContext)).not.toContain(
        'private-value'
      )
    } finally {
      child.kill()
    }
  }, 60_000)
  it('keeps the loaded R namespace identity when library search paths change', async () => {
    const library = mkdtempSync(join(tmpdir(), 'r-library-shadow-'))
    cpSync(join(rEnvPrefix!, 'lib/R/library/RColorBrewer'), join(library, 'RColorBrewer'), {
      recursive: true
    })
    const description = join(library, 'RColorBrewer/DESCRIPTION')
    writeFileSync(
      description,
      readFileSync(description, 'utf8').replace(/^Version:.*$/mu, 'Version: 99.0')
    )
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      const original = await send(
        'loadNamespace("RColorBrewer"); original_version <- as.character(getNamespaceVersion("RColorBrewer"))'
      )
      expect(original.error).toBeNull()
      const observed = original.environmentOverlay?.packages.find(
        (pkg) => pkg.name === 'RColorBrewer'
      )
      expect(observed?.version).toBeTruthy()
      const reordered = await send(
        `.libPaths(c(${JSON.stringify(library)}, .libPaths())); stopifnot(as.character(getNamespaceVersion("RColorBrewer")) == original_version)`
      )
      expect(reordered.error).toBeNull()
      expect(reordered.environmentOverlay?.packages).toContainEqual(
        expect.objectContaining({
          name: 'RColorBrewer',
          version: observed!.version,
          libraryScope: 'environment',
          loadedState: 'loaded'
        })
      )
    } finally {
      child.kill()
      rmSync(library, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures the actual library scope after loading a package from another library', async () => {
    const library = mkdtempSync(join(tmpdir(), 'r-live-library-'))
    cpSync(join(rEnvPrefix!, 'lib/R/library/RColorBrewer'), join(library, 'RColorBrewer'), {
      recursive: true
    })
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      const result = await send(
        `.libPaths(c(${JSON.stringify(library)}, .libPaths())); library(RColorBrewer)`
      )
      expect(result.error).toBeNull()
      expect(result.environmentOverlay?.packages).toContainEqual(
        expect.objectContaining({
          name: 'RColorBrewer',
          libraryRank: 1,
          libraryScope: 'system',
          loadedState: 'attached'
        })
      )
      expect(result.environmentOverlay?.packages).toContainEqual(
        expect.objectContaining({
          name: 'base',
          libraryScope: 'environment'
        })
      )
    } finally {
      child.kill()
      rmSync(library, { recursive: true, force: true })
    }
  }, 60_000)
  it('distinguishes unused packages from dynamically loaded namespaces', async () => {
    const { child, send } = startLoop(join(rEnvPrefix!, 'bin', 'Rscript'), {})
    try {
      const unused = await send('1 + 1')
      expect(unused.error).toBeNull()
      expect(unused.environmentOverlay?.packages).toContainEqual(
        expect.objectContaining({
          name: 'splines',
          loadedState: 'installed-only'
        })
      )
      const childUse = await send(
        'system2(file.path(R.home("bin"), "Rscript"), c("-e", shQuote("invisible(NULL)")))'
      )
      expect(childUse.error).toBeNull()
      expect(childUse.environmentOverlay?.packages).toContainEqual(
        expect.objectContaining({
          name: 'splines',
          loadedState: 'unknown'
        })
      )
      const used = await send('loadNamespace("splines")')
      expect(used.error).toBeNull()
      expect(used.environmentOverlay?.packages).toContainEqual(
        expect.objectContaining({
          name: 'splines',
          loadedState: 'loaded'
        })
      )
    } finally {
      child.kill()
    }
  }, 60_000)

  it('returns bounded binding metadata without evaluating any binding values', async () => {
    const { child, send, inspect } = startLoop(rscriptBin(), {})
    try {
      await send(
        "forced <- FALSE; x <- 41L; label <- 'active value'; .private <- 'hidden'; 1L -> run; 'user con' ->> con; " +
          'items <- seq_len(100000L); blob <- raw(2000000L); huge_label <- strrep("€", 1000000L); ' +
          'makeActiveBinding("active_value", function() stop("must not evaluate"), .GlobalEnv); ' +
          'delayedAssign("lazy_value", stop("must not force"), assign.env = .GlobalEnv); ' +
          'create_lazy <- base::delayedAssign; ' +
          'create_lazy("indirect_lazy", stop("must not force"), assign.env = .GlobalEnv); ' +
          'create_lazy("x", { forced <<- TRUE; 42L }, assign.env = .GlobalEnv); ' +
          'assign("indirect_eager", 99L, envir = .GlobalEnv)'
      )
      const first = await inspect()
      expect(first.namespace?.variables.map(({ name }) => name)).toEqual([
        'active_value',
        'blob',
        'con',
        'create_lazy',
        'forced',
        'huge_label',
        'indirect_eager',
        'indirect_lazy',
        'items',
        'label',
        'lazy_value',
        'run',
        'x'
      ])
      expect(first.namespace?.variables.find(({ name }) => name === 'label')).toMatchObject({
        type: 'binding',
        preview: ''
      })
      expect(first.namespace?.variables.find(({ name }) => name === 'x')).toMatchObject({
        type: 'binding',
        preview: ''
      })
      expect(first.namespace?.variables.find(({ name }) => name === 'active_value')).toMatchObject({
        type: 'active binding',
        preview: ''
      })
      expect(first.namespace?.variables.find(({ name }) => name === 'lazy_value')).toMatchObject({
        type: 'lazy binding',
        preview: ''
      })
      expect(first.namespace?.variables.find(({ name }) => name === 'indirect_lazy')).toMatchObject(
        {
          type: 'binding',
          preview: ''
        }
      )
      expect(
        first.namespace?.variables.find(({ name }) => name === 'indirect_eager')
      ).toMatchObject({
        type: 'binding',
        preview: ''
      })
      expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(256 * 1024)
      expect((await send('forced')).stdout).toContain('FALSE')

      await send(
        'x <- 42L; rm(label); added <- list(ok = TRUE); lazy_value <- 7L; ' +
          'indirect_lazy <- 9L; indirect_eager <- 100L'
      )
      const refreshed = await inspect(true)
      // R sorts with the host's LC_COLLATE; compare membership in a fixed JS order.
      expect(refreshed.namespace?.variables.map(({ name }) => name).sort()).toEqual([
        '.Random.seed',
        '.private',
        'active_value',
        'added',
        'blob',
        'con',
        'create_lazy',
        'forced',
        'huge_label',
        'indirect_eager',
        'indirect_lazy',
        'items',
        'lazy_value',
        'run',
        'x'
      ])
      expect(refreshed.namespace?.variables.find(({ name }) => name === 'x')).toMatchObject({
        type: 'binding',
        preview: ''
      })
      expect(
        refreshed.namespace?.variables.find(({ name }) => name === 'lazy_value')
      ).toMatchObject({ type: 'binding', preview: '' })
      expect(refreshed.namespace?.variables.find(({ name }) => name === '.private')).toMatchObject({
        private: true
      })
    } finally {
      child.kill()
    }
  }, 60_000)

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

  it.skipIf(process.platform === 'win32')(
    'acknowledges SIGINT before two subsequent requests and preserves the namespace',
    async () => {
      const { child, send } = startLoop(rscriptBin(), {})
      try {
        expect((await send('cancel_state <- 41'))?.error).toBeNull()
        const sleeping = send('Sys.sleep(30)')
        await new Promise((resolve) => setTimeout(resolve, 100))

        child.kill('SIGINT')

        const interrupted = await sleeping
        expect(interrupted.error).toBe('interrupted')
        expect(interrupted.interruptAck).toBe(true)
        const first = await send('cancel_state + 1')
        const second = await send('cancel_state + 2')
        expect(first.error).toBeNull()
        expect(first.stdout).toContain('42')
        expect(second.error).toBeNull()
        expect(second.stdout).toContain('43')
      } finally {
        child.kill()
      }
    },
    60_000
  )

  it('does not skip the next request when user code assigns interrupt_during_read', async () => {
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      expect((await send('interrupt_during_read <- TRUE; during_read <- TRUE')).error).toBeNull()
      const next = await send('cat(40 + 2)')
      expect(next.error).toBeNull()
      expect(next.stdout).toContain('42')
      expect(next.interruptAck).not.toBe(true)
    } finally {
      child.kill()
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')(
    'keeps the protocol aligned when SIGINT arrives in the middle of a framed body',
    async () => {
      const { child, send, waitFor } = startLoop(rscriptBin(), {})
      try {
        expect((await send('aligned <- 41'))?.error).toBeNull()
        const reqId = randomUUID()
        const frame = frameRRequest(reqId, 'cat("split-ok")')
        const mid = Math.max(1, Math.floor(frame.length / 2))
        const pending = waitFor(reqId)
        child.stdin.write(frame.subarray(0, mid))
        child.kill('SIGINT')
        await new Promise((resolve) => setTimeout(resolve, 20))
        child.stdin.write(frame.subarray(mid))

        const split = await pending
        expect(split.error === 'interrupted' || split.stdout.includes('split-ok')).toBe(true)
        const next = await send('cat(aligned + 1)')
        expect(next.error).toBeNull()
        expect(next.stdout).toContain('42')
      } finally {
        child.kill()
      }
    },
    60_000
  )

  it.skipIf(process.platform === 'win32')(
    'acknowledges SIGINT that arrives while the next request is still being read',
    async () => {
      const { child, send } = startLoop(rscriptBin(), {})
      try {
        expect((await send('cancel_state <- 41'))?.error).toBeNull()
        const sleeping = send('Sys.sleep(30)')
        child.kill('SIGINT')

        const interrupted = await sleeping
        expect(interrupted.error).toBe('interrupted')
        expect(interrupted.interruptAck).toBe(true)
        const next = await send('cat(cancel_state + 1)')
        expect(next.error).toBeNull()
        expect(next.stdout).toContain('42')
      } finally {
        child.kill()
      }
    },
    60_000
  )

  it.each(['file.link', 'file.symlink'] as const)(
    'blocks %s aliases sourced from the managed runtime',
    async (operation) => {
      const parent = mkdtempSync(join(tmpdir(), 'os-r-link-'))
      const runtimeRoot = join(parent, 'runtime')
      const workspace = join(parent, 'workspace')
      mkdirSync(runtimeRoot)
      mkdirSync(workspace)
      const source = join(runtimeRoot, 'protected.txt')
      const alias = join(workspace, 'alias.txt')
      const linkSource = operation === 'file.symlink' ? relative(workspace, source) : source
      writeFileSync(source, 'protected')
      const { child, send } = startLoop(rscriptBin(), {
        OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot
      })
      try {
        const result = await send(
          `${operation}(${JSON.stringify(linkSource)}, ${JSON.stringify(alias)}); ` +
            `writeLines('changed', ${JSON.stringify(alias)})`
        )

        expect(result.error).toMatch(/manage_packages/)
        expect(readFileSync(source, 'utf8')).toBe('protected')
        expect(existsSync(alias)).toBe(false)
      } finally {
        child.kill()
        rmSync(parent, { recursive: true, force: true })
      }
    },
    60_000
  )

  it.skipIf(process.platform === 'win32')(
    'uses system2 write targets so copy-out and workspace writes remain allowed',
    async () => {
      const runtimeRoot = mkdtempSync(join(tmpdir(), 'os-r-child-runtime-'))
      const workspace = mkdtempSync(join(tmpdir(), 'os-r-child-output-'))
      const source = join(runtimeRoot, 'source.txt')
      const copied = join(workspace, 'copied.txt')
      const outputDir = join(workspace, 'created')
      writeFileSync(source, 'runtime input')
      const { child, send } = startLoop(rscriptBin(), {
        OPEN_SCIENCE_RUNTIME_DIR: runtimeRoot
      })
      try {
        const copyOut = await send(
          `system2("cp", c(${JSON.stringify(source)}, ${JSON.stringify(copied)}))`
        )
        expect(copyOut.error).toBeNull()
        expect(readFileSync(copied, 'utf8')).toBe('runtime input')

        const shellPayload =
          `printf '%s' "$OPEN_SCIENCE_RUNTIME_DIR" >/dev/null; ` +
          `mkdir ${JSON.stringify(outputDir)}`
        const workspaceWrite = await send(
          `system2("sh", c("-c", shQuote(${JSON.stringify(shellPayload)})))`
        )
        expect(workspaceWrite.error).toBeNull()
        expect(existsSync(outputDir)).toBe(true)

        const blocked = await send(
          `system2("cp", c(${JSON.stringify(copied)}, ` +
            `${JSON.stringify(join(runtimeRoot, 'blocked.txt'))}))`
        )
        expect(blocked.error).toMatch(/manage_packages/)
      } finally {
        child.kill()
        rmSync(runtimeRoot, { recursive: true, force: true })
        rmSync(workspace, { recursive: true, force: true })
      }
    },
    60_000
  )

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

  it('captures every base graphics page produced by one run', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-multiple-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const result = await send('plot(1:3, main = "first"); plot(4:6, main = "second")')

      expect(result.error).toBeNull()
      expect(result.figures).toHaveLength(2)
      expect(result.figures.every((figure) => existsSync(figure.path))).toBe(true)
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

  it('evaluates immediately invoked palette closures without a policy preflight error', async () => {
    const { child, send } = startLoop(rscriptBin(), {})
    try {
      const result = await send(
        'cols <- grDevices::colorRampPalette(c("#2c7fb8", "#7fcdbb"))(6); print(length(cols))'
      )
      expect(result.error).toBeNull()
      expect(result.stdout).toContain('[1] 6')
    } finally {
      child.kill()
    }
  }, 60000)

  it.each([
    '(function() utils::install.packages)()(character())',
    'get("install.packages")(character())',
    '(function() function() utils::install.packages(character()))()()'
  ])(
    'keeps package mutation blocked through a nested closure: %s',
    async (code) => {
      const { child, send } = startLoop(rscriptBin(), {})
      try {
        expect((await send(code)).error).toMatch(/manage_packages/)
        expect((await send('21 * 2')).stdout).toContain('42')
      } finally {
        child.kill()
      }
    },
    60000
  )

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

  it('captures a PDF file-device plot as notebook PNG output', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-external-device-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        'grDevices::pdf(tempfile(fileext = ".pdf")); plot(1:3); grDevices::dev.off()'
      )
      expect(r.error).toBeNull()
      expect(r.figures).toHaveLength(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures one figure when the same plot is saved as PDF and TIFF', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-multi-format-'))
    const pdfPath = join(figuresDir, 'same-plot.pdf')
    const tiffPath = join(figuresDir, 'same-plot.tiff')
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        [
          `grDevices::pdf(${JSON.stringify(pdfPath)})`,
          'plot(1:3)',
          'grDevices::dev.off()',
          `grDevices::tiff(${JSON.stringify(tiffPath)})`,
          'plot(1:3)',
          'grDevices::dev.off()'
        ].join('; ')
      )
      expect(r.error).toBeNull()
      expect(existsSync(pdfPath)).toBe(true)
      expect(existsSync(tiffPath)).toBe(true)
      expect(r.figures).toHaveLength(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not replay a file-device plot opened by an earlier request', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-cross-request-device-'))
    const savedPath = join(figuresDir, 'cross-request.tiff')
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const opened = await send(
        `grDevices::tiff(${JSON.stringify(savedPath)}); ` +
          'external_device <- grDevices::dev.cur(); plot(1:3)'
      )
      expect(opened.error).toBeNull()
      expect(opened.figures).toEqual([])

      const closed = await send('plot(4:6); grDevices::dev.off(external_device)')
      expect(closed.error).toBeNull()
      expect(closed.figures).toHaveLength(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures a TIFF file-device plot as notebook PNG output', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-tiff-device-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        'grDevices::tiff(tempfile(fileext = ".tiff")); plot(1:3); grDevices::dev.off()'
      )
      expect(r.error).toBeNull()
      expect(r.figures).toHaveLength(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not capture an unused TIFF file device', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-unused-tiff-device-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send('grDevices::tiff(tempfile(fileext = ".tiff")); grDevices::dev.off()')
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

  it('captures grid drawing rendered to a TIFF device', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-grid-existing-page-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        'grDevices::tiff(tempfile(fileext = ".tiff")); grid::grid.rect(); grDevices::dev.off()'
      )
      expect(r.error).toBeNull()
      expect(r.figures).toHaveLength(1)
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

  it('captures a ggplot2 figure rendered to a TIFF device', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-gg-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        [
          'library(ggplot2)',
          'grDevices::tiff(tempfile(fileext = ".tiff"))',
          'ggplot(data.frame(x=1:3,y=1:3), aes(x,y)) + geom_point()',
          'grDevices::dev.off()'
        ].join('; ')
      )
      if (r.error && /there is no package called .ggplot2./.test(r.error)) {
        // ggplot2 not installed in this R env; base graphics coverage above already proves
        // device figure capture, so skip rather than fail.
        return
      }
      expect(r.error).toBeNull()
      expect(r.figures).toHaveLength(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('captures a lattice figure rendered to a TIFF device', async () => {
    const figuresDir = mkdtempSync(join(tmpdir(), 'os-kernel-figs-r-lattice-'))
    const { child, send } = startLoop(rscriptBin(), {
      OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresDir
    })
    try {
      const r = await send(
        [
          'grDevices::tiff(tempfile(fileext = ".tiff"))',
          'lattice::xyplot(y ~ x, data = data.frame(x = 1:3, y = c(1, 4, 9)))',
          'grDevices::dev.off()'
        ].join('; ')
      )
      if (r.error && /there is no package called .lattice./.test(r.error)) return

      expect(r.error).toBeNull()
      expect(r.figures).toHaveLength(1)
    } finally {
      child.kill()
      rmSync(figuresDir, { recursive: true, force: true })
    }
  }, 60_000)
})

gate('R execution boundaries', () => {
  it('starts a fresh namespace after a real kernel process is killed', async () => {
    const first = startLoop(rscriptBin(), {})
    try {
      await first.send('old_value <- 42')
      const exited = once(first.child, 'exit')
      first.child.kill('SIGKILL')
      await exited
      const second = startLoop(rscriptBin(), {})
      try {
        expect(
          (await second.send('exists("old_value", envir=.GlobalEnv, inherits=FALSE)')).stdout
        ).toContain('FALSE')
      } finally {
        second.child.kill()
      }
    } finally {
      first.child.kill()
    }
  }, 60000)
})

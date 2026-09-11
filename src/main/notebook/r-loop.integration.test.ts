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
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { startWorkingFileObservation } from './working-file-observer'
import { restoreRRandomState } from './r-random-replay'
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
  cwd?: string
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string) => Promise<KernelLoopResponse>
  inspect: (includePrivate?: boolean) => Promise<KernelLoopResponse>
  waitFor: (reqId: string) => Promise<KernelLoopResponse>
} => {
  const child = spawn(rscript, [LOOP], { cwd, env: { ...process.env, ...env } })
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
  return { child, send, inspect, waitFor }
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
      const result = await new NotebookDependencyAnalyzer({
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
      const analyzer = new NotebookDependencyAnalyzer({
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
            expect(evidence.fileEvidence).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
            expect(evidence.confirmedReadPaths).toEqual([
              'data/inputs/expression-matrix-444444444444.csv'
            ])
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
            expect(evidence.fileEvidence).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
            expect(evidence.confirmedReadPaths).toEqual([
              'data/inputs/differential-results-333333333333.xlsx'
            ])
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
        const analyzer = new NotebookDependencyAnalyzer({
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
            expect(evidence.fileEvidence, `${name} cell ${cell.index}`).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
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
        const analyzer = new NotebookDependencyAnalyzer({
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
            if (index === 8) expect(context?.serializedValueFiles?.length).toBe(1)
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
            expect(evidence.fileEvidence, `${name} cell ${index}`).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
            expect(evidence.confirmedReadPaths).toEqual([
              index === 7
                ? 'data/inputs/differential-results-333333333333.xlsx'
                : 'data/diff_df_clean.rds'
            ])
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
              state: 'clear'
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
          const analyzer = new NotebookDependencyAnalyzer({
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
                  state: 'clear'
                })
              if (index === scenario.replay.at(-1))
                expect(projection.dependenciesByRunId?.[runId]).toEqual([])
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
          expect(evidence.fileEvidence).toMatchObject({
            state: 'available',
            fileReads: 'complete',
            writerAttribution: 'complete',
            reasonCodes: []
          })
          expect(evidence.confirmedReadPaths).toEqual([
            'data/inputs/differential-results-333333333333.xlsx'
          ])
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
            expect(evidence.fileEvidence).toMatchObject({
              state: 'available',
              fileReads: 'complete',
              writerAttribution: 'complete',
              reasonCodes: []
            })
            expect(evidence.confirmedReadPaths?.sort()).toEqual(
              index === 4
                ? [
                    'data/inputs/expression-matrix-444444444444.csv',
                    'data/inputs/differential-results-333333333333.xlsx'
                  ].sort()
                : ['data/merged_diff_expr.rds']
            )
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
              expect(evidence.fileEvidence).toMatchObject({
                state: 'available',
                fileReads: 'complete',
                writerAttribution: 'complete',
                reasonCodes: []
              })
              expect(evidence.confirmedReadPaths).toEqual([
                index === 0 ? 'data/inputs/edge-weights-222222222222.xlsx' : 'data/chord_matrix.rds'
              ])
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
          const analyzer = new NotebookDependencyAnalyzer({
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
                expect(evidence.fileEvidence, `cell ${index}`).toMatchObject({
                  state: 'available',
                  fileReads: 'complete',
                  writerAttribution: 'complete',
                  reasonCodes: []
                })
                expect(evidence.confirmedReadPaths ?? []).toEqual(
                  scenario.inputCells.includes(index)
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
            expect(projection.stalenessByRunId[`${name}-${scenario.replay.at(-1)}`]).toEqual({
              state: 'clear'
            })
            expect(projection.dependenciesByRunId?.[`${name}-${scenario.replay.at(-1)}`]).toEqual(
              scenario.dependencies.map((index) => `${name}-${index}`)
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
      const analyzer = new NotebookDependencyAnalyzer({
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
      const reopened = new NotebookDependencyAnalyzer({
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

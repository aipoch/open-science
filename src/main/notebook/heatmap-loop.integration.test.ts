import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import {
  frameRRequest,
  framePythonRequest,
  parseLoopResponse,
  type KernelLoopResponse
} from './kernel-protocol'
import { startWorkingFileObservation } from './working-file-observer'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookRunRecord } from '../../shared/notebook'
import cells from './reported-heatmap.fixture.json'

for (const language of ['r', 'python'] as const) {
  const runtime =
    language === 'r' ? process.env.OPEN_SCIENCE_TEST_R_ENV : process.env.OPEN_SCIENCE_TEST_PY_ENV
  it.skipIf(!process.env.RUN_KERNEL || !runtime)(
    `captures and replays the reported ${language} heatmap in fresh kernels`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'heatmap-native-'))
      const hashes: string[] = []
      try {
        for (const phase of ['original', 'replay']) {
          const sessionRoot = join(root, phase),
            dataRoot = join(sessionRoot, 'data'),
            figures = join(sessionRoot, 'figures')
          mkdirSync(join(dataRoot, 'inputs'), { recursive: true })
          mkdirSync(figures)
          // Small deterministic input, generated outside the captured kernel.
          const csv = [
            ['group', ...Array.from({ length: 26 }, (_, i) => (i < 13 ? 'group1' : 'group2'))],
            ['sample', ...Array.from({ length: 26 }, (_, i) => `s${i}`)],
            ...Array.from({ length: 20 }, (_, i) => [
              `gene${i}`,
              ...Array.from({ length: 26 }, (_, j) => Math.sin(i + j / 3) + Math.cos(j + i / 4))
            ])
          ]
            .map((row) => row.join(','))
            .join('\n')
          writeFileSync(join(dataRoot, 'inputs/heatmap-values-555555555555.csv'), csv)
          const child = spawn(
            language === 'r' ? join(runtime!, 'bin/Rscript') : runtime!,
            [
              join(
                __dirname,
                language === 'r'
                  ? '../../../resources/notebook/r_loop.R'
                  : '../../../resources/notebook/python_loop.py'
              )
            ],
            {
              cwd: dataRoot,
              env: { ...process.env, OPEN_SCIENCE_KERNEL_FIGURES_DIR: figures, MPLBACKEND: 'Agg' }
            }
          )
          const lines = createInterface({ input: child.stdout })
          const waiters = new Map<
            string,
            { resolve: (r: KernelLoopResponse) => void; reject: (e: Error) => void }
          >()
          let stderr = ''
          child.stderr.on('data', (chunk) => {
            stderr += String(chunk)
          })
          lines.on('line', (line) => {
            const response = parseLoopResponse(line)
            if (response) {
              waiters.get(response.reqId)?.resolve(response)
              waiters.delete(response.reqId)
            }
          })
          child.on('exit', () => {
            for (const waiter of waiters.values()) waiter.reject(new Error(stderr))
          })
          const send = (code: string): Promise<KernelLoopResponse> =>
            new Promise((resolve, reject) => {
              const id = randomUUID()
              waiters.set(id, { resolve, reject })
              child.stdin.write((language === 'r' ? frameRRequest : framePythonRequest)(id, code))
            })
          try {
            // Reproduce the package-already-attached case without using that warmup as evidence.
            if (language === 'r' && phase === 'original')
              expect(
                (
                  await send(
                    'suppressPackageStartupMessages({library(pheatmap);library(RColorBrewer)})'
                  )
                ).error
              ).toBeNull()
            const script = cells[language],
              runId = phase
            const observation = await startWorkingFileObservation({
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language,
              code: script,
              runId
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
              'data/inputs/heatmap-values-555555555555.csv'
            ])
            const output = language === 'r' ? 'heatmap_r.png' : 'heatmap_python.png'
            expect(evidence.workingFiles.map((file) => file.relativePath)).toEqual([
              `data/${output}`
            ])
            const run: NotebookRunRecord = {
              runId,
              cellId: phase,
              kernelKind: language,
              kernelEpochId: phase,
              environment: language,
              source: 'agent',
              script,
              status: 'completed',
              kernelDispatched: true,
              startedAt: 0,
              endedAt: 1,
              text: { stdout: response.stdout, stderr: '', traceback: '', plain: [] },
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
                kernelKind: language,
                environmentName: language,
                runtimeSource: 'managed',
                inventorySources: ['kernel-native'],
                packages: response.environmentOverlay?.packages ?? [],
                complete: true,
                captureStatus: 'complete',
                executionContext: response.environmentOverlay?.executionContext
              }
            }
            const analyzer = new NotebookDependencyAnalyzer({
              storageRoot: root,
              repository: { readSessionRuns: async () => [run] }
            })
            const result = await analyzer.project({
              projectId: 'p',
              sessionId: phase,
              throughRunId: runId
            })
            expect(result.stalenessByRunId[runId]).toEqual({ state: 'clear' })
            const png = readFileSync(join(dataRoot, output))
            expect(png.length).toBeGreaterThan(1000)
            hashes.push(createHash('sha256').update(png).digest('hex'))
          } finally {
            child.kill()
            lines.close()
          }
        }
        expect(hashes[1]).toBe(hashes[0])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    90000
  )
}

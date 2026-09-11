// Opt-in real filesystem/worker benchmark; no wall-clock assertion on shared CI machines.
// RUN_FILE_EVIDENCE_PERF=1 npm test -- src/main/notebook/working-file-observer.performance.test.ts
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { runEvidenceWorker, startWorkingFileObservation } from './working-file-observer'

for (const scenario of [
  { name: 'ten-thousand-unrelated', unrelated: 10_000, outputs: 1, bytes: 1_024 },
  { name: 'thousand-output-members', unrelated: 0, outputs: 1_000, bytes: 1_024 },
  {
    name: 'thousand-replaced-output-members',
    unrelated: 0,
    outputs: 1_000,
    bytes: 1_024,
    replace: true
  },
  { name: 'large-input-and-output', unrelated: 0, outputs: 1, bytes: 64 * 1024 * 1024 }
]) {
  it.skipIf(process.env.RUN_FILE_EVIDENCE_PERF !== '1')(
    `measures capture of ${scenario.name} while preserving exact resource scope`,
    { timeout: 180_000 },
    async () => {
      const samples: Array<Record<string, number>> = []
      for (let round = 0; round < 3; round += 1) {
        const root = await mkdtemp(join(tmpdir(), 'file-evidence-perf-'))
        try {
          const sessionRoot = join(root, 'session')
          const dataRoot = join(sessionRoot, 'data')
          await mkdir(join(dataRoot, 'output'), { recursive: true })
          const content = Buffer.alloc(scenario.bytes, round + 1)
          await writeFile(join(dataRoot, 'input.bin'), content)
          for (let offset = 0; offset < scenario.unrelated; offset += 32) {
            await Promise.all(
              Array.from({ length: Math.min(32, scenario.unrelated - offset) }, (_, index) =>
                writeFile(join(dataRoot, `unrelated-${offset + index}.txt`), 'unrelated')
              )
            )
          }
          const paths = Array.from(
            { length: scenario.outputs },
            (_, index) => `output/part-${index}.bin`
          )
          if ('replace' in scenario && scenario.replace) {
            for (let offset = 0; offset < paths.length; offset += 32) {
              await Promise.all(
                paths
                  .slice(offset, offset + 32)
                  .map((path) => writeFile(join(dataRoot, path), 'previous output'))
              )
            }
          }
          const code =
            'from pathlib import Path\ncontent = Path("input.bin").read_bytes()\n' +
            paths.map((path) => `Path(${JSON.stringify(path)}).write_bytes(content)`).join('\n')
          const workerMs: Record<string, number> = {}
          const start = performance.now()
          const observation = await startWorkingFileObservation(
            {
              dataRoot,
              notebookSessionRoot: sessionRoot,
              cwd: dataRoot,
              language: 'python',
              code,
              runId: `perf-${round}`
            },
            {
              watchDirectory: () => {
                throw new Error('Benchmark complete scans without watcher timing')
              },
              diskReserveBytes: 0,
              runEvidenceWorker: async (...args) => {
                const before = performance.now()
                try {
                  return await runEvidenceWorker(...args)
                } finally {
                  const operation = args[1].operation
                  workerMs[operation] = (workerMs[operation] ?? 0) + performance.now() - before
                }
              }
            }
          )
          const beginMs = performance.now() - start
          for (let offset = 0; offset < paths.length; offset += 32) {
            await Promise.all(
              paths
                .slice(offset, offset + 32)
                .map((path) => writeFile(join(dataRoot, path), content))
            )
          }
          const finishStart = performance.now()
          const result = await observation.finish()
          const finishMs = performance.now() - finishStart
          expect(result.workingFiles.map((file) => file.relativePath).sort()).toEqual(
            paths.map((path) => `data/${path}`).sort()
          )
          if ('replace' in scenario && scenario.replace) {
            expect(result.workingFiles.every((file) => file.change === 'modified')).toBe(true)
          }
          expect(result.fileEvidence).toMatchObject({
            fileReads: 'complete',
            managedRootsFinalState: 'complete',
            generationCount: scenario.outputs + 1
          })
          samples.push({
            beginMs,
            finishMs,
            ...Object.fromEntries(
              Object.entries(workerMs).map(([key, value]) => [`worker_${key}Ms`, value])
            )
          })
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
      const report = JSON.stringify({ benchmark: 'file-evidence', scenario, samples })
      console.log(report)
      if (process.env.FILE_EVIDENCE_PERF_REPORT) {
        await appendFile(process.env.FILE_EVIDENCE_PERF_REPORT, report + '\n')
      }
    }
  )
}

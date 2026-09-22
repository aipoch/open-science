/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone JavaScript benchmark */
// Isolated comparison of the former per-Session worker protocol with Project batches.
// No application/user data is opened. Set EVIDENCE_BENCH_EXECUTABLE to Electron's executable
// to include its real process startup cost; otherwise use the current Node executable.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const worker = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../resources/notebook/file_evidence_worker.js'
)
const executable = process.env.EVIDENCE_BENCH_EXECUTABLE ?? process.execPath
const projectCount = 5
const sessionsPerProject = 20
const root = mkdtempSync(join(tmpdir(), 'evidence-recovery-bench-'))
const identity = (path) => {
  const { dev, ino } = statSync(path)
  return { dev, ino }
}
let calls = 0
const run = (cwd, request) => {
  calls++
  return JSON.parse(
    execFileSync(executable, [worker], {
      cwd,
      input: JSON.stringify(request),
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
  )
}
try {
  const results = []
  for (const mode of ['per-session', 'per-project']) {
    const evidenceRoot = join(root, mode)
    mkdirSync(evidenceRoot)
    const expectedRootIdentity = identity(evidenceRoot)
    for (let p = 0; p < projectCount; p++) {
      const projectName = `project-${p}`
      run(evidenceRoot, { operation: 'ensure-project', expectedRootIdentity, projectName })
      mkdirSync(join(evidenceRoot, projectName, 'blobs'))
      for (let s = 0; s < sessionsPerProject; s++)
        mkdirSync(join(evidenceRoot, projectName, `session-${s}`))
    }
    calls = 0
    const started = performance.now()
    for (let p = 0; p < projectCount; p++) {
      const projectName = `project-${p}`
      if (mode === 'per-project') {
        run(evidenceRoot, {
          operation: 'reconcile-compute-project',
          expectedRootIdentity,
          projectName,
          sessions: Array.from({ length: sessionsPerProject }, (_, s) => ({
            sessionName: `session-${s}`,
            retained: [],
            deferredActivityIds: []
          }))
        })
      } else {
        const blobRoot = join(evidenceRoot, projectName, 'blobs')
        for (let s = 0; s < sessionsPerProject; s++) {
          run(evidenceRoot, { operation: 'ensure-project', expectedRootIdentity, projectName })
          const sessionRoot = join(evidenceRoot, projectName, `session-${s}`)
          run(sessionRoot, {
            operation: 'reconcile',
            expectedRootIdentity: identity(sessionRoot),
            blobRoot,
            expectedBlobRootIdentity: identity(blobRoot),
            blobStorageKeyPrefix: `execution-file-evidence/${projectName}/blobs`,
            retained: [],
            deferredActivityIds: [],
            deferredActivityKinds: ['notebook-run']
          })
        }
      }
    }
    results.push({
      mode,
      workerProcesses: calls,
      durationMs: Math.round(performance.now() - started)
    })
  }
  console.log(
    JSON.stringify(
      { projectCount, sessionCount: projectCount * sessionsPerProject, results },
      null,
      2
    )
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

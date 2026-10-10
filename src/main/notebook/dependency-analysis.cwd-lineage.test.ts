import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const run = (script: string, index: number, cwd: string): NotebookRunRecord => ({
  runId: String(index),
  cellId: String(index),
  script,
  kernelKind: 'python',
  kernelEpochId: 'epoch',
  environment: 'python',
  source: 'agent',
  status: 'completed',
  kernelDispatched: true,
  startedAt: index,
  endedAt: index + 1,
  cwdBefore: cwd,
  cwdAfter: cwd,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

it('resolves Path.cwd into portable input and output lineage', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'notebook-cwd-lineage-'))
  const cwd = join(storageRoot, 'execution-root')
  const runs = [
    run(
      [
        'from pathlib import Path',
        'BASE_DIR = Path.cwd()',
        'INPUT = BASE_DIR / "inputs" / "variants.vcf"',
        'OUTPUT = BASE_DIR / "outputs" / "summary.tsv"'
      ].join('\n'),
      0,
      cwd
    ),
    run(
      [
        'with INPUT.open("r", encoding="utf-8") as source:',
        '    content = source.read()',
        'OUTPUT.write_text(content, encoding="utf-8")'
      ].join('\n'),
      1,
      cwd
    )
  ]
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: async () => runs }
    })
    const context = await analyzer.sourceFileAccessContext({
      projectId: 'project',
      sessionId: 'session',
      currentRunId: '1',
      language: 'python',
      environment: 'python',
      kernelEpochId: 'epoch'
    })
    expect(context?.workingDirectory).toBe(cwd)
    const access = await analyzeNotebookSourceFileAccess('python', runs[1]!.script, context)
    expect(access.reads.map((path) => normalize(path).replaceAll('\\', '/'))).toEqual([
      'inputs/variants.vcf'
    ])
    expect(access.writes.map((path) => normalize(path).replaceAll('\\', '/'))).toEqual([
      'outputs/summary.tsv'
    ])
    expect(access).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  } finally {
    await rm(storageRoot, { recursive: true, force: true })
  }
})

configureTestRuntimeMetadata()

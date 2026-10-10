import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
})

const completedRun = (
  runId: string,
  script: string,
  storageRoot: string,
  writes: string[] = []
): NotebookRunRecord => ({
  runId,
  cellId: runId,
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'python',
  kernelEpochId: 'epoch-1',
  environment: 'default-python',
  script,
  status: 'completed',
  startedAt: 1,
  endedAt: 1,
  executionCount: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: writes.map((relativePath) => ({
    path: join(storageRoot, relativePath),
    relativePath,
    kind: 'other' as const,
    createdByRunId: runId,
    change: 'created' as const,
    checksum: createHash('sha256').update(`${runId}:${relativePath}`).digest('hex')
  })),
  inputFiles: [],
  cwdBefore: storageRoot,
  cwdAfter: storageRoot
})

describe('RDKit molecule multi-cell lineage', { timeout: 60_000 }, () => {
  it('captures static Mol file read and write paths', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        'from rdkit import Chem\nmol = Chem.MolFromMolFile("inputs/aspirin.mol")\nChem.MolToMolFile(mol, "outputs/aspirin-copy.mol")'
      )
    ).resolves.toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/aspirin.mol'],
      writes: ['outputs/aspirin-copy.mol'],
      reasonCodes: []
    })
  })

  it('links molecule construction, hydrogen addition, publication, and reload', async () => {
    const source = await analyzePythonNotebookSource(
      'from rdkit import Chem\nmol = Chem.MolFromMolFile("inputs/aspirin.mol")\nexpanded = Chem.AddHs(mol)'
    )
    expect(source.facts.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'mol', typeName: 'rdkit.Chem.Mol' }),
        expect.objectContaining({ target: 'expanded', typeName: 'rdkit.Chem.Mol' })
      ])
    )

    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-rdkit-'))
    temporaryRoots.push(storageRoot)
    const runs: NotebookRunRecord[] = []
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot,
      repository: { readSessionRuns: vi.fn(async () => runs) }
    })
    const scripts = [
      'from rdkit import Chem\nmol = Chem.MolFromMolFile("inputs/aspirin.mol")',
      'expanded = Chem.AddHs(mol)\natom_count = expanded.GetNumAtoms()',
      'Chem.MolToMolFile(expanded, "outputs/aspirin-expanded.mol")',
      'verified = Chem.MolFromMolFile("outputs/aspirin-expanded.mol")\nprint(verified.GetNumAtoms())'
    ]
    let projection: Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined
    for (const [index, script] of scripts.entries()) {
      const run = completedRun(
        `run-${index + 1}`,
        script,
        storageRoot,
        index === 2 ? ['outputs/aspirin-expanded.mol'] : []
      )
      runs.push(run)
      projection = await analyzer.project({
        projectId: 'default-project',
        sessionId: 'session-1',
        completedRun: run,
        interpreter: { command: 'unused-python' }
      })
    }
    expect(projection?.dependenciesByRunId?.['run-2']).toContain('run-1')
    expect(projection?.dependenciesByRunId?.['run-3']).toContain('run-2')
    expect(projection?.fileDependenciesByRunId?.['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          producerRunId: 'run-3',
          path: 'outputs/aspirin-expanded.mol'
        })
      ])
    )
  })

  it('keeps dynamic molecule paths conservative', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        'from rdkit import Chem\npath = resolve_molecule_path()\nmol = Chem.MolFromMolFile(path)'
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      reads: [],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })
})

configureTestRuntimeMetadata()

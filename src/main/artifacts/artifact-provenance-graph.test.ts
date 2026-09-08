import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type {
  ArtifactVersionEvidence,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import type {
  ExecutionFileEvidenceSummary,
  ScientificOutputEvidence
} from '../../shared/execution-file-evidence'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from '../notebook/dependency-analysis'
import { NotebookRunRepository } from '../notebook/repository'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import { ArtifactProvenanceProducerCapture } from './provenance-producer-capture'
import { artifactAnalysisRevisionMatchesGraph } from './provenance-analysis-revision'
import {
  artifactProvenanceGraphValue,
  sealArtifactProvenanceGraph,
  type ArtifactProvenanceComputeActivityInput,
  type ArtifactProvenanceNotebookActivityInput,
  type SealArtifactProvenanceGraphInput
} from './artifact-provenance-graph'
import {
  resolveArtifactReproducibilityExecutionPlan,
  sealArtifactReproducibilityRecipe
} from './artifact-reproducibility-recipe'
import { sha256 } from './provenance-canonical'
import {
  buildBoundedExecutionSnapshot,
  validateArtifactExecutionSnapshot
} from './provenance-execution-evidence'
import { projectArtifactReproducibility } from './provenance-reproducibility-projection'

const checksum = (character: string): string => character.repeat(64)

const generation = (id: string, relativePath: string, digest: string): Record<string, unknown> => ({
  generationId: id,
  relativePath,
  checksum: digest,
  sizeBytes: 10,
  contentStorageKey: `execution-file-evidence/blobs/sha256-${digest}`,
  capturedAt: '2026-08-31T00:00:00.000Z'
})

const evidence = (
  activityId: string,
  relations: Record<string, unknown>[],
  options: {
    activityKind?: 'notebook-run' | 'compute-job'
    parentActivityId?: string
    fileReads?: 'complete' | 'partial' | 'unavailable'
    writerAttribution?: 'complete' | 'partial' | 'unavailable'
    state?: 'available' | 'partial' | 'unavailable'
    reasonCodes?: ExecutionFileEvidenceSummary['reasonCodes']
    scientificOutputs?: ScientificOutputEvidence[]
  } = {}
): { summary: ExecutionFileEvidenceSummary; json: string } => {
  const activityKind = options.activityKind ?? 'notebook-run'
  const fileReads = options.fileReads ?? 'complete'
  const writerAttribution = options.writerAttribution ?? 'complete'
  const state = options.state ?? 'available'
  const reasonCodes = options.reasonCodes ?? []
  const scientificOutputs = options.scientificOutputs ?? []
  const value = {
    schemaVersion: 1,
    evidenceId: `evidence-${activityId}`,
    activityId,
    activityKind,
    ...(options.parentActivityId ? { parentActivityId: options.parentActivityId } : {}),
    state,
    observedRoots: ['data'],
    initialViewState: 'complete',
    managedRootsFinalState: 'complete',
    fileReads,
    externalPaths: 'complete',
    writerAttribution,
    reasonCodes,
    scientificOutputs,
    relations
  }
  const json = `${JSON.stringify(value, null, 2)}\n`
  return {
    summary: {
      schemaVersion: 1,
      activityId,
      activityKind,
      ...(options.parentActivityId ? { parentActivityId: options.parentActivityId } : {}),
      state,
      evidenceId: value.evidenceId,
      checksum: sha256(json),
      storageKey: `execution-file-evidence/project/session/activity-${activityId}/evidence.json`,
      relationCount: relations.length,
      generationCount: relations.filter((relation) => relation.generation).length,
      scientificOutputCount: scientificOutputs.length,
      initialViewState: 'complete',
      managedRootsFinalState: 'complete',
      scientificOutputAnalysis: 'complete',
      fileReads,
      externalPaths: 'complete',
      writerAttribution,
      reasonCodes
    },
    json
  }
}

const run = (
  runId: string,
  runIndex: number,
  fileEvidence: ExecutionFileEvidenceSummary,
  options: Partial<NotebookRunRecord> = {}
): NotebookRunRecord => ({
  runId,
  kernelEpochId: 'epoch-1',
  kernelDispatched: true,
  cellId: `cell-${runIndex}`,
  source: 'agent',
  kernelKind: 'python',
  script: `print(${runIndex})`,
  status: 'completed',
  startedAt: runIndex,
  endedAt: runIndex + 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: [],
  fileEvidence,
  ...options
})

const notebookActivity = (
  runId: string,
  runIndex: number,
  relations: Record<string, unknown>[],
  options: Parameters<typeof evidence>[2] & Partial<NotebookRunRecord> = {}
): ArtifactProvenanceNotebookActivityInput => {
  const captured = evidence(runId, relations, options)
  return {
    run: run(runId, runIndex, captured.summary, options),
    runIndex,
    evidenceJson: captured.json
  }
}

const target = (sourceGenerationId = 'g-target'): SealArtifactProvenanceGraphInput['target'] => ({
  versionId: 'version-1',
  filename: 'result.csv',
  checksum: checksum('b'),
  sizeBytes: 10,
  producerRunId: 'run-2',
  sourceGenerationId
})

const recipeRun = (
  runId: string,
  runIndex: number,
  options: Partial<ProvenanceNotebookRun> = {}
): ProvenanceNotebookRun => ({
  runId,
  runIndex,
  agentFrameId: 'frame-1',
  messageBranchId: 'branch-1',
  runtimeSegmentId: 'segment-1',
  promptMessageId: 'prompt-1',
  kernelKind: 'python',
  environmentName: 'default-python',
  environmentLock: {
    state: 'available',
    format: 'environment-lock-bundle',
    lockChecksum: checksum('e')
  },
  script: `print(${runIndex})`,
  status: 'completed',
  startedAt: '2026-09-02T00:00:00.000Z',
  completedAt: '2026-09-02T00:00:01.000Z',
  outputs: [],
  inputFileVersionKeys: [],
  ...options
})

describe('artifact provenance graph', () => {
  it.each(['proportional_venn_5sets.png', 'proportional_venn_5sets_hires.png'])(
    'reconstructs %s without discarded font probes and failed theme setup',
    async (filename) => {
      const cells: string[] = JSON.parse(
        await readFile(join(__dirname, '../notebook/reported-venn-layers.fixture.json'), 'utf8')
      )
      const root = await mkdtemp(join(tmpdir(), 'venn-layer-recipe-'))
      try {
        const relation = (
          id: string,
          path: string,
          kind: string,
          digest: string
        ): Record<string, unknown> => ({
          relation: kind,
          relativePath: path,
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation(id, path, checksum(digest))
        })
        const activities = cells.map((script, index) =>
          notebookActivity(
            `run-${index}`,
            index,
            [
              ...(index === 3
                ? []
                : [relation('xlsx', 'data/inputs/set-membership-111111111111.xlsx', 'present-before', 'a')]),
              ...(index >= 5
                ? [
                    relation(
                      `png-${index}`,
                      'data/proportional_venn_5sets.png',
                      'created',
                      index === 5 ? 'c' : 'b'
                    )
                  ]
                : []),
              ...(index === 6
                ? [relation('hires', 'data/proportional_venn_5sets_hires.png', 'created', 'b')]
                : [])
            ],
            { script, kernelKind: 'r', status: index === 4 ? 'failed' : 'completed' }
          )
        )
        const dependencies = await new NotebookDependencyAnalyzer({
          storageRoot: root,
          repository: { readSessionRuns: async () => activities.map((a) => a.run) }
        }).project({ projectId: 'p', sessionId: 's', throughRunId: 'run-6' })
        const graph = sealArtifactProvenanceGraph({
          target: {
            versionId: 'v',
            filename,
            checksum: checksum('b'),
            sizeBytes: 10,
            producerRunId: 'run-6',
            sourceGenerationId: filename.includes('hires') ? 'hires' : 'png-6'
          },
          notebookActivities: activities,
          computeActivities: [],
          notebookDependencies: dependencies
        })
        expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
        const recipe = sealArtifactReproducibilityRecipe({
          provenanceGraph: graph,
          inputFiles: [],
          runs: activities.map((a) =>
            recipeRun(a.run.runId, a.runIndex, {
              script: a.run.script,
              kernelKind: 'r',
              status: a.run.status
            })
          )
        })
        expect(recipe.steps.map((step) => step.activityId)).toEqual(['run-6'])
        expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
  it('reconstructs the Venn PNG from its Excel input and two required R cells', async () => {
    const cells: string[] = JSON.parse(
      await readFile(join(__dirname, '../notebook/reported-venn.fixture.json'), 'utf8')
    )
    const root = await mkdtemp(join(tmpdir(), 'venn-recipe-'))
    try {
      const activities = cells.map((script, index) =>
        notebookActivity(
          `run-${index}`,
          index,
          [
            {
              relation: index < 3 ? 'present-before' : 'created',
              relativePath:
                index < 3 ? 'data/inputs/set-membership-111111111111.xlsx' : 'data/proportional_venn_5sets.png',
              pathPortability: 'relative',
              authority: 'advisory',
              generation:
                index < 3
                  ? generation('xlsx', 'data/inputs/set-membership-111111111111.xlsx', checksum('a'))
                  : generation('png', 'data/proportional_venn_5sets.png', checksum('b'))
            }
          ],
          { script, kernelKind: 'r' }
        )
      )
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => activities.map((a) => a.run) }
      }).project({ projectId: 'p', sessionId: 's', throughRunId: 'run-3' })
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'v',
          filename: 'proportional_venn_5sets.png',
          checksum: checksum('b'),
          sizeBytes: 10,
          producerRunId: 'run-3',
          sourceGenerationId: 'png'
        },
        notebookActivities: activities,
        computeActivities: [],
        notebookDependencies: dependencies
      })
      expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs: activities.map((a) =>
          recipeRun(a.run.runId, a.runIndex, { script: a.run.script, kernelKind: 'r' })
        )
      })
      expect(recipe.steps.map((step) => step.activityId)).toEqual(['run-2', 'run-3'])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reconstructs an R to Python to R workflow through CSV and Parquet generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cross-language-intermediates-'))
    const relation = (kind: string, path: string, digest: string): Record<string, unknown> => ({
      relation: kind,
      relativePath: path,
      pathPortability: 'relative',
      authority: 'advisory',
      generation: generation(digest, path, checksum(digest))
    })
    const activities = [
      notebookActivity(
        'r-write',
        1,
        [
          relation('present-before', 'data/inputs/source.csv', 'a'),
          relation('created', 'data/middle.csv', 'b')
        ],
        {
          kernelKind: 'r',
          kernelEpochId: 'r-first',
          script: 'd<-read.csv("inputs/source.csv"); write.csv(d,"middle.csv",row.names=FALSE)'
        }
      ),
      notebookActivity(
        'python-transform',
        2,
        [
          relation('present-before', 'data/middle.csv', 'b'),
          relation('created', 'data/middle.parquet', 'c')
        ],
        {
          kernelKind: 'python',
          kernelEpochId: 'python',
          script:
            'import pandas as pd\nd=pd.read_csv("middle.csv")\nd.to_parquet("middle.parquet",index=False)'
        }
      ),
      notebookActivity(
        'r-read',
        3,
        [
          relation('present-before', 'data/middle.parquet', 'c'),
          relation('created', 'data/result.csv', 'd')
        ],
        {
          kernelKind: 'r',
          kernelEpochId: 'r-second',
          script:
            'd<-arrow::read_parquet("middle.parquet"); d<-subset(d,x>1); write.csv(d,"result.csv",row.names=FALSE)'
        }
      )
    ]
    try {
      for (const activity of activities) {
        const path = join(root, activity.run.fileEvidence!.storageKey!)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, activity.evidenceJson!)
      }
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => activities.map((a) => a.run) }
      }).project({ projectId: 'p', sessionId: 's', throughRunId: 'r-read' })
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'v',
          filename: 'result.csv',
          checksum: checksum('d'),
          sizeBytes: 10,
          producerRunId: 'r-read',
          sourceGenerationId: 'd'
        },
        notebookActivities: activities,
        computeActivities: [],
        notebookDependencies: dependencies
      })
      expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs: activities.map((a) =>
          recipeRun(a.run.runId, a.runIndex, { script: a.run.script, kernelKind: a.run.kernelKind })
        )
      })
      expect(recipe.steps.map((step) => step.activityId)).toEqual([
        'r-write',
        'python-transform',
        'r-read'
      ])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reconstructs a generated RDS bridge instead of requiring it to be an uploaded input', async () => {
    const cells = JSON.parse(
      await readFile(join(__dirname, '../notebook/reported-rds-clean-volcano.fixture.json'), 'utf8')
    ) as Array<{ index: number; script: string }>
    const root = await mkdtemp(join(tmpdir(), 'rds-file-recipe-'))
    const relation = (
      kind: string,
      id: string,
      path: string,
      digest: string
    ): Record<string, unknown> => ({
      relation: kind,
      relativePath: path,
      pathPortability: 'relative',
      authority: 'advisory',
      generation: generation(id, path, checksum(digest))
    })
    const activities = [
      notebookActivity(
        'producer',
        7,
        [
          relation('present-before', 'xlsx', 'data/inputs/differential-results-333333333333.xlsx', 'a'),
          relation('created', 'rds', 'data/diff_df_clean.rds', 'b')
        ],
        { script: cells[7].script, kernelKind: 'r', kernelEpochId: 'first' }
      ),
      notebookActivity(
        'plot',
        8,
        [
          relation('present-before', 'rds', 'data/diff_df_clean.rds', 'b'),
          relation('created', 'png', 'data/diagonal_volcano.png', 'c')
        ],
        { script: cells[8].script, kernelKind: 'r', kernelEpochId: 'second' }
      )
    ]
    try {
      for (const activity of activities) {
        const path = join(root, activity.run.fileEvidence!.storageKey!)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, activity.evidenceJson!)
      }
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => activities.map((a) => a.run) }
      }).project({ projectId: 'p', sessionId: 's', throughRunId: 'plot' })
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'v',
          filename: 'diagonal_volcano.png',
          checksum: checksum('c'),
          sizeBytes: 10,
          producerRunId: 'plot',
          sourceGenerationId: 'png'
        },
        notebookActivities: activities,
        computeActivities: [],
        notebookDependencies: dependencies
      })
      expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs: activities.map((a) =>
          recipeRun(a.run.runId, a.runIndex, { script: a.run.script, kernelKind: 'r' })
        )
      })
      expect(recipe.steps.map((step) => step.activityId)).toEqual(['producer', 'plot'])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('reconstructs the contrast plot through four memory-dependent R cells', async () => {
    const cells = JSON.parse(
      await readFile(join(__dirname, '../notebook/reported-contrasts-volcano.fixture.json'), 'utf8')
    ) as Array<{ index: number; script: string }>
    const root = await mkdtemp(join(tmpdir(), 'contrasts-recipe-'))
    try {
      const activities = cells.map((c) =>
        notebookActivity(
          `run-${c.index}`,
          c.index,
          c.index === 3
            ? [
                {
                  relation: 'present-before',
                  relativePath: 'data/inputs/expression-matrix-444444444444.csv',
                  pathPortability: 'relative',
                  authority: 'advisory',
                  generation: generation('csv', 'data/inputs/expression-matrix-444444444444.csv', checksum('a'))
                }
              ]
            : c.index === 6
              ? ['png', 'pdf'].map((ext, i) => ({
                  relation: 'created',
                  relativePath: `data/diagonal_volcano.${ext}`,
                  pathPortability: 'relative',
                  authority: 'advisory',
                  generation: generation(
                    ext,
                    `data/diagonal_volcano.${ext}`,
                    checksum(i ? 'c' : 'b')
                  )
                }))
              : [],
          { script: c.script, kernelKind: 'r' }
        )
      )
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => activities.map((a) => a.run) }
      }).project({ projectId: 'p', sessionId: 's', throughRunId: 'run-6' })
      for (const [i, ext] of ['png', 'pdf'].entries()) {
        const graph = sealArtifactProvenanceGraph({
          target: {
            versionId: ext,
            filename: `diagonal_volcano.${ext}`,
            checksum: checksum(i ? 'c' : 'b'),
            sizeBytes: 10,
            producerRunId: 'run-6',
            sourceGenerationId: ext
          },
          notebookActivities: activities,
          computeActivities: [],
          notebookDependencies: dependencies
        })
        expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
        const recipe = sealArtifactReproducibilityRecipe({
          provenanceGraph: graph,
          inputFiles: [],
          runs: activities.map((a) =>
            recipeRun(a.run.runId, a.runIndex, { script: a.run.script, kernelKind: 'r' })
          )
        })
        expect(recipe.steps.map((s) => s.activityId)).toEqual(['run-3', 'run-4', 'run-5', 'run-6'])
        expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('keeps a rejected R plot out of the final standalone recipe', async () => {
    const cells = JSON.parse(
      await readFile(join(__dirname, '../notebook/reported-layered-volcano.fixture.json'), 'utf8')
    ) as Array<{ index: number; script: string; language: string; status: string }>
    const root = await mkdtemp(join(tmpdir(), 'layered-recipe-'))
    try {
      const activities = cells
        .filter((c) => c.language === 'r')
        .map((c) =>
          notebookActivity(
            `run-${c.index}`,
            c.index,
            c.index === 11
              ? [
                  {
                    relation: 'present-before',
                    relativePath: 'data/inputs/differential-results-333333333333.xlsx',
                    pathPortability: 'relative',
                    authority: 'advisory',
                    generation: generation(
                      'xlsx',
                      'data/inputs/differential-results-333333333333.xlsx',
                      checksum('a')
                    )
                  },
                  {
                    relation: 'created',
                    relativePath: 'data/diagonal_volcano.png',
                    pathPortability: 'relative',
                    authority: 'advisory',
                    generation: generation('png', 'data/diagonal_volcano.png', checksum('b'))
                  }
                ]
              : [],
            {
              script: c.script,
              kernelKind: 'r',
              status: c.status === 'failed' || c.index === 6 ? 'failed' : 'completed'
            }
          )
        )
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => activities.map((a) => a.run) }
      }).project({ projectId: 'p', sessionId: 's', throughRunId: 'run-11' })
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'final',
          filename: 'diagonal_volcano.png',
          checksum: checksum('b'),
          sizeBytes: 10,
          producerRunId: 'run-11',
          sourceGenerationId: 'png'
        },
        notebookActivities: activities,
        computeActivities: [],
        notebookDependencies: dependencies
      })
      expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs: activities.map((a) =>
          recipeRun(a.run.runId, a.runIndex, {
            script: a.run.script,
            kernelKind: 'r',
            status: a.run.status === 'failed' ? 'failed' : 'completed',
            ...(a.run.status === 'failed' ? { environmentLock: undefined } : {})
          })
        )
      })
      expect(recipe.steps.map((s) => s.activityId)).toEqual(['run-11'])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['python', 'r', 'python'],
    ['r', 'python', 'r'],
    ['r', 'r', 'r']
  ] as const)(
    'links captured file generations across %s → %s → %s epochs',
    async (first, second, third) => {
      const root = await mkdtemp(join(tmpdir(), 'kernel-file-chain-'))
      const languages = [first, second, third]
      const relation = (
        kind: string,
        id: string,
        path: string,
        digest: string
      ): Record<string, unknown> => ({
        relation: kind,
        relativePath: path,
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation(id, path, checksum(digest))
      })
      try {
        const activities = languages.map((language, index) => {
          const input = index === 0 ? 'inputs/source.csv' : `stage${index}.csv`,
            output = `stage${index + 1}.csv`
          const script =
            language === 'r'
              ? `df<-read.csv("${input}"); df$value<-df$value*2; write.csv(df,"${output}",row.names=FALSE)`
              : `import pandas as pd\ndf=pd.read_csv("${input}")\ndf["value"]=df["value"]*2\ndf.to_csv("${output}",index=False)`
          return notebookActivity(
            `run-${index}`,
            index,
            [
              relation('present-before', `in-${index}`, `data/${input}`, String(index + 1)),
              relation('created', `out-${index}`, `data/${output}`, String(index + 2))
            ],
            { script, kernelKind: language, kernelEpochId: `epoch-${index}` }
          )
        })
        const dependencies = await new NotebookDependencyAnalyzer({
          storageRoot: root,
          repository: { readSessionRuns: async () => activities.map((a) => a.run) }
        }).project({ projectId: 'p', sessionId: 's', throughRunId: 'run-2' })
        // Identical df names belong to different kernels. Only captured files bridge them.
        for (const activity of activities) {
          expect(dependencies.stalenessByRunId[activity.run.runId]).toEqual({ state: 'clear' })
          expect(dependencies.dependenciesByRunId?.[activity.run.runId]).toEqual([])
        }
        const graph = sealArtifactProvenanceGraph({
          target: {
            versionId: 'final',
            filename: 'stage3.csv',
            checksum: checksum('4'),
            sizeBytes: 10,
            producerRunId: 'run-2',
            sourceGenerationId: 'out-2'
          },
          notebookActivities: activities,
          computeActivities: [],
          notebookDependencies: dependencies
        })
        expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
        const recipe = sealArtifactReproducibilityRecipe({
          provenanceGraph: graph,
          inputFiles: [],
          runs: activities.map((a) =>
            recipeRun(a.run.runId, a.runIndex, {
              script: a.run.script,
              kernelKind: a.run.kernelKind
            })
          )
        })
        expect(recipe.steps.map((s) => s.activityId)).toEqual(['run-0', 'run-1', 'run-2'])
        expect(
          recipe.steps.map((s) => (s.kind === 'notebook-run' ? s.kernelKind : undefined))
        ).toEqual(languages)
        expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each(['png', 'pdf'])(
    'replays Python preparation and R plotting for the %s target',
    async (extension) => {
      const cells = JSON.parse(
        await readFile(
          join(__dirname, '../notebook/reported-cross-language-volcano.fixture.json'),
          'utf8'
        )
      ) as Array<{ index: number; script: string; language: 'python' | 'r' }>
      const root = await mkdtemp(join(tmpdir(), 'cross-language-graph-'))
      const relation = (
        kind: string,
        id: string,
        path: string,
        digest: string
      ): Record<string, unknown> => ({
        relation: kind,
        relativePath: path,
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation(id, path, checksum(digest))
      })
      try {
        const activities = cells.map((c) =>
          notebookActivity(
            `run-${c.index}`,
            c.index,
            c.index === 5
              ? [
                  relation('present-before', 'csv', 'data/inputs/expression-matrix-444444444444.csv', 'a'),
                  relation('present-before', 'xlsx', 'data/inputs/differential-results-333333333333.xlsx', 'b'),
                  relation('created', 'intermediate', 'data/processed/diff_results.csv', 'c')
                ]
              : c.index >= 6
                ? [
                    relation(
                      'present-before',
                      `intermediate-${c.index}`,
                      'data/processed/diff_results.csv',
                      'c'
                    ),
                    ...(c.index === 8
                      ? [
                          relation('created', 'png', 'data/processed/diagonal_volcano.png', 'd'),
                          relation('created', 'pdf', 'data/processed/diagonal_volcano.pdf', 'e')
                        ]
                      : [])
                  ]
                : [],
            { script: c.script, kernelKind: c.language, kernelEpochId: `${c.language}-epoch` }
          )
        )
        const dependencies = await new NotebookDependencyAnalyzer({
          storageRoot: root,
          repository: { readSessionRuns: async () => activities.map((a) => a.run) }
        }).project({ projectId: 'p', sessionId: 's', throughRunId: 'run-8' })
        expect(dependencies.stalenessByRunId['run-8'], JSON.stringify(dependencies)).toEqual({
          state: 'clear'
        })
        const graph = sealArtifactProvenanceGraph({
          target: {
            versionId: 'final',
            filename: `diagonal_volcano.${extension}`,
            checksum: checksum(extension === 'png' ? 'd' : 'e'),
            sizeBytes: 10,
            producerRunId: 'run-8',
            sourceGenerationId: extension
          },
          notebookActivities: activities,
          computeActivities: [],
          notebookDependencies: dependencies
        })
        expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
        expect(
          graph.activities.filter((a) => a.kind === 'notebook-run').map((a) => a.activityId),
          JSON.stringify(dependencies)
        ).toEqual(['run-5', 'run-8'])
        const recipe = sealArtifactReproducibilityRecipe({
          provenanceGraph: graph,
          inputFiles: [],
          runs: activities.map((a) =>
            recipeRun(a.run.runId, a.runIndex, {
              script: a.run.script,
              kernelKind: a.run.kernelKind
            })
          )
        })
        expect(recipe.steps.map((s) => s.activityId)).toEqual(['run-5', 'run-8'])
        expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('rebuilds an RDS plot from both inputs without replaying failed or replaced images', async () => {
    const cells = JSON.parse(
      await readFile(
        join(__dirname, '../notebook/reported-rds-envelope-volcano.fixture.json'),
        'utf8'
      )
    ) as Array<{ index: number; script: string; language: string; status: string }>
    const storageRoot = await mkdtemp(join(tmpdir(), 'rds-envelope-graph-'))
    const relation = (
      kind: string,
      id: string,
      path: string,
      digest: string
    ): Record<string, unknown> => ({
      relation: kind,
      relativePath: path,
      pathPortability: 'relative',
      authority: 'advisory',
      generation: generation(id, path, checksum(digest))
    })
    try {
      const activities = cells
        .filter((c) => c.language === 'r')
        .map((c) =>
          notebookActivity(
            `run-${c.index}`,
            c.index,
            c.index === 4
              ? [
                  relation('present-before', 'csv', 'data/inputs/expression-matrix-444444444444.csv', 'a'),
                  relation('present-before', 'xlsx', 'data/inputs/differential-results-333333333333.xlsx', 'b'),
                  relation('created', 'rds', 'data/merged_diff_expr.rds', 'c')
                ]
              : c.index >= 5
                ? [
                    relation('present-before', `rds-${c.index}`, 'data/merged_diff_expr.rds', 'c'),
                    relation(
                      'created',
                      `png-${c.index}`,
                      'data/diagonal_volcano.png',
                      String(c.index)
                    )
                  ]
                : [],
            {
              script: c.script,
              kernelKind: 'r',
              status: c.status === 'failed' ? 'failed' : 'completed'
            }
          )
        )
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => activities.map((a) => a.run) }
      }).project({ projectId: 'p', sessionId: 's', throughRunId: 'run-8' })
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'final',
          filename: 'diagonal_volcano.png',
          checksum: checksum('8'),
          sizeBytes: 10,
          producerRunId: 'run-8',
          sourceGenerationId: 'png-8'
        },
        notebookActivities: activities,
        computeActivities: [],
        notebookDependencies: dependencies
      })
      expect(graph.completeness, JSON.stringify(graph.reasonCodes)).toBe('complete')
      expect(
        graph.activities.filter((a) => a.kind === 'notebook-run').map((a) => a.activityId)
      ).toEqual(['run-4', 'run-8'])
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs: activities.map((a) =>
          recipeRun(a.run.runId, a.runIndex, {
            script: a.run.script,
            kernelKind: 'r',
            status: a.run.status === 'failed' ? 'failed' : 'completed',
            ...(a.run.status === 'failed' ? { environmentLock: undefined } : {})
          })
        )
      })
      expect(recipe.steps.map((s) => s.activityId)).toEqual(['run-4', 'run-8'])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('replays only the final independently redrawn chord generation', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'chord-generation-closure-'))
    try {
      const scripts = (
        await readFile(
          join(__dirname, '../notebook/reported-python-chord-redraw.fixture.py'),
          'utf8'
        )
      ).split('\n\n# %%\n\n')
      const activities = scripts.map((script, index) =>
        notebookActivity(
          `run-${index}`,
          index,
          [
            {
              relation: 'present-before',
              relativePath: 'data/inputs/edge-weights-222222222222.xlsx',
              pathPortability: 'relative',
              authority: 'advisory',
              generation: generation(
                `input-${index}`,
                'data/inputs/edge-weights-222222222222.xlsx',
                checksum('a')
              )
            },
            {
              relation: index === 0 ? 'created' : 'modified',
              relativePath: 'data/chord_diagram.png',
              pathPortability: 'relative',
              authority: 'advisory',
              generation: generation(
                `output-${index}`,
                'data/chord_diagram.png',
                checksum(String(index + 1))
              )
            }
          ],
          { script }
        )
      )
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => activities.map((activity) => activity.run) }
      }).project({ projectId: 'project', sessionId: 'session', throughRunId: 'run-2' })
      expect(dependencies.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(dependencies.dependenciesByRunId?.['run-2']).toEqual([])
      const graph = sealArtifactProvenanceGraph({
        target: {
          versionId: 'version',
          filename: 'chord_diagram.png',
          checksum: checksum('3'),
          sizeBytes: 10,
          producerRunId: 'run-2',
          sourceGenerationId: 'output-2'
        },
        notebookActivities: activities,
        computeActivities: [],
        notebookDependencies: dependencies
      })
      expect(graph.completeness).toBe('complete')
      expect(
        graph.activities
          .filter((activity) => activity.kind === 'notebook-run')
          .map((activity) => activity.activityId)
      ).toEqual(['run-2'])
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs: activities.map((activity) =>
          recipeRun(activity.run.runId, activity.runIndex, { script: activity.run.script })
        )
      })
      expect(recipe.steps.map((step) => step.activityId)).toEqual(['run-2'])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })
  it.each([
    ['python', 'missing'],
    ['python', 'rejected'],
    ['r', 'missing'],
    ['r', 'rejected']
  ] as const)('blocks %s capture when dependency analysis is %s', async (kernelKind, failure) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-capture-analysis-failure-'))
    try {
      const notebookRepository = new NotebookRunRepository(storageRoot)
      const document = await notebookRepository.loadOrCreate({
        projectId: 'project',
        sessionId: 'session',
        lane: createFrameNotebookLane('project', 'session', 'agent'),
        workspaceCwd: storageRoot
      })
      const scope = {
        rootFrameId: 'root',
        agentFrameId: 'agent',
        messageBranchId: 'branch',
        runtimeSegmentId: 'segment',
        promptMessageId: 'prompt'
      }
      const content = '1'
      const digest = sha256(content)
      const path = join(document.notebookSessionRoot, 'data', 'result.csv')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
      const metadata = await stat(path)
      const first = notebookActivity('run-1', 0, [], {
        ...scope,
        kernelKind,
        script: kernelKind === 'python' ? 'x = 1' : 'x <- 1'
      })
      const producer = notebookActivity(
        'run-2',
        1,
        [
          {
            relation: 'created',
            relativePath: 'data/result.csv',
            pathPortability: 'relative',
            authority: 'advisory',
            generation: {
              ...generation('g-target', 'data/result.csv', digest),
              sizeBytes: metadata.size
            }
          }
        ],
        {
          ...scope,
          kernelKind,
          script:
            kernelKind === 'python'
              ? 'with open("data/result.csv", "w") as f:\n    f.write(str(x))'
              : 'writeLines(as.character(x), "data/result.csv")',
          workingFiles: [
            {
              path,
              relativePath: 'data/result.csv',
              kind: 'other',
              size: metadata.size,
              mtimeMs: metadata.mtimeMs,
              createdByRunId: 'run-2',
              generationId: 'g-target',
              checksum: digest
            }
          ]
        }
      )
      for (const activity of [first, producer]) {
        activity.run.environmentLock = {
          state: 'available',
          format: 'environment-lock-bundle',
          lockChecksum: checksum('e')
        }
        const evidencePath = join(storageRoot, activity.run.fileEvidence!.storageKey!)
        await mkdir(dirname(evidencePath), { recursive: true })
        await writeFile(evidencePath, activity.evidenceJson!)
      }
      const capture = new ArtifactProvenanceProducerCapture({
        storageRoot,
        createId: () => 'id',
        inputAuthority: {
          validateVersion: async () => {
            throw new Error('Unexpected input')
          }
        },
        notebookRepository: {
          readSessionDocuments: async () => [{ ...document, runs: [first.run, producer.run] }]
        },
        ...(failure === 'rejected'
          ? {
              dependencyAnalyzer: {
                project: async () => {
                  throw new Error('Cannot read dependency history')
                }
              }
            }
          : {})
      })
      const captured = await capture.captureProducer(
        {
          ...scope,
          projectId: 'project',
          appSessionId: 'session',
          artifactStorageSessionId: 'session',
          artifactRunId: 'artifact-run',
          writeOperationId: 'write',
          writeRequestChecksum: checksum('a'),
          notebookSessionId: 'session',
          producerRunId: 'run-2',
          filename: 'result.csv',
          sourceFileObservation: { path, sizeBytes: metadata.size, mtimeMs: metadata.mtimeMs }
        },
        new Date(),
        { versionId: 'version', filename: 'result.csv', checksum: digest, sizeBytes: metadata.size }
      )
      if (captured.state !== 'available' || captured.kind !== 'notebook')
        throw new Error('Capture failed')
      const snapshot = JSON.parse(captured.executionJson) as PersistedArtifactExecutionSnapshot
      expect(
        artifactAnalysisRevisionMatchesGraph(snapshot.analysisRevision, snapshot.provenanceGraph)
      ).toBe(true)
      expect(snapshot.analysisRevision?.dependencyAnalyzer).toBeUndefined()
      expect(snapshot.provenanceGraph?.completeness).toBe('incomplete')
      expect(snapshot.provenanceGraph?.reasonCodes).toContain('kernel-dependencies-unavailable')
      expect(snapshot.reproducibilityRecipe?.capture.state).toBe('blocked')
      expect(
        snapshot.reproducibilityRecipe?.frontiers.every(
          (frontier) => frontier.reasonCodes.length > 0
        )
      ).toBe(true)
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('accepts the exact legacy Notebook sidecar without inventing relations', () => {
    const runId = 'legacy-run'
    const evidenceId = `notebook-file-evidence-${runId}`
    const json = `${JSON.stringify({ schemaVersion: 1, evidenceId, runId })}\n`
    const summary: ExecutionFileEvidenceSummary = {
      schemaVersion: 1,
      activityId: runId,
      activityKind: 'notebook-run',
      state: 'available',
      evidenceId,
      checksum: sha256(json),
      storageKey: `notebook-file-evidence/project/session/run-${runId}/evidence.json`,
      relationCount: 0,
      generationCount: 0,
      scientificOutputCount: 0,
      initialViewState: 'complete',
      managedRootsFinalState: 'complete',
      scientificOutputAnalysis: 'complete',
      fileReads: 'unavailable',
      externalPaths: 'unavailable',
      writerAttribution: 'complete',
      reasonCodes: []
    }
    const activity: ArtifactProvenanceNotebookActivityInput = {
      run: run(runId, 0, summary),
      runIndex: 0,
      evidenceJson: json
    }

    const graph = sealArtifactProvenanceGraph({
      target: { ...target(undefined), producerRunId: runId },
      notebookActivities: [activity],
      computeActivities: []
    })

    expect(graph.reasonCodes).not.toContain('activity-evidence-corrupt')
    expect(graph.reasonCodes).toContain('target-generation-unavailable')
    expect(graph.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityId: runId,
          evidenceId,
          evidenceChecksum: summary.checksum
        })
      ])
    )

    const wrongStorage = sealArtifactProvenanceGraph({
      target: { ...target(undefined), producerRunId: runId },
      notebookActivities: [
        {
          ...activity,
          run: run(runId, 0, {
            ...summary,
            storageKey: `execution-file-evidence/project/session/activity-${runId}/evidence.json`
          })
        }
      ],
      computeActivities: []
    })
    expect(wrongStorage.reasonCodes).toContain('activity-evidence-corrupt')
  })

  it('seals only the target reverse dependency closure', () => {
    const unrelated = notebookActivity('run-0', 0, [
      {
        relation: 'created',
        relativePath: 'unrelated.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-unrelated', 'unrelated.csv', checksum('f'))
      }
    ])
    const producerInput = notebookActivity('run-1', 1, [
      {
        relation: 'created',
        relativePath: 'data.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-data', 'data.csv', checksum('a'))
      }
    ])
    const producer = notebookActivity('run-2', 2, [
      {
        relation: 'present-before',
        relativePath: 'data.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-observed-data', 'data.csv', checksum('a'))
      },
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producer, unrelated, producerInput],
      computeActivities: []
    })

    expect(graph.completeness).toBe('complete')
    expect(graph.activities.map((activity) => activity.activityId)).toEqual([
      'run-1',
      'run-2',
      'artifact-publication:version-1'
    ])
    expect(graph.entities.map((entity) => entity.entityId)).toContain('file-generation:g-data')
    expect(graph.entities.map((entity) => entity.entityId)).not.toContain(
      'file-generation:g-observed-data'
    )
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'used',
        activityId: 'run-2',
        entityId: 'file-generation:g-data',
        authority: 'authoritative'
      })
    )
  })

  it('retains every member of a logical output that intersects the target closure', () => {
    const producerInput = notebookActivity(
      'run-1',
      1,
      [
        {
          relation: 'created',
          relativePath: 'maps/roads.shp',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-shp', 'maps/roads.shp', checksum('a'))
        },
        {
          relation: 'created',
          relativePath: 'maps/roads.dbf',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-dbf', 'maps/roads.dbf', checksum('c'))
        }
      ],
      {
        scientificOutputs: [
          {
            outputId: 'scientific-output-roads',
            storageShape: 'file-set',
            formatHint: 'shapefile',
            classificationAuthority: 'path-heuristic',
            members: ['maps/roads.dbf', 'maps/roads.shp'],
            riskCodes: ['format-validity-not-verified', 'multi-file-consistency-not-verified']
          }
        ]
      }
    )
    const producer = notebookActivity('run-2', 2, [
      {
        relation: 'present-before',
        relativePath: 'maps/roads.shp',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-shp', 'maps/roads.shp', checksum('a'))
      },
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producerInput, producer],
      computeActivities: []
    })

    expect(graph.outputGroups).toEqual([
      {
        outputId: 'scientific-output-roads',
        activityId: 'run-1',
        storageShape: 'file-set',
        formatHint: 'shapefile',
        memberEntityIds: ['file-generation:g-dbf', 'file-generation:g-shp'],
        riskCodes: ['format-validity-not-verified', 'multi-file-consistency-not-verified']
      }
    ])
    expect(graph.entities).toContainEqual(
      expect.objectContaining({ entityId: 'file-generation:g-dbf' })
    )
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'generated',
        activityId: 'run-1',
        entityId: 'file-generation:g-dbf'
      })
    )
    expect(projectArtifactReproducibility(graph, []).outputGroups[0]).toMatchObject({
      label: 'maps/roads',
      memberEntityIds: ['file-generation:g-dbf', 'file-generation:g-shp']
    })
  })

  it.each([
    {
      language: 'Python',
      kernelKind: 'python' as const,
      script: "plt.savefig('sin.png', dpi=120)",
      output: 'sin.png'
    },
    {
      language: 'R',
      kernelKind: 'r' as const,
      script: "ggsave('sin.png', plot = chart, dpi = 120)",
      output: 'sin.png'
    }
  ])(
    'keeps an input-free $language result with a direct filename eligible end to end',
    ({ kernelKind, script, output }) => {
      const producer = notebookActivity(
        'run-2',
        0,
        [
          {
            relation: 'created',
            relativePath: output,
            pathPortability: 'relative',
            authority: 'advisory',
            generation: generation('g-target', output, checksum('b'))
          }
        ],
        { kernelKind, script }
      )

      const graph = sealArtifactProvenanceGraph({
        target: { ...target(), filename: output },
        notebookActivities: [producer],
        computeActivities: []
      })
      const projected = projectArtifactReproducibility(graph, [])

      expect(graph.completeness).toBe('complete')
      expect(graph.activities[0]).toMatchObject({ activityId: 'run-2', evidenceState: 'available' })
      expect(projected.startFrontiers[0]).toMatchObject({
        frontierId: 'original-inputs',
        eligibility: 'available',
        crossingEntityIds: []
      })
    }
  )

  it('excludes sibling outputs from the same run when they are outside the target closure', () => {
    const producer = notebookActivity('run-2', 0, [
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      },
      {
        relation: 'created',
        relativePath: 'diagnostics.png',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-diagnostics', 'diagnostics.png', checksum('d'))
      }
    ])

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producer],
      computeActivities: []
    })

    expect(graph.entities.map((entity) => entity.entityId)).toContain('file-generation:g-target')
    expect(graph.entities.map((entity) => entity.entityId)).not.toContain(
      'file-generation:g-diagnostics'
    )
    expect(
      graph.edges.some(
        (edge) => edge.kind !== 'depends-on' && edge.entityId === 'file-generation:g-diagnostics'
      )
    ).toBe(false)
  })

  it('does not downgrade the target for incomplete evidence outside its dependency closure', () => {
    const unrelated = notebookActivity(
      'run-unrelated',
      0,
      [
        {
          relation: 'created',
          relativePath: 'unrelated.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-unrelated', 'unrelated.csv', checksum('f'))
        }
      ],
      {
        state: 'partial',
        fileReads: 'unavailable',
        writerAttribution: 'unavailable',
        reasonCodes: ['file-reads-not-observed', 'writer-not-isolated']
      }
    )
    const producer = notebookActivity('run-2', 1, [
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [unrelated, producer],
      computeActivities: []
    })

    expect(graph.completeness).toBe('complete')
    expect(graph.reasonCodes).toEqual([])
    expect(graph.activities.map((activity) => activity.activityId)).not.toContain('run-unrelated')
  })

  it('makes a corroborated registered-input and intermediate chain reproducible', () => {
    const prepare = notebookActivity(
      'run-1',
      0,
      [
        {
          relation: 'present-before',
          relativePath: 'measurements.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-observed-input', 'measurements.csv', checksum('a'))
        },
        {
          relation: 'created',
          relativePath: 'clean.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-clean', 'clean.csv', checksum('c'))
        }
      ],
      {
        kernelKind: 'python',
        script: "frame = pd.read_csv('measurements.csv'); frame.to_csv('clean.csv')",
        inputFiles: [
          {
            inputFileVersionId: 'upload-version-1',
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceProjectId: 'project-1',
            sourceSessionId: 'source-session-1',
            filename: 'measurements.csv',
            sizeBytes: 10,
            checksum: checksum('a'),
            storageKey: 'uploads/project-1/source-session-1/upload-1/content',
            association: 'resolver-accessed'
          }
        ]
      }
    )
    const publish = notebookActivity(
      'run-2',
      1,
      [
        {
          relation: 'present-before',
          relativePath: 'clean.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-observed-clean', 'clean.csv', checksum('c'))
        },
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      {
        kernelKind: 'r',
        script: "table <- data.table::fread('clean.csv'); data.table::fwrite(table, 'result.csv')"
      }
    )

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [prepare, publish],
      computeActivities: []
    })
    const projected = projectArtifactReproducibility(graph, [])

    expect(graph.completeness).toBe('complete')
    expect(graph.activities.map((activity) => activity.activityId)).toEqual([
      'run-1',
      'run-2',
      'artifact-publication:version-1'
    ])
    expect(projected.startFrontiers).toEqual([
      expect.objectContaining({ frontierId: 'original-inputs', eligibility: 'available' }),
      expect.objectContaining({
        frontierId: 'checkpoint:run-1',
        eligibility: 'available',
        reasonCodes: []
      }),
      expect.objectContaining({ frontierId: 'checkpoint:run-2', eligibility: 'available' })
    ])
  })

  it('keeps an intermediate boundary advisory without complete writer attribution', () => {
    const prepare = notebookActivity(
      'run-1',
      0,
      [
        {
          relation: 'created',
          relativePath: 'clean.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-clean', 'clean.csv', checksum('c'))
        }
      ],
      { writerAttribution: 'partial', reasonCodes: ['writer-not-isolated'] }
    )
    const publish = notebookActivity('run-2', 1, [
      {
        relation: 'present-before',
        relativePath: 'clean.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-observed-clean', 'clean.csv', checksum('c'))
      },
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [prepare, publish],
      computeActivities: []
    })
    const boundary = projectArtifactReproducibility(graph, []).startFrontiers.find(
      (frontier) => frontier.frontierId === 'checkpoint:run-1'
    )

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'used',
        activityId: 'run-2',
        entityId: 'file-generation:g-clean',
        authority: 'advisory'
      })
    )
    expect(boundary).toMatchObject({
      eligibility: 'blocked',
      reasonCodes: expect.arrayContaining(['writer-attribution-unavailable', 'advisory-boundary'])
    })
  })

  it('marks unknown kernel dependencies without adding unrelated same-epoch runs', () => {
    const first = notebookActivity('run-1', 1, [], { fileReads: 'unavailable' })
    const producer = notebookActivity(
      'run-2',
      2,
      [
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      { fileReads: 'unavailable' }
    )

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [first, producer],
      computeActivities: []
    })

    expect(graph.completeness).toBe('incomplete')
    expect(graph.reasonCodes).toEqual(
      expect.arrayContaining(['file-reads-unavailable', 'kernel-dependencies-unavailable'])
    )
    expect(graph.activities.map((activity) => activity.activityId)).not.toContain('run-1')
  })

  it('uses exact same-epoch activity dependencies instead of conservative kernel history', () => {
    const first = notebookActivity('run-1', 1, [])
    const producer = notebookActivity('run-2', 2, [
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [first, producer],
      computeActivities: [],
      notebookDependencies: {
        stalenessByRunId: { 'run-1': { state: 'clear' }, 'run-2': { state: 'clear' } },
        invalidatedByRunId: {},
        dependenciesByRunId: { 'run-1': [], 'run-2': ['run-1'] }
      }
    })

    expect(graph.completeness).toBe('complete')
    expect(graph.reasonCodes).toEqual([])
    expect(graph.edges).toContainEqual({
      kind: 'depends-on',
      activityId: 'run-2',
      dependencyActivityId: 'run-1',
      authority: 'authoritative',
      evidenceSource: 'dependency-analysis'
    })
    expect(graph.activities.find((activity) => activity.activityId === 'run-1')?.inclusion).toBe(
      'target-closure'
    )
    expect(artifactProvenanceGraphValue(graph)).toBe(true)

    const runs = [recipeRun('run-1', 1), recipeRun('run-2', 2)]
    const projection = projectArtifactReproducibility(graph, runs)
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph,
      inputFiles: [],
      runs
    })
    expect(projection.includedNotebookRunCount).toBe(2)
    expect(recipe.steps.map((step) => step.activityId)).toEqual(['run-1', 'run-2'])
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
  })

  it('keeps an unrelated completed run out of the executable target lineage', () => {
    const unrelated = notebookActivity('run-1', 1, [
      {
        relation: 'created',
        relativePath: 'unrelated.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-unrelated', 'unrelated.csv', checksum('a'))
      }
    ])
    const producer = notebookActivity('run-2', 2, [
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])
    const runs = [recipeRun('run-1', 1), recipeRun('run-2', 2)]
    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [unrelated, producer],
      computeActivities: [],
      notebookDependencies: {
        stalenessByRunId: { 'run-1': { state: 'clear' }, 'run-2': { state: 'clear' } },
        invalidatedByRunId: {},
        dependenciesByRunId: { 'run-1': [], 'run-2': [] }
      }
    })
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph,
      inputFiles: [],
      runs
    })

    expect(graph.activities.map((activity) => activity.activityId)).not.toContain('run-1')
    expect(recipe.steps.map((step) => step.activityId)).toEqual(['run-2'])
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
  })

  it('keeps an isolated conditional loop binding out of the target recipe', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-local-loop-'))
    const unrelated = notebookActivity(
      'run-1',
      1,
      [
        {
          relation: 'created',
          relativePath: 'unrelated.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-unrelated', 'unrelated.csv', checksum('a'))
        }
      ],
      { script: 'pct = 99' }
    )
    const producerScript = [
      'from collections import Counter',
      'counts = Counter()',
      'for label, count in counts.items():',
      '    pct = count * 100',
      '    print(label, pct)',
      'result = "ready"'
    ].join('\n')
    const producer = notebookActivity(
      'run-2',
      2,
      [
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      { script: producerScript }
    )
    const notebookRuns = [unrelated.run, producer.run]

    try {
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => notebookRuns }
      }).project({
        projectId: 'default-project',
        sessionId: 'session-1',
        throughRunId: 'run-2'
      })
      expect(dependencies.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(dependencies.dependenciesByRunId?.['run-2']).toEqual([])

      const graph = sealArtifactProvenanceGraph({
        target: target(),
        notebookActivities: [unrelated, producer],
        computeActivities: [],
        notebookDependencies: dependencies
      })
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs: [
          recipeRun('run-1', 1, { script: unrelated.run.script }),
          recipeRun('run-2', 2, { script: producerScript })
        ]
      })

      expect(graph.activities.map((activity) => activity.activityId)).not.toContain('run-1')
      expect(recipe.steps.map((step) => step.activityId)).toEqual(['run-2'])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('keeps a failed import attempt out of a later independent target recipe', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-failed-import-'))
    const failed = notebookActivity('run-1', 1, [], {
      script: 'import pandas as pd\nframe = pd.read_csv("inputs/groups.csv")',
      status: 'failed'
    })
    const producerScript = [
      'import csv',
      'from collections import Counter',
      'with open("inputs/groups.csv") as source:',
      '    counts = Counter(row["group"] for row in csv.DictReader(source))',
      'result = sum(counts.values())'
    ].join('\n')
    const producer = notebookActivity(
      'run-2',
      2,
      [
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      { script: producerScript }
    )
    const notebookRuns = [failed.run, producer.run]

    try {
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => notebookRuns }
      }).project({
        projectId: 'default-project',
        sessionId: 'session-1',
        throughRunId: 'run-2'
      })
      expect(dependencies.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(dependencies.dependenciesByRunId?.['run-2']).toEqual([])

      const graph = sealArtifactProvenanceGraph({
        target: target(),
        notebookActivities: [failed, producer],
        computeActivities: [],
        notebookDependencies: dependencies
      })
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs: [
          recipeRun('run-1', 1, { script: failed.run.script, status: 'failed' }),
          recipeRun('run-2', 2, { script: producerScript })
        ]
      })

      expect(graph.activities.map((activity) => activity.activityId)).not.toContain('run-1')
      expect(recipe.steps.map((step) => step.activityId)).toEqual(['run-2'])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('carries an exact same-kernel dependency from analysis into an executable recipe', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-dependencies-'))
    const first = notebookActivity('run-1', 0, [], {
      script: 'x = 1',
      kernelEpochId: 'epoch-python',
      environment: 'default-python'
    })
    const second = notebookActivity(
      'run-2',
      1,
      [
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      {
        script: 'y = x + 1',
        kernelEpochId: 'epoch-python',
        environment: 'default-python'
      }
    )
    const notebookRuns = [first.run, second.run]

    try {
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => notebookRuns }
      }).project({
        projectId: 'default-project',
        sessionId: 'session-1',
        throughRunId: 'run-2'
      })
      expect(dependencies.dependenciesByRunId?.['run-2']).toEqual(['run-1'])

      const graph = sealArtifactProvenanceGraph({
        target: target(),
        notebookActivities: [first, second],
        computeActivities: [],
        notebookDependencies: dependencies
      })
      const runs = [
        recipeRun('run-1', 0, { script: first.run.script }),
        recipeRun('run-2', 1, { script: second.run.script })
      ]
      const projection = projectArtifactReproducibility(graph, runs)
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs
      })

      expect(projection.includedNotebookRunCount).toBe(2)
      expect(recipe.steps.map((step) => step.activityId)).toEqual(['run-1', 'run-2'])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('keeps independent Python and R kernels separated through graph and recipe sealing', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-kernels-'))
    const pythonRun = notebookActivity(
      'run-1',
      0,
      [
        {
          relation: 'created',
          relativePath: 'unrelated.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-unrelated', 'unrelated.csv', checksum('a'))
        }
      ],
      {
        script: 'x = 1',
        kernelEpochId: 'epoch-python',
        kernelKind: 'python',
        environment: 'default-python'
      }
    )
    const rRun = notebookActivity(
      'run-2',
      1,
      [
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      {
        script: 'x <- 1',
        kernelEpochId: 'epoch-r',
        kernelKind: 'r',
        environment: 'default-r'
      }
    )
    const notebookRuns = [pythonRun.run, rRun.run]

    try {
      const dependencies = await new NotebookDependencyAnalyzer({
        storageRoot,
        repository: { readSessionRuns: async () => notebookRuns }
      }).project({
        projectId: 'default-project',
        sessionId: 'session-1',
        throughRunId: 'run-2'
      })
      expect(dependencies.dependenciesByRunId?.['run-2']).toEqual([])

      const graph = sealArtifactProvenanceGraph({
        target: target(),
        notebookActivities: [pythonRun, rRun],
        computeActivities: [],
        notebookDependencies: dependencies
      })
      const runs = [
        recipeRun('run-1', 0, { script: pythonRun.run.script }),
        recipeRun('run-2', 1, {
          script: rRun.run.script,
          kernelKind: 'r',
          environmentName: 'default-r'
        })
      ]
      const projection = projectArtifactReproducibility(graph, runs)
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: [],
        runs
      })

      expect(graph.activities.map((activity) => activity.activityId)).not.toContain('run-1')
      expect(projection.includedNotebookRunCount).toBe(1)
      expect(recipe.steps.map((step) => step.activityId)).toEqual(['run-2'])
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    } finally {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('keeps frozen context out of lineage when file reads are incomplete but kernel dependencies are exact', () => {
    const prior = notebookActivity('run-1', 1, [
      {
        relation: 'created',
        relativePath: 'prior.png',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-prior', 'prior.png', checksum('a'))
      }
    ])
    const producer = notebookActivity(
      'run-2',
      2,
      [
        {
          relation: 'present-before',
          relativePath: 'prior.png',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-observed-prior', 'prior.png', checksum('a'))
        },
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      {
        state: 'partial',
        fileReads: 'partial',
        reasonCodes: ['file-reads-not-observed', 'source-analysis-unsupported-call']
      }
    )

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [prior, producer],
      computeActivities: [],
      notebookDependencies: {
        stalenessByRunId: { 'run-1': { state: 'clear' }, 'run-2': { state: 'clear' } },
        invalidatedByRunId: {},
        dependenciesByRunId: { 'run-1': [], 'run-2': [] }
      }
    })

    expect(graph.activities.map((activity) => activity.activityId)).not.toContain('run-1')
    expect(graph.entities.map((entity) => entity.entityId)).not.toContain('file-generation:g-prior')
    expect(graph.edges).not.toContainEqual(
      expect.objectContaining({
        kind: 'used',
        activityId: 'run-2',
        entityId: 'file-generation:g-prior'
      })
    )
    expect(graph.reasonCodes).toEqual(
      expect.arrayContaining(['activity-evidence-partial', 'file-reads-unavailable'])
    )
    expect(graph.reasonCodes).not.toContain('kernel-epoch-conservative')
  })

  it('ignores missing dependencies outside the target closure', () => {
    const unrelated = notebookActivity('run-0', 0, [])
    const producer = notebookActivity('run-2', 2, [
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [unrelated, producer],
      computeActivities: [],
      notebookDependencies: {
        stalenessByRunId: { 'run-0': { state: 'clear' }, 'run-2': { state: 'clear' } },
        invalidatedByRunId: {},
        dependenciesByRunId: { 'run-0': ['run-missing'], 'run-2': [] }
      }
    })

    expect(graph.completeness).toBe('complete')
    expect(graph.reasonCodes).not.toContain('history-truncated')
    expect(graph.activities.map((activity) => activity.activityId)).not.toContain('run-0')
  })

  it('marks unavailable dependency analysis without adding unrelated same-epoch runs', () => {
    const first = notebookActivity('run-1', 1, [])
    const producer = notebookActivity(
      'run-2',
      2,
      [
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      { fileReads: 'complete' }
    )

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [first, producer],
      computeActivities: [],
      notebookDependencies: {
        stalenessByRunId: {
          'run-1': { state: 'clear' },
          'run-2': { state: 'unknown', reasons: ['analysis-unavailable'] }
        },
        invalidatedByRunId: {},
        dependenciesByRunId: { 'run-1': [] }
      }
    })

    expect(graph.completeness).toBe('incomplete')
    expect(graph.reasonCodes).toContain('kernel-dependencies-unavailable')
    expect(graph.activities.map((activity) => activity.activityId)).not.toContain('run-1')
  })

  it('preserves the exact registered input Version as an authoritative dependency', () => {
    const producer = notebookActivity(
      'run-2',
      2,
      [
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      {
        inputFiles: [
          {
            inputFileVersionId: 'upload-version-1',
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceProjectId: 'project-1',
            sourceSessionId: 'source-session-1',
            filename: 'input.csv',
            sizeBytes: 10,
            checksum: checksum('a'),
            storageKey: 'uploads/project-1/source-session-1/upload-1/content',
            association: 'resolver-accessed'
          }
        ]
      }
    )

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producer],
      computeActivities: []
    })

    expect(graph.entities).toContainEqual(
      expect.objectContaining({
        entityId: 'registered-input:upload-version:upload-version-1',
        kind: 'registered-input-generation',
        checksum: checksum('a')
      })
    )
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'used',
        activityId: 'run-2',
        entityId: 'registered-input:upload-version:upload-version-1',
        authority: 'authoritative',
        evidenceSource: 'registered-contract'
      })
    )
  })

  it('does not treat an unused turn attachment as a Notebook dependency', () => {
    const producer = notebookActivity(
      'run-2',
      2,
      [
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      {
        inputFiles: [
          {
            inputFileVersionId: 'upload-version-1',
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceProjectId: 'project-1',
            sourceSessionId: 'source-session-1',
            filename: 'input.csv',
            sizeBytes: 10,
            checksum: checksum('a'),
            storageKey: 'uploads/project-1/source-session-1/upload-1/content',
            association: 'turn-attached'
          }
        ]
      }
    )

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producer],
      computeActivities: []
    })
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph,
      inputFiles: producer.run.inputFiles ?? [],
      runs: [recipeRun('run-2', 2, { script: producer.run.script })]
    })
    const snapshot = buildBoundedExecutionSnapshot(
      {
        schemaVersion: 2,
        rootFrameId: 'root-1',
        agentFrameId: 'frame-1',
        messageBranchId: 'branch-1',
        terminalPromptMessageId: 'prompt-1',
        producerRunId: 'run-2',
        producerRunIndex: 2,
        createdAt: '2026-09-04T00:00:00.000Z',
        provenanceGraph: graph
      },
      [{ run: producer.run, runIndex: 2 }]
    )

    expect(graph.edges).not.toContainEqual(
      expect.objectContaining({
        kind: 'used',
        activityId: 'run-2',
        entityId: 'registered-input:upload-version:upload-version-1'
      })
    )
    expect(graph.entities).not.toContainEqual(
      expect.objectContaining({
        entityId: 'registered-input:upload-version:upload-version-1'
      })
    )
    expect(recipe.capture).toEqual({ state: 'sealed', reasonCodes: [] })
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    expect(snapshot.inputFiles).toEqual([])
    expect(snapshot.runs[0]?.inputFileVersionKeys).toEqual([])
    expect(snapshot.runs[0]).not.toHaveProperty('hasOmittedInputs')
    expect(snapshot.truncation).toBeUndefined()
  })

  it.each(['upload-version', 'artifact-version'] as const)('binds exact %s', (sourceKind) => {
    const producer = notebookActivity(
      'run-2',
      2,
      [
        {
          relation: 'present-before',
          relativePath: 'inputs/input.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-observed-input', 'inputs/input.csv', checksum('a')),
          registeredInput: {
            sourceKind,
            inputFileVersionId: 'upload-version-1',
            checksum: checksum('a')
          }
        },
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      {
        script: "rows = read_csv('inputs/input.csv'); save(rows, 'result.csv')",
        inputFiles: [
          {
            inputFileVersionId: 'upload-version-1',
            sourceKind,
            sourceFileId: 'upload-1',
            sourceProjectId: 'project-1',
            sourceSessionId: 'source-session-1',
            filename: 'input.csv',
            sizeBytes: 10,
            checksum: checksum('a'),
            storageKey: 'uploads/project-1/source-session-1/upload-1/content',
            association: 'turn-attached',
            accessEvidence: 'file-evidence'
          },
          {
            inputFileVersionId: 'upload-version-same-content',
            sourceKind,
            sourceFileId: 'upload-1',
            sourceProjectId: 'project-1',
            sourceSessionId: 'source-session-1',
            filename: 'input.csv',
            sizeBytes: 10,
            checksum: checksum('a'),
            storageKey: 'uploads/project-1/source-session-1/upload-2/content',
            association: 'turn-attached'
          }
        ]
      }
    )

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producer],
      computeActivities: []
    })
    const recipe = sealArtifactReproducibilityRecipe({
      provenanceGraph: graph,
      inputFiles: producer.run.inputFiles ?? [],
      runs: [recipeRun('run-2', 2, { script: producer.run.script })]
    })
    const snapshot = buildBoundedExecutionSnapshot(
      {
        schemaVersion: 2,
        rootFrameId: 'root-1',
        agentFrameId: 'frame-1',
        messageBranchId: 'branch-1',
        terminalPromptMessageId: 'prompt-1',
        producerRunId: 'run-2',
        producerRunIndex: 2,
        createdAt: '2026-09-04T00:00:00.000Z',
        provenanceGraph: graph
      },
      [{ run: producer.run, runIndex: 2 }]
    )

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'used',
        activityId: 'run-2',
        entityId: `registered-input:${sourceKind}:upload-version-1`,
        authority: 'authoritative',
        evidenceSource: 'runtime-observation'
      })
    )
    expect(graph.edges).not.toContainEqual(
      expect.objectContaining({
        kind: 'used',
        activityId: 'run-2',
        entityId: `registered-input:${sourceKind}:upload-version-same-content`
      })
    )
    expect(recipe.capture).toEqual({ state: 'sealed', reasonCodes: [] })
    expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
    expect(snapshot.inputFiles).toEqual([
      expect.objectContaining({ inputFileVersionId: 'upload-version-1' })
    ])
  })

  it.each([
    ['python', 'upload-version', 'copy.csv'],
    ['r', 'upload-version', 'local.csv'],
    ['python', 'artifact-version', 'local.csv'],
    ['r', 'artifact-version', 'copy.csv']
  ] as const)(
    'replays the observed file without guessing a %s %s identity from equal bytes (%s)',
    (kernelKind, sourceKind, filename) => {
      const producer = notebookActivity(
        'run-2',
        2,
        [
          {
            relation: 'present-before',
            relativePath: 'local.csv',
            pathPortability: 'relative',
            authority: 'advisory',
            generation: generation('g-local', 'local.csv', checksum('a'))
          },
          {
            relation: 'created',
            relativePath: 'result.csv',
            pathPortability: 'relative',
            authority: 'advisory',
            generation: generation('g-target', 'result.csv', checksum('b'))
          }
        ],
        {
          kernelKind,
          script:
            kernelKind === 'r'
              ? "write.csv(read.csv('local.csv'), 'result.csv')"
              : "pd.read_csv('local.csv').to_csv('result.csv')",
          inputFiles: [
            {
              inputFileVersionId: 'unrelated-version',
              sourceKind,
              sourceFileId: 'other-file',
              sourceProjectId: 'project-1',
              sourceSessionId: 'source-session-1',
              filename,
              sizeBytes: 10,
              checksum: checksum('a'),
              storageKey: 'other/content',
              association: 'turn-attached'
            }
          ]
        }
      )
      const graph = sealArtifactProvenanceGraph({
        target: target(),
        notebookActivities: [producer],
        computeActivities: []
      })
      expect(graph.edges).not.toContainEqual(
        expect.objectContaining({
          kind: 'used',
          entityId: `registered-input:${sourceKind}:unrelated-version`
        })
      )
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          kind: 'used',
          activityId: 'run-2',
          entityId: 'file-generation:g-local',
          authority: 'authoritative'
        })
      )
      const recipe = sealArtifactReproducibilityRecipe({
        provenanceGraph: graph,
        inputFiles: producer.run.inputFiles ?? [],
        runs: [recipeRun('run-2', 2, { kernelKind, script: producer.run.script })]
      })
      expect(recipe.capture).toEqual({ state: 'sealed', reasonCodes: [] })
      expect(resolveArtifactReproducibilityExecutionPlan(recipe, 'original-inputs')).toBeDefined()
      expect(
        recipe.frontiers.find((frontier) => frontier.frontierId === 'original-inputs')
          ?.crossingFiles
      ).toEqual([
        expect.objectContaining({
          entityId: 'file-generation:g-local',
          materializationPath: 'local.csv',
          contentStorageKey: `execution-file-evidence/blobs/sha256-${checksum('a')}`,
          checksum: checksum('a'),
          sizeBytes: 10
        })
      ])
    }
  )

  it.each(['modified', 'deleted', 'created', 'harvested-output'] as const)(
    'does not reconnect an old intermediate after its path was %s',
    (relation) => {
      const prepare = notebookActivity('run-0', 0, [
        {
          relation: 'created',
          relativePath: 'local.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-old', 'local.csv', checksum('a'))
        }
      ])
      const change = notebookActivity('run-1', 1, [
        {
          relation,
          relativePath: 'local.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          ...(relation === 'modified'
            ? { generation: generation('g-new', 'local.csv', checksum('c')) }
            : {})
        }
      ])
      // The file was supplied again outside these runs, with the old bytes.
      const producer = notebookActivity('run-2', 2, [
        {
          relation: 'present-before',
          relativePath: './local.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-local', './local.csv', checksum('a'))
        },
        {
          relation: 'created',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'advisory',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ])
      const graph = sealArtifactProvenanceGraph({
        target: target(),
        notebookActivities: [prepare, change, producer],
        computeActivities: []
      })
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          kind: 'used',
          activityId: 'run-2',
          entityId: 'file-generation:g-local',
          authority: 'authoritative'
        })
      )
      expect(graph.activities.map((activity) => activity.activityId)).toEqual([
        'run-2',
        'artifact-publication:version-1'
      ])
    }
  )

  it('connects a Compute output to its prior Notebook generation', () => {
    const notebook = notebookActivity('run-2', 2, [
      {
        relation: 'created',
        relativePath: 'data.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-data', 'data.csv', checksum('a'))
      }
    ])
    const computeEvidence = evidence(
      'job-1',
      [
        {
          relation: 'staged-input',
          relativePath: 'data.csv',
          pathPortability: 'relative',
          authority: 'explicit-transfer',
          generation: generation('g-compute-input', 'data.csv', checksum('a'))
        },
        {
          relation: 'harvested-output',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          authority: 'explicit-transfer',
          generation: generation('g-target', 'result.csv', checksum('b'))
        }
      ],
      { activityKind: 'compute-job', parentActivityId: 'run-2' }
    )
    const compute: ArtifactProvenanceComputeActivityInput = {
      activityId: 'job-1',
      parentActivityId: 'run-2',
      ordinal: 0,
      fileEvidence: computeEvidence.summary,
      evidenceJson: computeEvidence.json
    }

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [notebook],
      computeActivities: [compute]
    })

    expect(graph.activities.map((activity) => activity.activityId)).toEqual([
      'run-2',
      'job-1',
      'artifact-publication:version-1'
    ])
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'used',
        activityId: 'job-1',
        entityId: 'file-generation:g-data',
        authority: 'authoritative'
      })
    )
    expect(
      projectArtifactReproducibility(graph, []).activities.map((activity) => activity.kind)
    ).toEqual(['notebook-run', 'compute-job', 'artifact-publication'])
  })

  it('keeps Artifact publication available when activity evidence is corrupt', () => {
    const producer = notebookActivity('run-2', 2, [], { fileReads: 'unavailable' })
    producer.evidenceJson = '{}'

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producer],
      computeActivities: []
    })

    expect(graph.completeness).toBe('incomplete')
    expect(graph.reasonCodes).toEqual(
      expect.arrayContaining(['activity-evidence-corrupt', 'target-generation-unavailable'])
    )
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: 'generated',
        activityId: 'artifact-publication:version-1',
        entityId: 'artifact-version:version-1'
      })
    )
  })

  it('marks unfrozen absolute dependencies incomplete without persisting an absolute-path entity', () => {
    const producer = notebookActivity('run-2', 2, [
      {
        relation: 'remote-input-reference',
        relativePath: '/remote/input.csv',
        pathPortability: 'absolute',
        authority: 'explicit-transfer'
      },
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])

    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producer],
      computeActivities: []
    })

    expect(graph.completeness).toBe('incomplete')
    expect(graph.reasonCodes).toContain('absolute-path-unfrozen')
    expect(graph.entities.some((entity) => entity.kind === 'file-generation')).toBe(true)
    expect(JSON.stringify(graph)).not.toContain('/remote/input.csv')
  })

  it('validates exact graph fields and rejects dependency cycles', () => {
    const producer = notebookActivity('run-2', 2, [
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])
    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producer],
      computeActivities: []
    })
    expect(artifactProvenanceGraphValue(graph)).toBe(true)
    const legacyGraph = { ...graph }
    delete legacyGraph.outputGroups
    expect(artifactProvenanceGraphValue(legacyGraph)).toBe(true)
    expect(artifactProvenanceGraphValue({ ...graph, unknown: true })).toBe(false)
    expect(
      artifactProvenanceGraphValue({
        ...graph,
        outputGroups: [
          {
            outputId: 'invalid-group',
            activityId: 'run-2',
            storageShape: 'file-set',
            memberEntityIds: ['file-generation:g-target', 'missing-generation'],
            riskCodes: ['format-validity-not-verified']
          }
        ]
      })
    ).toBe(false)

    const cyclic = {
      ...graph,
      edges: [
        ...graph.edges,
        {
          kind: 'used',
          activityId: 'run-2',
          entityId: 'file-generation:g-target',
          authority: 'advisory',
          evidenceSource: 'runtime-observation'
        }
      ]
    }
    expect(artifactProvenanceGraphValue(cyclic)).toBe(false)
    expect(
      artifactProvenanceGraphValue({
        ...graph,
        activities: [
          ...graph.activities,
          ...Array.from({ length: 257 - graph.activities.length }, (_, index) => ({
            activityId: `extra-${index}`,
            kind: 'notebook-run',
            sequence: graph.activities.length + index,
            inclusion: 'target-closure',
            evidenceState: 'available'
          }))
        ]
      })
    ).toBe(false)
  })

  it('binds the graph target to the Artifact evidence identity and checksum', () => {
    const producer = notebookActivity('run-2', 2, [
      {
        relation: 'created',
        relativePath: 'result.csv',
        pathPortability: 'relative',
        authority: 'advisory',
        generation: generation('g-target', 'result.csv', checksum('b'))
      }
    ])
    const graph = sealArtifactProvenanceGraph({
      target: target(),
      notebookActivities: [producer],
      computeActivities: []
    })
    const snapshot: PersistedArtifactExecutionSnapshot = {
      schemaVersion: 2,
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      terminalPromptMessageId: 'prompt-1',
      producerRunId: 'run-2',
      producerRunIndex: 2,
      createdAt: '2026-08-31T00:00:00.000Z',
      inputFiles: [],
      runs: [
        {
          runId: 'run-2',
          runIndex: 2,
          agentFrameId: 'agent-1',
          messageBranchId: 'branch-1',
          runtimeSegmentId: 'runtime-1',
          promptMessageId: 'prompt-1',
          kernelKind: 'python',
          script: 'save()',
          status: 'completed',
          startedAt: '2026-08-31T00:00:00.000Z',
          outputs: [],
          inputFileVersionKeys: []
        }
      ],
      provenanceGraph: graph
    }
    const evidence: ArtifactVersionEvidence = {
      schema_version: 1,
      project_id: 'project-1',
      app_session_id: 'session-1',
      artifact_id: 'artifact-1',
      version_id: 'version-1',
      version_number: 1,
      filename: 'result.csv',
      size_bytes: 10,
      checksum: checksum('b'),
      created_at: '2026-08-31T00:00:00.000Z',
      conversation: {
        root_frame_id: 'root-1',
        agent_frame_id: 'agent-1',
        message_branch_id: 'branch-1',
        runtime_segment_id: 'runtime-1',
        prompt_message_id: 'prompt-1'
      },
      is_user_upload: false,
      execution_snapshot_checksum: checksum('e'),
      execution_status: { state: 'available' },
      inputs: [],
      producer: {
        state: 'available',
        notebook_session_id: 'session-1',
        producer_run_id: 'run-2',
        run_index: 2,
        kernel_kind: 'python',
        association_method: 'agent-declared-and-session-validated'
      },
      environment_status: { state: 'unavailable', reason: 'environment-not-supported' }
    }
    const expected = {
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      promptMessageId: 'prompt-1',
      producerRunId: 'run-2',
      producerRunIndex: 2,
      executionSnapshotChecksum: checksum('e'),
      evidence
    }

    expect(() => validateArtifactExecutionSnapshot(snapshot, expected)).not.toThrow()
    const targetEntity = graph.entities.find((entity) => entity.kind === 'artifact-version')!
    targetEntity.checksum = checksum('f')
    expect(() => validateArtifactExecutionSnapshot(snapshot, expected)).toThrow(
      'Artifact Version execution snapshot metadata mismatch.'
    )
  })
})

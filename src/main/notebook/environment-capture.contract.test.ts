import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ArtifactProvenanceGraph,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'

import { reproductionRecipes, reproductionEvidence } from '../artifacts/reproducibility-host'

import { EnvironmentStateTracker } from '@aipoch/environment'

let dataRoot: string | undefined

afterEach(async () => {
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
  dataRoot = undefined
})

describe('EnvironmentStateTracker', () => {
  it('publishes one content-addressed micromamba lock per unchanged environment revision', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-lock-'))
    const condaPrefix = join(dataRoot, 'runtime', 'envs', 'default-python')
    await mkdir(join(condaPrefix, 'conda-meta'), { recursive: true })
    await writeFile(join(condaPrefix, 'conda-meta', 'history'), 'created\n')
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify([
        {
          name: 'numpy',
          version: '2.2.0',
          url: 'https://conda.example/linux-64/numpy-2.2.0-py313_0.conda',
          md5: '0123456789abcdef0123456789abcdef'
        }
      ]),
      stderr: ''
    }))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      resolveMicromamba: vi.fn().mockResolvedValue('/runtime/micromamba'),
      execFile: execute,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '3.13.2',
        platform: 'linux',
        architecture: 'x64',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python'),
      now: () => new Date('2026-09-02T00:00:00.000Z')
    })

    const target = {
      language: 'python' as const,
      environmentName: 'default-python',
      runtimeSource: 'managed' as const,
      command: join(condaPrefix, 'bin', 'python'),
      condaPrefix
    }
    const live = {
      runtimeVersion: '3.13.2',
      packages: [
        {
          name: 'numpy',
          version: '2.2.0',
          versionStatus: 'known' as const,
          ecosystem: 'python' as const,
          evidenceSources: ['python-kernel-modules' as const]
        }
      ]
    }
    const capture = await tracker.captureCompletedRun(target, live)
    const repeated = await tracker.captureCompletedRun(target, live)

    expect(capture.environmentLock).toMatchObject({
      state: 'available',
      format: 'environment-lock-bundle',
      lockChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u)
    })
    if (capture.environmentLock.state === 'unavailable') throw new Error('Expected a lock.')
    expect(repeated.environmentLock).toMatchObject({
      state: 'available',
      lockChecksum: capture.environmentLock.lockChecksum
    })
    if (repeated.environmentLock.state === 'unavailable') throw new Error('Expected a lock.')
    const serialized = await readFile(
      join(
        dataRoot,
        'runtime',
        'provenance',
        'environment-locks',
        `${capture.environmentLock.lockChecksum}.json`
      ),
      'utf8'
    )
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 1,
      format: 'environment-lock-bundle',
      kernelKind: 'python',
      environmentName: 'default-python'
    })
    expect(JSON.parse(serialized)).not.toHaveProperty('capturedAt')
    expect(JSON.parse(serialized)).not.toHaveProperty('environmentManifestChecksum')

    const outputChecksum = 'a'.repeat(64)
    const graph: ArtifactProvenanceGraph = {
      schemaVersion: 1,
      targetEntityId: 'artifact-version:version-1',
      completeness: 'complete',
      reasonCodes: [],
      activities: [
        {
          activityId: 'run-1',
          kind: 'notebook-run',
          sequence: 0,
          runIndex: 0,
          inclusion: 'target-closure',
          evidenceState: 'available'
        },
        {
          activityId: 'artifact-publication:version-1',
          kind: 'artifact-publication',
          sequence: 1,
          parentActivityId: 'run-1',
          inclusion: 'target-closure',
          evidenceState: 'available'
        }
      ],
      entities: [
        {
          entityId: 'file-generation:output-1',
          kind: 'file-generation',
          generationId: 'output-1',
          relativePath: 'result.csv',
          pathPortability: 'relative',
          checksum: outputChecksum,
          sizeBytes: 10,
          contentStorageKey: `execution-file-evidence/blobs/sha256-${outputChecksum}`
        },
        {
          entityId: 'artifact-version:version-1',
          kind: 'artifact-version',
          versionId: 'version-1',
          filename: 'result.csv',
          checksum: outputChecksum,
          sizeBytes: 10
        }
      ],
      edges: [
        {
          kind: 'generated',
          activityId: 'run-1',
          entityId: 'file-generation:output-1',
          authority: 'advisory',
          evidenceSource: 'runtime-observation'
        },
        {
          kind: 'used',
          activityId: 'artifact-publication:version-1',
          entityId: 'file-generation:output-1',
          authority: 'authoritative',
          evidenceSource: 'artifact-publication'
        },
        {
          kind: 'generated',
          activityId: 'artifact-publication:version-1',
          entityId: 'artifact-version:version-1',
          authority: 'authoritative',
          evidenceSource: 'artifact-publication'
        }
      ]
    }
    const run: ProvenanceNotebookRun = {
      runId: 'run-1',
      runIndex: 0,
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1',
      kernelKind: 'python',
      environmentName: 'default-python',
      environmentLock: repeated.environmentLock,
      script: 'write_result()',
      status: 'completed',
      startedAt: '2026-09-02T00:00:00.000Z',
      completedAt: '2026-09-02T00:00:01.000Z',
      outputs: [],
      inputFileVersionKeys: []
    }
    const recipe = reproductionRecipes.sealArtifactReproducibilityRecipe({
      provenanceGraph: graph,
      inputFiles: [],
      runs: [run]
    })
    await expect(
      reproductionRecipes.prepareArtifactReproducibilityExecutionPlan(
        recipe,
        'original-inputs',
        reproductionEvidence(dataRoot)
      )
    ).resolves.toMatchObject({
      steps: [{ activityId: 'run-1' }],
      environmentRequirements: [{ lockChecksum: repeated.environmentLock.lockChecksum }]
    })

    expect(execute).toHaveBeenCalledTimes(1)
  })
})

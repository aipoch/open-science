import { describe, expect, it } from 'vitest'

import type { ArtifactVersionCoreProvenance } from '../../shared/artifact-provenance'
import type { HostArtifactCatalogItem } from '../../shared/project-files'
import { HostLineageService } from './host-lineage-service'

const artifact = (
  versionId: string,
  overrides: Partial<HostArtifactCatalogItem> = {}
): HostArtifactCatalogItem => ({
  source: 'artifact',
  sourceFileId: `file-${versionId}`,
  versionId,
  versionNumber: 1,
  checksum: 'a'.repeat(64),
  projectId: 'project-a',
  sessionId: 'session-a',
  filename: `${versionId}.csv`,
  contentType: 'text/csv',
  sizeBytes: 12,
  sortAtMs: Date.parse('2026-08-01T00:00:00.000Z'),
  createdAt: '2026-08-01T00:00:00.000Z',
  sourceCreatedAt: '2026-08-01T00:00:00.000Z',
  rootFrameId: 'root-a',
  agentFrameId: 'agent-a',
  ...overrides
})

const upload = (
  versionId: string,
  overrides: Partial<HostArtifactCatalogItem> = {}
): HostArtifactCatalogItem => ({
  source: 'upload',
  sourceFileId: `file-${versionId}`,
  versionId,
  versionNumber: 1,
  checksum: 'b'.repeat(64),
  projectId: 'project-a',
  sessionId: 'session-b',
  filename: `${versionId}.csv`,
  contentType: 'text/csv',
  sizeBytes: 24,
  sortAtMs: Date.parse('2026-08-02T00:00:00.000Z'),
  createdAt: '2026-08-02T00:00:00.000Z',
  sourceCreatedAt: '2026-08-02T00:00:00.000Z',
  rootFrameId: null,
  agentFrameId: null,
  ...overrides
})

describe('HostLineageService', () => {
  it('returns an upstream root-first graph with direct Upload inputs by default', async () => {
    const items = new Map([
      ['artifact-v1', artifact('artifact-v1')],
      ['upload-v1', upload('upload-v1')]
    ])
    const service = new HostLineageService({
      catalog: {
        readHostArtifactCatalog: async ({ projectId, versionId }) => {
          const item = versionId ? items.get(versionId) : undefined
          return item?.projectId === projectId ? [item] : []
        }
      },
      provenance: {
        readDependencyRelations: async ({ versionId, direction }) =>
          versionId === 'artifact-v1' && direction === 'up'
            ? [
                {
                  versionId: 'artifact-v1',
                  dependsOnVersionId: 'upload-v1',
                  ordinal: 0,
                  sourceKind: 'upload-version' as const,
                  inputFilename: 'upload-v1.csv',
                  association: 'turn-attached' as const
                }
              ]
            : [],
        getVersionCore: async () => ({}) as ArtifactVersionCoreProvenance
      }
    })

    await expect(
      service.graph('artifact-v1', undefined, {
        projectId: 'project-a',
        sessionId: 'session-current'
      })
    ).resolves.toEqual({
      project_id: 'project-a',
      root_version_id: 'artifact-v1',
      direction: 'up',
      truncated: false,
      nodes: [
        {
          file_id: 'file-artifact-v1',
          version_id: 'artifact-v1',
          filename: 'artifact-v1.csv',
          version_number: 1,
          session_id: 'session-a',
          root_frame_id: 'root-a',
          agent_frame_id: 'agent-a',
          created_at: '2026-08-01T00:00:00.000Z',
          content_type: 'text/csv',
          size_bytes: 12,
          checksum: 'a'.repeat(64),
          is_user_upload: false
        },
        {
          file_id: 'file-upload-v1',
          version_id: 'upload-v1',
          filename: 'upload-v1.csv',
          version_number: 1,
          session_id: 'session-b',
          root_frame_id: null,
          agent_frame_id: null,
          created_at: '2026-08-02T00:00:00.000Z',
          content_type: 'text/csv',
          size_bytes: 24,
          checksum: 'b'.repeat(64),
          is_user_upload: true
        }
      ],
      edges: [
        {
          version_id: 'artifact-v1',
          depends_on_version_id: 'upload-v1',
          ordinal: 0,
          source_kind: 'upload-version',
          input_filename: 'upload-v1.csv',
          association: 'turn-attached'
        }
      ]
    })
  })

  it('rejects unknown graph options and invalid option types or ranges', async () => {
    const service = new HostLineageService({
      catalog: { readHostArtifactCatalog: async () => [artifact('artifact-v1')] },
      provenance: {
        readDependencyRelations: async () => [],
        getVersionCore: async () => ({}) as ArtifactVersionCoreProvenance
      }
    })
    const context = { projectId: 'project-a', sessionId: 'session-current' }

    await expect(service.graph('artifact-v1', null, context)).rejects.toThrow(
      'host.lineage.graph options must be an object.'
    )
    await expect(
      service.graph('artifact-v1', { project_id: 'forged-project' }, context)
    ).rejects.toThrow('host.lineage.graph unknown option: project_id')
    await expect(service.graph('artifact-v1', { direction: 'sideways' }, context)).rejects.toThrow(
      "host.lineage.graph direction must be 'up' or 'down'."
    )
    await expect(service.graph('artifact-v1', { max_depth: 1.5 }, context)).rejects.toThrow(
      'host.lineage.graph max_depth must be an integer between 0 and 20.'
    )
    await expect(service.graph('artifact-v1', { max_depth: 21 }, context)).rejects.toThrow(
      'host.lineage.graph max_depth must be an integer between 0 and 20.'
    )
    await expect(service.graph('artifact-v1', { max_nodes: 0 }, context)).rejects.toThrow(
      'host.lineage.graph max_nodes must be an integer between 1 and 500.'
    )
    await expect(service.graph('artifact-v1', { max_nodes: 501 }, context)).rejects.toThrow(
      'host.lineage.graph max_nodes must be an integer between 1 and 500.'
    )
  })

  it('traverses down from an Upload in stable BFS order and terminates an anomalous cycle', async () => {
    const items = new Map([
      ['upload-v1', upload('upload-v1')],
      ['artifact-a', artifact('artifact-a', { sessionId: 'session-a' })],
      ['artifact-b', artifact('artifact-b', { sessionId: 'session-b' })],
      ['artifact-c', artifact('artifact-c', { sessionId: 'session-c' })]
    ])
    const relations = new Map<
      string,
      Array<{
        versionId: string
        dependsOnVersionId: string
        ordinal: number
        sourceKind: 'artifact-version' | 'upload-version'
        inputFilename: string
        association: 'turn-attached' | 'resolver-accessed'
      }>
    >([
      [
        'upload-v1',
        [
          {
            versionId: 'artifact-b',
            dependsOnVersionId: 'upload-v1',
            ordinal: 0,
            sourceKind: 'upload-version',
            inputFilename: 'upload-v1.csv',
            association: 'turn-attached'
          },
          {
            versionId: 'artifact-a',
            dependsOnVersionId: 'upload-v1',
            ordinal: 1,
            sourceKind: 'upload-version',
            inputFilename: 'upload-v1.csv',
            association: 'resolver-accessed'
          }
        ]
      ],
      [
        'artifact-a',
        [
          {
            versionId: 'artifact-c',
            dependsOnVersionId: 'artifact-a',
            ordinal: 1,
            sourceKind: 'artifact-version',
            inputFilename: 'artifact-a.csv',
            association: 'turn-attached'
          }
        ]
      ],
      [
        'artifact-b',
        [
          {
            versionId: 'artifact-c',
            dependsOnVersionId: 'artifact-b',
            ordinal: 0,
            sourceKind: 'artifact-version',
            inputFilename: 'artifact-b.csv',
            association: 'turn-attached'
          }
        ]
      ],
      [
        'artifact-c',
        [
          {
            versionId: 'artifact-a',
            dependsOnVersionId: 'artifact-c',
            ordinal: 2,
            sourceKind: 'artifact-version',
            inputFilename: 'artifact-c.csv',
            association: 'turn-attached'
          }
        ]
      ]
    ])
    const service = new HostLineageService({
      catalog: {
        readHostArtifactCatalog: async ({ projectId, versionId }) => {
          const item = versionId ? items.get(versionId) : undefined
          return item?.projectId === projectId ? [item] : []
        }
      },
      provenance: {
        readDependencyRelations: async ({ versionId }) => relations.get(versionId) ?? [],
        getVersionCore: async () => ({}) as ArtifactVersionCoreProvenance
      }
    })

    const graph = await service.graph(
      'upload-v1',
      { direction: 'down' },
      {
        projectId: 'project-a',
        sessionId: 'session-current'
      }
    )

    expect(graph.nodes.map((node) => node.version_id)).toEqual([
      'upload-v1',
      'artifact-a',
      'artifact-b',
      'artifact-c'
    ])
    expect(graph.edges.map((edge) => [edge.version_id, edge.depends_on_version_id])).toEqual([
      ['artifact-a', 'upload-v1'],
      ['artifact-b', 'upload-v1'],
      ['artifact-c', 'artifact-a'],
      ['artifact-c', 'artifact-b'],
      ['artifact-a', 'artifact-c']
    ])
    expect(graph).toMatchObject({ direction: 'down', truncated: false })
  })

  it('reports only real max_depth truncation with included boundary nodes as the frontier', async () => {
    const items = new Map([
      ['artifact-a', artifact('artifact-a')],
      ['artifact-b', artifact('artifact-b')],
      ['artifact-c', artifact('artifact-c')]
    ])
    const dependencies = new Map([
      [
        'artifact-a',
        [
          {
            versionId: 'artifact-a',
            dependsOnVersionId: 'artifact-b',
            ordinal: 0,
            sourceKind: 'artifact-version' as const,
            inputFilename: 'artifact-b.csv',
            association: 'turn-attached' as const
          }
        ]
      ],
      [
        'artifact-b',
        [
          {
            versionId: 'artifact-b',
            dependsOnVersionId: 'artifact-c',
            ordinal: 0,
            sourceKind: 'artifact-version' as const,
            inputFilename: 'artifact-c.csv',
            association: 'turn-attached' as const
          }
        ]
      ]
    ])
    const service = new HostLineageService({
      catalog: {
        readHostArtifactCatalog: async ({ versionId }) => {
          const item = versionId ? items.get(versionId) : undefined
          return item ? [item] : []
        }
      },
      provenance: {
        readDependencyRelations: async ({ versionId }) => dependencies.get(versionId) ?? [],
        getVersionCore: async () => ({}) as ArtifactVersionCoreProvenance
      }
    })
    const context = { projectId: 'project-a', sessionId: 'session-current' }

    await expect(service.graph('artifact-a', { max_depth: 0 }, context)).resolves.toMatchObject({
      truncated: true,
      truncation_reason: 'max_depth',
      frontier_version_ids: ['artifact-a'],
      nodes: [{ version_id: 'artifact-a' }],
      edges: []
    })
    await expect(service.graph('artifact-a', { max_depth: 1 }, context)).resolves.toMatchObject({
      truncated: true,
      truncation_reason: 'max_depth',
      frontier_version_ids: ['artifact-b'],
      nodes: [{ version_id: 'artifact-a' }, { version_id: 'artifact-b' }],
      edges: [{ version_id: 'artifact-a', depends_on_version_id: 'artifact-b' }]
    })
  })

  it('limits nodes including root and returns resumable max_nodes frontier ids', async () => {
    const items = new Map(
      ['artifact-a', 'artifact-b', 'artifact-c', 'artifact-d'].map((versionId) => [
        versionId,
        artifact(versionId)
      ])
    )
    const service = new HostLineageService({
      catalog: {
        readHostArtifactCatalog: async ({ versionId }) => {
          const item = versionId ? items.get(versionId) : undefined
          return item ? [item] : []
        }
      },
      provenance: {
        readDependencyRelations: async ({ versionId }) =>
          versionId === 'artifact-a'
            ? ['artifact-d', 'artifact-b', 'artifact-c'].map((dependsOnVersionId) => ({
                versionId: 'artifact-a',
                dependsOnVersionId,
                ordinal: dependsOnVersionId.charCodeAt(dependsOnVersionId.length - 1),
                sourceKind: 'artifact-version' as const,
                inputFilename: `${dependsOnVersionId}.csv`,
                association: 'turn-attached' as const
              }))
            : [],
        getVersionCore: async () => ({}) as ArtifactVersionCoreProvenance
      }
    })

    const graph = await service.graph(
      'artifact-a',
      { max_nodes: 2 },
      {
        projectId: 'project-a',
        sessionId: 'session-current'
      }
    )

    expect(graph).toMatchObject({
      truncated: true,
      truncation_reason: 'max_nodes',
      frontier_version_ids: ['artifact-b', 'artifact-c', 'artifact-d']
    })
    expect(graph.nodes.map((node) => node.version_id)).toEqual(['artifact-a', 'artifact-b'])
    expect(graph.edges.map((edge) => [edge.version_id, edge.depends_on_version_id])).toEqual([
      ['artifact-a', 'artifact-b']
    ])
  })

  it('projects immutable core provenance without storage or unrelated evidence', async () => {
    const item = artifact('artifact-v1', {
      sourceFileId: 'artifact-file-1',
      sessionId: 'session-other',
      filename: 'result.csv',
      versionNumber: 3,
      sizeBytes: 99,
      checksum: 'c'.repeat(64),
      createdAt: '2026-08-03T00:00:00.000Z',
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1'
    })
    const environment = {
      capture_kind: 'completed-run' as const,
      environment_name: 'science',
      kernel_kind: 'python' as const,
      runtime_source: 'managed' as const,
      runtime_version: '3.13.5',
      platform: 'darwin',
      architecture: 'arm64',
      packages: [
        {
          name: 'numpy',
          version: '2.0.0',
          version_status: 'known' as const,
          ecosystem: 'python' as const,
          evidence_sources: ['python-importlib-metadata' as const],
          loaded_state: 'loaded' as const,
          library_rank: 0,
          library_scope: 'environment' as const,
          built_for_runtime: '3.13',
          priority: 'other' as const,
          source: {
            type: 'github' as const,
            repository: 'numpy/numpy',
            ref: 'v2.0.0',
            commit: 'abc123'
          }
        }
      ],
      python_version: '3.13.5',
      inventory_sources: ['kernel-native' as const, 'operation-log' as const],
      installed_inventory: {
        captured_at: '2026-08-03T00:00:00.000Z',
        source: 'full-scan' as const,
        validation: 'full-scan' as const
      },
      op_log: [
        {
          operation_id: 'operation-1',
          timestamp: '2026-08-03T00:00:00.000Z',
          operation: 'install' as const,
          packages: ['numpy'],
          result: 'success' as const,
          attempts: [
            {
              group_ordinal: 0,
              installer: 'pip' as const,
              packages: ['numpy'],
              status: 'succeeded' as const,
              mutation_risk: 'confirmed' as const,
              reason: 'unknown' as const
            }
          ],
          fallback_used: false,
          inventory_refresh: 'published' as const,
          inventory_refresh_attempts: [
            {
              attempt: 1,
              trigger: 'terminal' as const,
              timestamp: '2026-08-03T00:00:01.000Z',
              result: 'published' as const
            }
          ],
          package_changes: [
            {
              name: 'numpy',
              ecosystem: 'python' as const,
              relationship: 'requested' as const,
              change: 'installed' as const,
              after_version: '2.0.0',
              library_rank: 0,
              library_scope: 'environment' as const,
              source: {
                type: 'github' as const,
                repository: 'numpy/numpy',
                ref: 'v2.0.0',
                commit: 'abc123'
              }
            }
          ]
        }
      ],
      op_log_truncation: {
        omitted_count: 2,
        earliest_retained_at: '2026-08-02T23:59:00.000Z'
      },
      captured_at: '2026-08-03T00:00:00.000Z',
      source_manifest_checksum: 'd'.repeat(64),
      complete: true,
      capture_status: 'complete' as const,
      warnings: ['environment capture warning']
    }
    const core = {
      descriptor: {
        id: 'artifact-v1',
        artifactId: 'artifact-file-1',
        versionId: 'artifact-v1',
        versionNumber: 3,
        checksum: 'c'.repeat(64),
        createdAt: '2026-08-03T00:00:00.000Z',
        projectId: 'project-a',
        sessionId: 'session-other',
        runId: 'artifact-run-internal',
        name: 'result.csv',
        mimeType: 'text/csv',
        size: 99,
        mtimeMs: 123,
        state: 'finalized' as const
      },
      contentStatus: { state: 'available' as const },
      evidence: {
        schema_version: 1 as const,
        project_id: 'project-a',
        app_session_id: 'session-other',
        artifact_id: 'artifact-file-1',
        version_id: 'artifact-v1',
        version_number: 3,
        filename: 'result.csv',
        content_type: 'text/csv',
        size_bytes: 99,
        checksum: 'c'.repeat(64),
        created_at: '2026-08-03T00:00:00.000Z',
        agent_name: 'Codex',
        conversation: {
          root_frame_id: 'root-1',
          agent_frame_id: 'agent-1',
          message_branch_id: 'branch-1',
          runtime_segment_id: 'runtime-1',
          prompt_message_id: 'prompt-1'
        },
        is_user_upload: false as const,
        reproduction_code: 'print("hello")',
        execution_snapshot_checksum: 'e'.repeat(64),
        execution_status: { state: 'available' as const },
        producer: {
          state: 'available' as const,
          notebook_session_id: 'notebook-1',
          producer_run_id: 'run-1',
          run_index: 4,
          kernel_kind: 'python' as const,
          association_method: 'agent-declared-and-session-validated' as const,
          environment_manifest_checksum: 'd'.repeat(64)
        },
        environment_status: { state: 'available' as const },
        environment,
        inputs: [
          {
            ordinal: 0,
            input_file_version_id: 'upload-v1',
            source_kind: 'upload-version' as const,
            source_file_id: 'upload-file-1',
            source_version_number: 1,
            source_created_at: '2026-08-02T00:00:00.000Z',
            source_project_id: 'project-a',
            source_session_id: 'session-input',
            filename: 'input.csv',
            content_type: 'text/csv',
            size_bytes: 42,
            checksum: 'f'.repeat(64),
            storage_key: 'uploads/project-a/private/content',
            strongest_association: 'resolver-accessed' as const
          }
        ]
      },
      messages: { state: 'available', items: [{ secret: 'message' }] },
      review: { state: 'available', value: { secret: 'review' } },
      path: '/private/artifact/path'
    } as unknown as ArtifactVersionCoreProvenance
    let inputSourceCreatedAt: string | undefined = '2026-08-02T00:00:00.000Z'
    const service = new HostLineageService({
      catalog: {
        readHostArtifactCatalog: async ({ versionId }) =>
          versionId === 'upload-v1'
            ? [
                upload('upload-v1', {
                  sourceFileId: 'upload-file-1',
                  sessionId: 'session-input',
                  filename: 'input.csv',
                  versionNumber: 1,
                  sizeBytes: 42,
                  checksum: 'f'.repeat(64),
                  createdAt: '2026-08-02T00:00:00.000Z',
                  sourceCreatedAt: inputSourceCreatedAt
                })
              ]
            : [item]
      },
      provenance: {
        readDependencyRelations: async () => [
          {
            versionId: 'artifact-v1',
            dependsOnVersionId: 'upload-v1',
            ordinal: 0,
            sourceKind: 'upload-version',
            inputFilename: 'input.csv',
            association: 'resolver-accessed'
          }
        ],
        getVersionCore: async () => core
      }
    })

    await expect(
      service.get('artifact-v1', { projectId: 'project-a', sessionId: 'session-current' })
    ).resolves.toEqual({
      project_id: 'project-a',
      artifact_id: 'artifact-file-1',
      version_id: 'artifact-v1',
      filename: 'result.csv',
      version_number: 3,
      session_id: 'session-other',
      root_frame_id: 'root-1',
      agent_frame_id: 'agent-1',
      message_branch_id: 'branch-1',
      runtime_segment_id: 'runtime-1',
      prompt_message_id: 'prompt-1',
      created_at: '2026-08-03T00:00:00.000Z',
      content_type: 'text/csv',
      size_bytes: 99,
      checksum: 'c'.repeat(64),
      agent_name: 'Codex',
      content_status: { state: 'available' },
      reproduction_code: 'print("hello")',
      execution_status: { state: 'available' },
      producer: {
        state: 'available',
        notebook_session_id: 'notebook-1',
        producer_run_id: 'run-1',
        run_index: 4,
        kernel_kind: 'python',
        association_method: 'agent-declared-and-session-validated',
        environment_manifest_checksum: 'd'.repeat(64)
      },
      environment_status: { state: 'available' },
      environment,
      inputs: [
        {
          ordinal: 0,
          version_id: 'upload-v1',
          file_id: 'upload-file-1',
          source_kind: 'upload-version',
          version_number: 1,
          created_at: '2026-08-02T00:00:00.000Z',
          session_id: 'session-input',
          filename: 'input.csv',
          content_type: 'text/csv',
          size_bytes: 42,
          checksum: 'f'.repeat(64),
          association: 'resolver-accessed'
        }
      ]
    })

    const inputEvidence = core.evidence.inputs[0] as { source_created_at?: string }
    delete inputEvidence.source_created_at
    inputSourceCreatedAt = undefined
    const nullableUploadResult = await service.get('artifact-v1', {
      projectId: 'project-a',
      sessionId: 'session-current'
    })
    expect(nullableUploadResult.inputs[0]).not.toHaveProperty('created_at')

    environment.op_log[0].attempts[0].reason = 'secret-reason' as 'unknown'
    await expect(
      service.get('artifact-v1', { projectId: 'project-a', sessionId: 'session-current' })
    ).rejects.toThrow('Artifact Version environment evidence is corrupt.')
    environment.op_log[0].attempts[0].reason = 'unknown'
    environment.op_log_truncation.omitted_count = 0
    await expect(
      service.get('artifact-v1', { projectId: 'project-a', sessionId: 'session-current' })
    ).rejects.toThrow('Artifact Version environment evidence is corrupt.')
  })

  it('returns a root-only graph and rejects Upload get or corrupt cross-Project identities', async () => {
    const service = new HostLineageService({
      catalog: {
        readHostArtifactCatalog: async ({ versionId }) =>
          versionId === 'upload-v1'
            ? [upload('upload-v1')]
            : versionId === 'cross-project-v1'
              ? [artifact('cross-project-v1', { projectId: 'project-b' })]
              : [artifact('artifact-v1')]
      },
      provenance: {
        readDependencyRelations: async () => [],
        getVersionCore: async () => ({}) as ArtifactVersionCoreProvenance
      }
    })
    const context = { projectId: 'project-a', sessionId: 'session-current' }

    await expect(service.graph('artifact-v1', {}, context)).resolves.toMatchObject({
      truncated: false,
      nodes: [{ version_id: 'artifact-v1' }],
      edges: []
    })
    await expect(service.get('upload-v1', context)).rejects.toThrow(
      'Upload has no generated lineage.'
    )
    await expect(service.graph('cross-project-v1', {}, context)).rejects.toThrow(
      'Artifact Version identity is corrupt'
    )
  })

  it('fails closed when a dependency reader returns a relation outside the current traversal', async () => {
    const service = new HostLineageService({
      catalog: { readHostArtifactCatalog: async () => [artifact('artifact-v1')] },
      provenance: {
        readDependencyRelations: async () => [
          {
            versionId: 'other-project-version',
            dependsOnVersionId: 'artifact-v1',
            ordinal: 0,
            sourceKind: 'artifact-version',
            inputFilename: 'artifact-v1.csv',
            association: 'turn-attached'
          }
        ],
        getVersionCore: async () => ({}) as ArtifactVersionCoreProvenance
      }
    })

    await expect(
      service.graph(
        'artifact-v1',
        { direction: 'up' },
        {
          projectId: 'project-a',
          sessionId: 'session-current'
        }
      )
    ).rejects.toThrow('Artifact dependency relation is corrupt')
  })

  it('uses locale-independent code-point ordering for stable BFS traversal', async () => {
    const versionIds = ['artifact_a', 'artifact-a', 'artifact-Z']
    const service = new HostLineageService({
      catalog: {
        readHostArtifactCatalog: async ({ versionId }) =>
          versionId === 'upload-v1' ? [upload('upload-v1')] : [artifact(String(versionId))]
      },
      provenance: {
        readDependencyRelations: async ({ versionId }) =>
          versionId === 'upload-v1'
            ? versionIds.map((outputVersionId) => ({
                versionId: outputVersionId,
                dependsOnVersionId: 'upload-v1',
                ordinal: 0,
                sourceKind: 'upload-version' as const,
                inputFilename: 'upload-v1.csv',
                association: 'turn-attached' as const
              }))
            : [],
        getVersionCore: async () => ({}) as ArtifactVersionCoreProvenance
      }
    })

    const graph = await service.graph(
      'upload-v1',
      { direction: 'down' },
      { projectId: 'project-a', sessionId: 'session-current' }
    )
    expect(graph.nodes.map((node) => node.version_id)).toEqual([
      'upload-v1',
      'artifact-Z',
      'artifact-a',
      'artifact_a'
    ])
  })
})

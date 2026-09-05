import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { NewCheck, TurnScope } from '../../shared/reviewer'
import { createPngBytes } from '../artifacts/artifact-test-fixtures'
import type { ReviewerArtifactReadResult, ReviewerHostServer } from './host-sdk'
import { ReviewerHostServer as ConcreteReviewerHostServer } from './host-sdk'
import { ReviewerMcpServer } from './mcp-server'
import { resolveTurnScope } from './scope'
import { buildReviewScopeSnapshot } from './scope-snapshot'
import { resolveReviewerTurnEvidence } from './turn-evidence'
import {
  callSubmitFindingsAfterReadingEvidence,
  type FrozenReviewerTurnBlock,
  type SubmittedReviewerCheck
} from './reviewer-mcp-test-client'

const VERSION_ID = 'gate-session:gate-message:work-product.bin'
const SOURCE_ID = 'gate-source-version'
const MESSAGE_HASH = 'gate-message-hash'
const ACTIVITY_HASH = 'gate-activity-hash'

type GateFixture = {
  name: string
  content: string
  plan?: FrozenReviewerTurnBlock['turnPlan']
  artifactRole?: 'work_product' | 'source_document'
  artifact?: ReviewerArtifactReadResult
  artifactRead?: Record<string, unknown>
  artifactView?: 'trace' | 'content'
  executionActivityIds?: string[]
  supportsImageInput?: boolean
  checks: SubmittedReviewerCheck[]
  expectedOutcome: 'pass' | 'flagged'
  expectedCoverage?: Partial<{
    traceRead: boolean
    contentRead: boolean
    mediaRead: boolean
    partial: boolean
  }>
}

const makeScope = (fixture: GateFixture): TurnScope => ({
  turnMessageId: 'gate-message',
  blocks: [
    {
      id: 'activity:gate-activity',
      kind: 'activity',
      sourceId: 'gate-activity',
      blockIndex: 0,
      contentHash: ACTIVITY_HASH
    },
    {
      id: 'message:gate-message',
      kind: 'message',
      sourceId: 'gate-message',
      blockIndex: 1,
      contentHash: MESSAGE_HASH
    }
  ],
  artifactVersionIds: fixture.artifactRole === 'work_product' ? [VERSION_ID] : [],
  ...(fixture.artifactRole === 'source_document' ? { sourceDocumentVersionIds: [SOURCE_ID] } : {})
})

const makeEvidence = (
  fixture: GateFixture
): Pick<ReviewerHostServer, 'readTurn' | 'queryExecutionLog' | 'readArtifact' | 'fileRole'> => ({
  readTurn: vi.fn<ReviewerHostServer['readTurn']>(() => [
    {
      id: 'activity:gate-activity',
      kind: 'activity' as const,
      sourceId: 'gate-activity',
      blockIndex: 0,
      contentHash: ACTIVITY_HASH,
      title: 'Gate execution',
      status: 'completed',
      rawOutput: { completed: true }
    },
    {
      id: 'message:gate-message',
      kind: 'message' as const,
      sourceId: 'gate-message',
      blockIndex: 1,
      contentHash: MESSAGE_HASH,
      role: 'agent',
      content: fixture.content,
      ...(fixture.plan ? { turnPlan: fixture.plan } : {}),
      ...(fixture.artifactRole === 'work_product' ? { artifactIds: [VERSION_ID] } : {})
    }
  ]),
  queryExecutionLog: vi.fn(() => [
    {
      activityId: 'gate-activity',
      title: 'Gate execution',
      status: 'completed',
      rawOutput: { completed: true },
      terminalExitCode: 0
    }
  ]),
  fileRole: vi.fn((id: string) => {
    if (fixture.artifactRole === 'source_document' && id === SOURCE_ID) return 'source_document'
    if (fixture.artifactRole === 'work_product' && id === VERSION_ID) return 'work_product'
    throw new Error(`Out-of-scope fixture Version ${id}`)
  }),
  readArtifact: vi.fn(async () => {
    if (!fixture.artifact) throw new Error('This fixture has no readable file evidence.')
    return fixture.artifact
  })
})

const fixtures: GateFixture[] = [
  {
    name: 'image trace-only review',
    content: 'Generated and attached the heatmap image.',
    artifactRole: 'work_product',
    artifactView: 'trace',
    artifact: {
      id: VERSION_ID,
      role: 'work_product',
      file: {
        filename: 'heatmap.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        checksum: 'a'.repeat(64),
        contentStatus: 'available'
      },
      producer: { kind: 'unavailable', reason: 'fixture trace' },
      limitations: []
    },
    checks: [
      {
        status: 'pass',
        claim: 'The heatmap generation and attachment completed.',
        evidence: 'Execution log and immutable Artifact trace confirm generation and attachment.',
        artifactVersionId: VERSION_ID,
        locator: {
          blockRef: { activityId: 'gate-activity', blockIndex: 0 },
          contentHash: ACTIVITY_HASH
        }
      }
    ],
    expectedOutcome: 'pass',
    expectedCoverage: { traceRead: true, contentRead: false, mediaRead: false }
  },
  {
    name: 'rendered image contradiction',
    content: 'The rendered image labels Dose in grams.',
    artifactRole: 'work_product',
    artifactView: 'content',
    supportsImageInput: true,
    artifact: {
      id: VERSION_ID,
      role: 'work_product',
      kind: 'media',
      delivery: 'delivered',
      filename: 'dose.png',
      mimeType: 'image/png',
      checksum: 'b'.repeat(64),
      sizeBytes: createPngBytes('rendered Dose (mg)').length,
      offset: 0,
      returnedBytes: createPngBytes('rendered Dose (mg)').length,
      truncated: false,
      limitations: [],
      data: createPngBytes('rendered Dose (mg)')
    },
    checks: [
      {
        status: 'fail',
        claim: 'The rendered label is grams.',
        evidence: 'Delivered image content visibly says Dose (mg), contradicting Dose (g).',
        artifactVersionId: VERSION_ID,
        locator: {
          blockRef: { messageId: 'gate-message', blockIndex: 1 },
          contentHash: MESSAGE_HASH
        }
      }
    ],
    expectedOutcome: 'flagged',
    expectedCoverage: { contentRead: true, mediaRead: true, partial: false }
  },
  {
    name: 'targeted source pages',
    content: 'The source reports 42 mg on page 4.',
    artifactRole: 'source_document',
    artifactRead: { id: SOURCE_ID, view: 'content', pages: [4] },
    artifact: {
      id: SOURCE_ID,
      role: 'source_document',
      kind: 'paged',
      format: 'pdf',
      targets: { pages: [4] },
      pageCount: 20,
      pages: [{ pageNumber: 4, text: 'Reported dose: 42 mg' }],
      partial: true,
      limitations: []
    },
    checks: [
      {
        status: 'pass',
        claim: 'The current-Turn source supports 42 mg.',
        evidence: `Trusted Source Document ${SOURCE_ID}, targeted page 4: Reported dose 42 mg.`
      }
    ],
    expectedOutcome: 'pass',
    expectedCoverage: { contentRead: true, mediaRead: false, partial: true }
  },
  {
    name: 'earlier-Turn abstention',
    content: 'This may summarize work from an earlier Turn; no current evidence contradicts it.',
    checks: [],
    expectedOutcome: 'pass'
  },
  {
    name: 'fabricated current-Turn reference',
    content: 'This Turn newly retrieved DOI 10.9999/fabricated, but no trace contains it.',
    checks: [
      {
        status: 'warn',
        claim: 'The newly retrieved concrete DOI is traceable.',
        evidence: 'The frozen current Turn and execution log contain no such newly claimed DOI.',
        locator: {
          blockRef: { messageId: 'gate-message', blockIndex: 1 },
          contentHash: MESSAGE_HASH
        }
      }
    ],
    executionActivityIds: ['gate-activity'],
    expectedOutcome: 'flagged'
  },
  {
    name: 'Plan completion',
    content: 'The response omitted the required report.',
    plan: {
      versionId: 'plan-v1',
      status: 'approved',
      content: { deliverables: ['report.md'] },
      binding: 'current-turn'
    },
    checks: [
      {
        status: 'fail',
        claim: 'The effective current-Turn Plan required report.md.',
        evidence:
          'The frozen approved Plan requires report.md and the completed Turn has no deliverable.',
        locator: {
          blockRef: { messageId: 'gate-message', blockIndex: 1 },
          contentHash: MESSAGE_HASH
        }
      }
    ],
    expectedOutcome: 'flagged'
  },
  {
    name: 'tabular values',
    content: 'The saved table reports sample A as 42 mg.',
    artifactRole: 'work_product',
    artifactView: 'content',
    artifact: {
      id: VERSION_ID,
      role: 'work_product',
      kind: 'tabular',
      columns: { sample: ['A'], dose_mg: ['42'] },
      rowCount: 1,
      rowsReturned: 1,
      rowCountComplete: true,
      sizeBytes: 20,
      offset: 0,
      returnedBytes: 20,
      truncated: false
    },
    checks: [
      {
        status: 'pass',
        claim: 'Sample A is 42 mg.',
        evidence: 'Bounded column-addressable content returns sample=A and dose_mg=42.',
        artifactVersionId: VERSION_ID
      }
    ],
    expectedOutcome: 'pass',
    expectedCoverage: { contentRead: true, mediaRead: false, partial: false }
  }
]

describe('Reviewer enhancement executable end-to-end gate', () => {
  it.each(fixtures)('$name completes one accepted Reviewer protocol', async (fixture) => {
    const scope = makeScope(fixture)
    const evidence = makeEvidence(fixture)
    const submitted = vi.fn<(checks: NewCheck[]) => Promise<void>>().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, submitted, evidence, 'initial', [], {
      supportsImageInput: fixture.supportsImageInput ?? false
    })
    const { endpoint, token } = await server.start()

    try {
      const protocol = await callSubmitFindingsAfterReadingEvidence(
        endpoint,
        token,
        fixture.checks,
        {
          artifactView: fixture.artifactView,
          artifactReads: fixture.artifactRead
            ? [fixture.artifactRead as { id: string }]
            : undefined,
          executionActivityIds: fixture.executionActivityIds,
          capture: true
        }
      )
      expect(submitted).toHaveBeenCalledOnce()
      const accepted = submitted.mock.calls[0]![0]
      expect(accepted.map(({ status }) => status)).toEqual(
        fixture.checks.map(({ status }) => status)
      )
      expect(
        accepted.some(({ status }) => status === 'warn' || status === 'fail') ? 'flagged' : 'pass'
      ).toBe(fixture.expectedOutcome)
      expect(protocol.toolResults.map(({ name }) => name)).toContain('read_turn')
      expect(protocol.toolResults.at(-1)?.name).toBe('submit_findings')
      if (fixture.executionActivityIds) {
        expect(server.evidenceCoverage.executionLogActivityIds).toEqual(
          new Set(fixture.executionActivityIds)
        )
      }
      if (fixture.expectedCoverage) {
        const versionId = fixture.artifactRole === 'source_document' ? SOURCE_ID : VERSION_ID
        expect(server.evidenceCoverage.artifactReads?.get(versionId)).toMatchObject(
          fixture.expectedCoverage
        )
      } else {
        expect(server.evidenceCoverage.artifactReads?.size ?? 0).toBe(0)
      }
    } finally {
      await server.stop()
    }
  })

  it('user stop changes the Plan completion boundary through routed turn evidence', async () => {
    const session: PersistedChatSession = {
      id: 'stop-gate-session',
      projectId: 'gate-project',
      title: 'Stopped Plan gate',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'stop-user',
          role: 'user',
          content: 'Create report.csv and publish a short summary.',
          status: 'complete',
          eventIds: [],
          contextWindowSamples: [
            {
              id: 'stop-sample',
              timestamp: 2,
              termination: { kind: 'stop', stopReason: 'cancelled' },
              contextWindow: { used: 120, size: 4096 },
              source: 'provider-response'
            }
          ],
          createdAt: 1,
          updatedAt: 2
        },
        {
          id: 'stop-intervention',
          role: 'user',
          content: 'Stop creating report.csv. Provide only the short prose summary instead.',
          responseToMessageId: 'stop-user',
          status: 'complete',
          eventIds: [],
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'stop-agent',
          role: 'agent',
          content: 'Stopped CSV generation. Summary: validation was cancelled before export.',
          status: 'complete',
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      activities: [],
      planHistoryProjections: [
        {
          artifactId: 'stop-plan',
          artifactVersionId: 'stop-plan-v1',
          artifactChecksum: 'stop-plan-checksum',
          originatingPromptMessageId: 'stop-user',
          revision: 1,
          approval: 'approved',
          lifecycle: 'in_progress',
          document: {
            schema_version: 1,
            task_summary: 'Create a CSV report and summary',
            phases: [
              {
                name: 'Delivery',
                delegations: [
                  {
                    name: 'Writer',
                    steps: [
                      {
                        title: 'Export report',
                        description: 'Create report.csv and publish a short summary.'
                      }
                    ]
                  }
                ]
              }
            ],
            desired_outputs: ['report.csv', 'short prose summary'],
            feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
          },
          stepStatuses: { 'Export report': { status: 'in_progress', updatedAt: 1 } },
          stepStates: { 'Export report': { status: 'in_progress' } },
          counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 1 }
        }
      ],
      runtimeContext: {
        version: 1,
        revision: 1,
        plan: {
          artifactId: 'stop-plan',
          artifactVersionId: 'stop-plan-v1',
          artifactChecksum: 'stop-plan-checksum',
          originatingPromptMessageId: 'stop-user',
          approval: 'approved',
          stepStatuses: { 'Export report': { status: 'in_progress', updatedAt: 1 } }
        }
      },
      artifacts: [],
      createdAt: 0,
      updatedAt: 3
    }
    const scope = resolveTurnScope(session, 'stop-agent')
    const evidence = await resolveReviewerTurnEvidence(session, scope)
    const snapshot = buildReviewScopeSnapshot(session, scope, evidence)
    const host = new ConcreteReviewerHostServer(session, scope, tmpdir(), undefined, snapshot)
    const submitted = vi.fn<(checks: NewCheck[]) => Promise<void>>().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, submitted, host, 'initial')
    const { endpoint, token } = await server.start()

    try {
      const protocol = await callSubmitFindingsAfterReadingEvidence(
        endpoint,
        token,
        (blocks) => {
          const startingRequest = blocks.find(({ sourceId }) => sourceId === 'stop-user')
          if (!startingRequest) throw new Error('Missing routed starting request')
          return [
            {
              status: 'pass',
              claim:
                'The stop cancelled report.csv, while the replacement prose-summary requirement was satisfied.',
              evidence:
                'The frozen Plan required report.csv and a summary; routed stop termination plus the user intervention cancelled the CSV boundary and retained only the summary.',
              locator: {
                blockRef: { messageId: 'stop-user', blockIndex: startingRequest.blockIndex },
                contentHash: startingRequest.contentHash
              }
            }
          ]
        },
        { capture: true }
      )

      const startingRequest = protocol.blocks.find(({ sourceId }) => sourceId === 'stop-user')
      const intervention = protocol.blocks.find(({ sourceId }) => sourceId === 'stop-intervention')
      expect(startingRequest).toMatchObject({
        turnPlan: {
          versionId: 'stop-plan-v1',
          status: 'active',
          binding: 'current-turn'
        },
        turnTerminationHistory: [{ kind: 'stop', stopReason: 'cancelled', timestamp: 2 }]
      })
      expect(intervention).toMatchObject({
        role: 'user',
        responseToMessageId: 'stop-user',
        content: 'Stop creating report.csv. Provide only the short prose summary instead.'
      })
      expect(scope.blocks.map(({ sourceId }) => sourceId)).toEqual([
        'stop-user',
        'stop-intervention',
        'stop-agent'
      ])
      expect(submitted).toHaveBeenCalledOnce()
      expect(submitted.mock.calls[0]![0]).toEqual([
        expect.objectContaining({ status: 'pass', locator: expect.any(Object) })
      ])
      expect(submitted.mock.calls[0]![0]).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ status: 'fail' })])
      )
      expect(protocol.toolResults.map(({ name }) => name)).toEqual(['read_turn', 'submit_findings'])
    } finally {
      await server.stop()
    }
  })

  it('opaque binary generation uses a real Work Product, trace only, and leaks no bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reviewer-opaque-gate-'))
    const opaqueBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef])
    const opaqueBase64 = opaqueBytes.toString('base64')
    const opaquePath = join(root, 'opaque', 'archive.bin')
    await mkdir(dirname(opaquePath), { recursive: true })
    await writeFile(opaquePath, opaqueBytes)
    const scope: TurnScope = {
      turnMessageId: 'gate-message',
      blocks: [
        {
          id: 'activity:gate-activity',
          kind: 'activity',
          sourceId: 'gate-activity',
          blockIndex: 0,
          contentHash: ACTIVITY_HASH
        },
        {
          id: 'message:gate-message',
          kind: 'message',
          sourceId: 'gate-message',
          blockIndex: 1,
          contentHash: MESSAGE_HASH
        }
      ],
      artifactVersionIds: [VERSION_ID]
    }
    const session: PersistedChatSession = {
      id: 'gate-session',
      projectId: 'gate-project',
      title: 'Opaque gate',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'gate-message',
          role: 'agent',
          content: 'Generated and attached the opaque archive.',
          status: 'complete',
          eventIds: [],
          artifactIds: [VERSION_ID],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      activities: [
        {
          id: 'gate-activity',
          kind: 'tool',
          title: 'Generate opaque archive',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          rawOutput: { saved: true },
          terminalExitCode: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      artifacts: [{ id: VERSION_ID, kind: 'managed-file', path: 'archive.bin' }],
      createdAt: 0,
      updatedAt: 2
    }
    const host = new ConcreteReviewerHostServer(session, scope, root, async () => ({
      path: opaquePath,
      filename: 'archive.bin',
      contentType: 'application/octet-stream'
    }))
    const submitted = vi.fn<(checks: NewCheck[]) => Promise<void>>().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, submitted, host, 'initial')
    const { endpoint, token } = await server.start()

    try {
      const protocol = await callSubmitFindingsAfterReadingEvidence(
        endpoint,
        token,
        [
          {
            status: 'pass',
            claim: 'The opaque Work Product was generated and attached.',
            evidence:
              'Execution log and immutable Artifact trace confirm generation and attachment.',
            artifactVersionId: VERSION_ID,
            locator: {
              blockRef: { activityId: 'gate-activity', blockIndex: 0 },
              contentHash: ACTIVITY_HASH
            }
          }
        ],
        { artifactView: 'trace', capture: true }
      )
      expect(submitted).toHaveBeenCalledOnce()
      expect(server.evidenceCoverage.artifactReads?.get(VERSION_ID)).toMatchObject({
        traceRead: true,
        contentRead: false,
        mediaRead: false
      })
      expect(JSON.stringify(protocol)).not.toContain(opaqueBase64)
      const unsupported = await host.readArtifact(VERSION_ID, { view: 'content' })
      expect(unsupported).toMatchObject({
        kind: 'unsupported',
        limitations: [{ kind: 'unsupported-format' }]
      })
      expect(JSON.stringify(unsupported)).not.toContain(opaqueBase64)
    } finally {
      await server.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

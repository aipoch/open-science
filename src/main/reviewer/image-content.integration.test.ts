import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { TurnScope } from '../../shared/reviewer'
import { ReviewerHostServer } from './host-sdk'
import { ReviewerMcpServer } from './mcp-server'
import { callSubmitFindingsAfterReadingEvidence } from './reviewer-mcp-test-client'

const renderDoseLabelFixture = async (label: 'Dose (g)' | 'Dose (mg)'): Promise<Buffer> => {
  const markerColor = label === 'Dose (mg)' ? '#000000' : '#ffffff'
  return sharp({ create: { width: 320, height: 100, channels: 4, background: '#ffffff' } })
    .composite([
      {
        // The marker and visible text are driven by the same label input. The marker gives this
        // integration test a deterministic visual-inspection seam without hard-coding a finding.
        input: Buffer.from(
          `<svg width="320" height="100"><rect x="0" y="0" width="8" height="8" fill="${markerColor}"/><text x="12" y="62" font-size="36">${label}</text></svg>`
        )
      }
    ])
    .png()
    .toBuffer()
}

const inspectRenderedDoseLabel = async (image: Buffer): Promise<'Dose (g)' | 'Dose (mg)'> => {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const marker = data.subarray(0, info.channels)
  return marker[0]! < 32 && marker[1]! < 32 && marker[2]! < 32 ? 'Dose (mg)' : 'Dose (g)'
}

describe('Reviewer rendered-image content fixture', () => {
  it('derives the inspected unit from delivered pixels', async () => {
    await expect(inspectRenderedDoseLabel(await renderDoseLabelFixture('Dose (mg)'))).resolves.toBe(
      'Dose (mg)'
    )
    await expect(inspectRenderedDoseLabel(await renderDoseLabelFixture('Dose (g)'))).resolves.toBe(
      'Dose (g)'
    )
  })

  it('reads final pixels and reports the exact producer-versus-rendered label contradiction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reviewer-image-content-'))
    const versionId = 'session-rendered:message-rendered:concentration.png'
    const artifactPath = join(
      root,
      'artifacts',
      'project-rendered',
      'session-rendered',
      'message-rendered',
      'concentration.png'
    )
    await mkdir(join(artifactPath, '..'), { recursive: true })
    const rendered = await renderDoseLabelFixture('Dose (mg)')
    await writeFile(artifactPath, rendered)

    const messageId = 'message-rendered'
    const activityId = 'activity-rendered'
    const session: PersistedChatSession = {
      id: 'session-rendered',
      projectId: 'project-rendered',
      title: 'Rendered label contradiction',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: messageId,
          role: 'agent',
          content: 'The final plot labels Dose in grams (g).',
          status: 'complete',
          eventIds: [],
          artifactIds: [versionId],
          createdAt: 2,
          updatedAt: 2
        }
      ],
      activities: [
        {
          id: activityId,
          kind: 'tool',
          title: 'Render concentration plot',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          rawInput: { requestedLabel: 'Dose (g)' },
          rawOutput: { saved: true },
          createdAt: 1,
          updatedAt: 1
        }
      ],
      artifacts: [
        {
          id: versionId,
          kind: 'managed-file',
          path: 'concentration.png',
          mimeType: 'image/png'
        }
      ],
      createdAt: 0,
      updatedAt: 2
    }
    const scope: TurnScope = {
      turnMessageId: messageId,
      blocks: [
        {
          id: `activity:${activityId}`,
          kind: 'activity',
          sourceId: activityId,
          blockIndex: 0,
          contentHash: 'activity-rendered-hash'
        },
        {
          id: `message:${messageId}`,
          kind: 'message',
          sourceId: messageId,
          blockIndex: 1,
          contentHash: 'message-rendered-hash'
        }
      ],
      artifactVersionIds: [versionId]
    }
    const host = new ReviewerHostServer(session, scope, root)
    const artifactContent = await host.readArtifact(versionId, { view: 'content' })
    if (
      !('kind' in artifactContent) ||
      artifactContent.kind !== 'media' ||
      artifactContent.delivery !== 'delivered'
    ) {
      throw new Error('Expected delivered image content for deterministic visual inspection.')
    }
    const renderedLabel = await inspectRenderedDoseLabel(artifactContent.data)
    const claimedLabel = 'Dose (g)'
    const contradictsClaim = renderedLabel !== claimedLabel
    const submitted = vi.fn().mockResolvedValue(undefined)
    const mcp = new ReviewerMcpServer(scope, submitted, host, 'initial', [], {
      supportsImageInput: true
    })
    const { endpoint, token } = await mcp.start()

    try {
      await callSubmitFindingsAfterReadingEvidence(
        endpoint,
        token,
        [
          {
            status: contradictsClaim ? 'fail' : 'pass',
            claim: 'The final plot labels Dose in grams (g).',
            evidence: contradictsClaim
              ? `The delivered image pixels encode and visibly render “${renderedLabel}”, contradicting the producer request and agent claim of “${claimedLabel}”.`
              : `The delivered image pixels visibly render “${renderedLabel}”, matching the producer request and agent claim.`,
            artifactVersionId: versionId,
            locator: {
              blockRef: { messageId, blockIndex: 1 },
              contentHash: 'message-rendered-hash'
            }
          }
        ],
        { artifactView: 'content' }
      )

      expect(submitted).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            status: 'fail',
            claim: 'The final plot labels Dose in grams (g).',
            evidence: expect.stringMatching(/Dose \(mg\).*Dose \(g\)/)
          })
        ],
        scope,
        {}
      )
      expect(mcp.evidenceCoverage.artifactReads?.get(versionId)).toMatchObject({
        traceRead: false,
        contentRead: true,
        mediaRead: true,
        partial: false,
        limitations: []
      })
    } finally {
      await mcp.stop().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })
})

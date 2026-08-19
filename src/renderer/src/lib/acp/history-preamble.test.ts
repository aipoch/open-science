import { describe, expect, it } from 'vitest'

import {
  buildHistoryPreamble,
  buildHistoryReplay,
  buildWorkspaceHistoryReplay,
  estimateHistoryTokens,
  resolveHistoryReplayBudget,
  resolveHistoryReplayTarget,
  resolveSessionHistoryReplayDescriptor
} from './history-preamble'
import type { ChatMessage } from '../../stores/session-store'
import type { AgentFrameworkView, ProviderView } from '../../../../shared/settings'

let messageId = 0
const message = (
  partial: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>
): ChatMessage =>
  ({
    id: `message-${messageId++}`,
    status: 'complete',
    eventIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...partial
  }) as ChatMessage

describe('agent-aware history replay', () => {
  it('returns undefined when there is nothing meaningful to replay', () => {
    expect(buildHistoryPreamble([])).toBeUndefined()
    expect(
      buildHistoryPreamble([
        message({ role: 'user', content: '   ' }),
        message({ role: 'agent', content: '', status: 'error' })
      ])
    ).toBeUndefined()
  })

  it('renders labelled user-led turns in order and skips failed content', () => {
    const preamble = buildHistoryPreamble([
      message({ role: 'agent', content: 'orphaned leading reply' }),
      message({ role: 'user', content: 'plot the data' }),
      message({ role: 'agent', content: 'failed draft', status: 'error' }),
      message({ role: 'agent', content: 'done, see chart.png' })
    ])

    expect(preamble).toContain('before you joined it')
    expect(preamble).not.toContain('orphaned leading reply')
    expect(preamble).not.toContain('failed draft')
    expect(preamble).toContain('**User:** plot the data')
    expect(preamble).toContain('**Assistant:** done, see chart.png')
    expect(preamble).not.toContain('does not authorize work')
    expect(preamble!.indexOf('**User:**')).toBeLessThan(preamble!.indexOf('**Assistant:**'))
  })

  it('labels a relayed side chat message as advisory instead of a user instruction', () => {
    const relayed = message({
      role: 'user',
      content: 'Please use a black line.'
    }) as ChatMessage & {
      relayedFrom: { kind: 'side-chat'; direction: 'to-main' }
    }
    relayed.relayedFrom = { kind: 'side-chat', direction: 'to-main' }

    const preamble = buildHistoryPreamble([relayed])

    expect(preamble).toContain('**Side chat advisory:** Please use a black line.')
    expect(preamble).not.toContain('**User:** Please use a black line.')
    expect(preamble).toContain('does not authorize work')
  })

  it('labels a Reviewer Correction by application attribution while keeping it user-led', () => {
    const preamble = buildHistoryPreamble([
      message({
        role: 'user',
        content: '[Auditor] Correct the unsupported claim.',
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'review-1'
        }
      }),
      message({ role: 'agent', content: 'I corrected the claim.' })
    ])

    expect(preamble).toContain('**Reviewer correction:** [Auditor] Correct the unsupported claim.')
    expect(preamble).not.toContain('**User:** [Auditor] Correct the unsupported claim.')
    expect(preamble).toContain('**Assistant:** I corrected the claim.')
  })

  it('keeps a side chat advisory inside the user turn that received it', () => {
    const relayed = message({
      role: 'user',
      content: 'Use a black line.'
    }) as ChatMessage & {
      relayedFrom: { kind: 'side-chat'; direction: 'to-main' }
    }
    relayed.relayedFrom = { kind: 'side-chat', direction: 'to-main' }

    const replay = buildHistoryReplay(
      [
        message({ role: 'user', content: 'Plot the curve.' }),
        relayed,
        message({ role: 'agent', content: `Analysis ${'detail '.repeat(120)}done.` })
      ],
      { target: 'codex-bridge', budget: 720 }
    )!

    expect(replay.preamble).toContain('## Conversation')
    expect(replay.preamble).not.toContain('## Recent conversation')
    expect(replay.preamble).toContain('**User:** Plot the curve.')
    expect(replay.preamble).toContain('**Side chat advisory:** Use a black line.')
    expect(replay.preamble).toContain('**Assistant:**')
  })

  it('uses distinct budgets for all four target classes', () => {
    expect(resolveHistoryReplayBudget({ target: 'claude-code' })).toBe(16_000)
    expect(resolveHistoryReplayBudget({ target: 'opencode' })).toBe(12_000)
    expect(resolveHistoryReplayBudget({ target: 'codex-response' })).toBe(16_000)
    expect(resolveHistoryReplayBudget({ target: 'codex-bridge' })).toBe(8_000)

    expect(resolveHistoryReplayBudget({ target: 'claude-code', contextWindow: 100_000 })).toBe(
      10_000
    )
    expect(resolveHistoryReplayBudget({ target: 'opencode', contextWindow: 100_000 })).toBe(8_000)
    expect(resolveHistoryReplayBudget({ target: 'codex-response', contextWindow: 100_000 })).toBe(
      10_000
    )
    expect(resolveHistoryReplayBudget({ target: 'codex-bridge', contextWindow: 100_000 })).toBe(
      5_000
    )
  })

  it('uses the conservative bridge cap when a caller omits its runtime descriptor', () => {
    const preamble = buildHistoryPreamble([
      message({ role: 'user', content: 'large history '.repeat(2_000) })
    ])!

    expect(estimateHistoryTokens(preamble)).toBeLessThanOrEqual(8_000)
  })

  it('keeps the original task and a contiguous recent suffix without orphan replies', () => {
    const messages = Array.from({ length: 20 }, (_, turn) => [
      message({ role: 'user', content: `user-${turn} ${'u'.repeat(80)}` }),
      message({ role: 'agent', content: `assistant-${turn} ${'a'.repeat(80)}` })
    ]).flat()
    const replay = buildHistoryReplay(messages, { target: 'codex-bridge', budget: 1_440 })!

    expect(replay.estimatedTokens).toBeLessThanOrEqual(replay.budget)
    expect(replay.preamble).toContain('user-0 ')
    expect(replay.preamble).toContain('user-19 ')
    expect(replay.preamble).toContain('assistant-19 ')
    expect(replay.preamble).toContain('middle turns omitted')
    expect(replay.preamble).not.toContain('assistant-10 ')

    const selectedRoles = replay.selectedMessageIndexes.map((index) => messages[index].role)
    expect(selectedRoles[0]).toBe('user')
    for (let index = 0; index < selectedRoles.length; index += 1) {
      if (selectedRoles[index] === 'agent') expect(selectedRoles.slice(0, index)).toContain('user')
    }
  })

  it('preserves both ends of a physically oversized user request inside its role', () => {
    const replay = buildHistoryReplay(
      [message({ role: 'user', content: `BEGIN-CONSTRAINT ${'界'.repeat(500)} END-CONSTRAINT` })],
      { target: 'codex-bridge', budget: 760 }
    )!

    expect(replay.estimatedTokens).toBeLessThanOrEqual(760)
    expect(replay.preamble).toContain('**User:** BEGIN-CONSTRAINT')
    expect(replay.preamble).toContain('END-CONSTRAINT')
    expect(replay.preamble).toContain('middle of this message omitted')
  })

  it('keeps a full latest user request plus a marked Assistant conclusion tail', () => {
    const replay = buildHistoryReplay(
      [
        message({ role: 'user', content: 'original task' }),
        message({ role: 'agent', content: 'original response' }),
        message({ role: 'user', content: 'please finish the analysis' }),
        message({
          role: 'agent',
          content: `${'working '.repeat(300)}FINAL-CONCLUSION`
        })
      ],
      { target: 'codex-bridge', budget: 920 }
    )!

    expect(replay.estimatedTokens).toBeLessThanOrEqual(920)
    expect(replay.preamble).toContain('**User:** please finish the analysis')
    expect(replay.preamble).toContain('earlier response omitted')
    expect(replay.preamble).toContain('FINAL-CONCLUSION')
  })

  it('uses UTF-8 bytes as a conservative tokenizer-independent upper bound', () => {
    expect(estimateHistoryTokens('a'.repeat(40))).toBe(40)
    expect(estimateHistoryTokens('界'.repeat(40))).toBe(120)
    expect(estimateHistoryTokens('😀'.repeat(10))).toBe(40)
  })

  it('replays media only from text-selected messages', () => {
    const turns = Array.from({ length: 10 }, (_, turn) => [
      message({
        role: 'user',
        content: `user-${turn} ${'x'.repeat(100)}`,
        uploads:
          turn === 4 || turn === 9
            ? [
                {
                  id: `upload-${turn}`,
                  versionId: `version-${turn}`,
                  sessionId: 'session-1',
                  name: `plot-${turn}.png`,
                  originalName: `plot-${turn}.png`,
                  path: `/uploads/plot-${turn}.png`,
                  mimeType: 'image/png',
                  size: 10
                },
                {
                  id: `document-${turn}`,
                  versionId: `document-version-${turn}`,
                  sessionId: 'session-1',
                  name: `notes-${turn}.pdf`,
                  originalName: `notes-${turn}.pdf`,
                  path: `/uploads/notes-${turn}.pdf`,
                  mimeType: 'application/pdf',
                  size: 20
                }
              ]
            : undefined
      }),
      message({ role: 'agent', content: `assistant-${turn} ${'y'.repeat(100)}` })
    ]).flat()
    const replay = buildWorkspaceHistoryReplay(
      turns,
      { target: 'codex-bridge', budget: 1_120 },
      'project-1'
    )!

    expect(replay.historyPreamble).toContain('user-9 ')
    expect(replay.historyPreamble).not.toContain('user-4 ')
    expect(replay.historyAttachments.map((item) => item.id)).toEqual(['upload-9', 'document-9'])
  })

  it.each(['claude-code', 'opencode', 'codex-response', 'codex-bridge'] as const)(
    'excludes a completed hidden control from a later %s replay',
    (target) => {
      const replay = buildWorkspaceHistoryReplay(
        [
          message({ role: 'user', content: 'Build a reusable workflow.' }),
          message({ role: 'agent', content: 'The workflow is complete.' }),
          message({ role: 'user', content: 'Save as skill', turnIntent: 'save-as-skill' }),
          message({ role: 'agent', content: 'This workflow is not reusable yet.' })
        ],
        { target }
      )!

      expect(replay.historyPreamble).not.toContain('Save as skill')
      expect(replay.historyPreamble).toContain('This workflow is not reusable yet.')
    }
  )

  it('reserves capped upload replay for an older selected image before recent documents', () => {
    const messages = [
      message({
        role: 'user',
        content: 'original task with image',
        uploads: [
          {
            id: 'original-image',
            versionId: 'original-image-version',
            sessionId: 'session-1',
            name: 'original.png',
            originalName: 'original.png',
            path: '/uploads/original.png',
            mimeType: 'image/png',
            size: 10
          }
        ]
      }),
      ...Array.from({ length: 10 }, (_, index) =>
        message({
          role: 'user',
          content: `document turn ${index}`,
          uploads: [
            {
              id: `document-${index}`,
              versionId: `document-version-${index}`,
              sessionId: 'session-1',
              name: `document-${index}.txt`,
              originalName: `document-${index}.txt`,
              path: `/uploads/document-${index}.txt`,
              mimeType: 'text/plain',
              size: 10
            }
          ]
        })
      )
    ]

    const replay = buildWorkspaceHistoryReplay(messages, { target: 'claude-code' }, 'project-1')!
    const attachmentIds = replay.historyAttachments.map((attachment) => attachment.id)

    expect(attachmentIds).toHaveLength(10)
    expect(attachmentIds).toContain('original-image')
    expect(attachmentIds).not.toContain('document-0')
    expect(attachmentIds).toContain('document-9')
  })

  it('fills the upload cap with documents after omitting images for a text-only model', () => {
    const messages = [
      ...Array.from({ length: 10 }, (_, index) =>
        message({
          role: 'user',
          content: `image turn ${index}`,
          uploads: [
            {
              id: `image-${index}`,
              versionId: `image-version-${index}`,
              sessionId: 'session-1',
              name: `image-${index}.png`,
              originalName: `image-${index}.png`,
              path: `/uploads/image-${index}.png`,
              mimeType: index === 0 ? 'application/octet-stream' : 'image/png',
              size: 10
            }
          ]
        })
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        message({
          role: 'user',
          content: `document turn ${index}`,
          uploads: [
            {
              id: `document-${index}`,
              versionId: `document-version-${index}`,
              sessionId: 'session-1',
              name: `document-${index}.txt`,
              originalName: `document-${index}.txt`,
              path: `/uploads/document-${index}.txt`,
              mimeType: 'text/plain',
              size: 10
            }
          ]
        })
      )
    ]

    const replay = buildWorkspaceHistoryReplay(
      messages,
      { target: 'claude-code' },
      'project-1',
      false
    )!

    expect(replay.historyAttachments.map((attachment) => attachment.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `document-${index}`)
    )
    expect(replay.historyImages).toEqual([])
  })

  it('keeps media-only Assistant output when an oversized turn is projected', () => {
    const imageMessage = message({
      role: 'agent',
      content: '',
      images: [{ id: 'result-image', mimeType: 'image/png', data: 'AQID', byteLength: 3 }]
    })
    const replay = buildWorkspaceHistoryReplay(
      [
        message({ role: 'user', content: 'original task' }),
        message({ role: 'agent', content: 'original answer' }),
        message({ role: 'user', content: 'keep the generated screenshot' }),
        message({ role: 'agent', content: 'working '.repeat(300) }),
        imageMessage
      ],
      { target: 'codex-bridge', budget: 920 }
    )!

    expect(replay.historyPreamble).toContain('**Assistant:** [media attached]')
    expect(replay.historyImages).toEqual([
      expect.objectContaining({
        data: 'AQID',
        sourceMessageId: imageMessage.id,
        sourceImageId: 'result-image'
      })
    ])
  })
})

describe('history replay target resolution', () => {
  const provider = (apiEndpoints: ProviderView['apiEndpoints']): ProviderView =>
    ({ apiEndpoints }) as ProviderView
  const codex = {
    id: 'codex',
    displayName: 'Codex',
    supportsSkills: true,
    supportedApiTypes: ['responses']
  } as AgentFrameworkView

  it('uses the provider endpoint contract to distinguish direct Responses and bridge Codex', () => {
    expect(resolveHistoryReplayTarget('claude-code')).toBe('claude-code')
    expect(resolveHistoryReplayTarget('opencode')).toBe('opencode')
    expect(resolveHistoryReplayTarget('codex', provider(['responses']), codex)).toBe(
      'codex-response'
    )
    expect(resolveHistoryReplayTarget('codex', provider(['openai']), codex)).toBe('codex-bridge')
  })

  it('derives persisted session policy from its backend instead of active settings', () => {
    const bridgeProvider = {
      id: 'persisted-provider',
      apiEndpoints: ['openai'],
      contextWindow: 100_000
    } as ProviderView

    expect(
      resolveSessionHistoryReplayDescriptor(
        {
          agentFrameworkId: 'codex',
          agentBackendId: 'codex:persisted-provider',
          agentModel: 'persisted-model'
        },
        [bridgeProvider],
        [codex]
      )
    ).toEqual({ target: 'codex-bridge', contextWindow: 100_000 })
  })

  it('falls back to the conservative bridge policy when a persisted Codex provider is gone', () => {
    expect(
      resolveSessionHistoryReplayDescriptor(
        {
          agentFrameworkId: 'codex',
          agentBackendId: 'codex:removed-provider',
          agentModel: 'persisted-model'
        },
        [],
        [codex]
      )
    ).toEqual({ target: 'codex-bridge', contextWindow: undefined })
  })
})

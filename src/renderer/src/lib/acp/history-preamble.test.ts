import { describe, expect, it } from 'vitest'

import {
  buildHistoryPreamble,
  buildHistoryReplay,
  buildWorkspaceHistoryReplay,
  estimateHistoryTokens,
  resolveHistoryReplayBudget,
  resolveHistoryReplayTarget
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
    expect(preamble!.indexOf('**User:**')).toBeLessThan(preamble!.indexOf('**Assistant:**'))
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

  it('keeps the original task and a contiguous recent suffix without orphan replies', () => {
    const messages = Array.from({ length: 20 }, (_, turn) => [
      message({ role: 'user', content: `user-${turn} ${'u'.repeat(80)}` }),
      message({ role: 'agent', content: `assistant-${turn} ${'a'.repeat(80)}` })
    ]).flat()
    const replay = buildHistoryReplay(messages, { target: 'codex-bridge', budget: 360 })!

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
      { target: 'codex-bridge', budget: 190 }
    )!

    expect(replay.estimatedTokens).toBeLessThanOrEqual(190)
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
      { target: 'codex-bridge', budget: 230 }
    )!

    expect(replay.estimatedTokens).toBeLessThanOrEqual(230)
    expect(replay.preamble).toContain('**User:** please finish the analysis')
    expect(replay.preamble).toContain('earlier response omitted')
    expect(replay.preamble).toContain('FINAL-CONCLUSION')
  })

  it('counts CJK conservatively', () => {
    expect(estimateHistoryTokens('a'.repeat(40))).toBe(10)
    expect(estimateHistoryTokens('界'.repeat(40))).toBe(40)
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
      { target: 'codex-bridge', budget: 280 },
      'project-1'
    )!

    expect(replay.historyPreamble).toContain('user-9 ')
    expect(replay.historyPreamble).not.toContain('user-4 ')
    expect(replay.historyAttachments.map((item) => item.id)).toEqual(['upload-9', 'document-9'])
  })

  it('keeps media-only Assistant output when an oversized turn is projected', () => {
    const replay = buildWorkspaceHistoryReplay(
      [
        message({ role: 'user', content: 'original task' }),
        message({ role: 'agent', content: 'original answer' }),
        message({ role: 'user', content: 'keep the generated screenshot' }),
        message({ role: 'agent', content: 'working '.repeat(300) }),
        message({
          role: 'agent',
          content: '',
          images: [{ id: 'result-image', mimeType: 'image/png', data: 'AQID', byteLength: 3 }]
        })
      ],
      { target: 'codex-bridge', budget: 230 }
    )!

    expect(replay.historyPreamble).toContain('**Assistant:** [media attached]')
    expect(replay.historyImages).toEqual([expect.objectContaining({ data: 'AQID' })])
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
})

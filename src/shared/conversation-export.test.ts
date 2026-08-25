import { describe, expect, it } from 'vitest'

import {
  createConversationExportDocument,
  createConversationExportTurns,
  renderConversationHtml,
  renderConversationMarkdown,
  sanitizeExportFilename,
  sanitizeExportMarkdown
} from './conversation-export'
import type { PersistedChatSession } from './session-persistence'

const createSession = (): PersistedChatSession => ({
  id: 'session-internal-id',
  projectId: 'project-internal-id',
  title: 'Protein <analysis>',
  cwd: '/secret/workspace',
  status: 'idle',
  agentBackendId: 'private-backend',
  agentModel: 'private-model',
  messages: [
    {
      id: 'message-user-id',
      role: 'user',
      content: '# Question\n\nUse **Markdown**.',
      status: 'complete',
      eventIds: ['event-private'],
      artifactIds: ['artifact-1'],
      uploads: [
        {
          id: 'upload-private',
          sessionId: 'session-internal-id',
          name: 'safe-name.csv',
          originalName: 'measurements.csv',
          mimeType: 'text/csv',
          size: 42,
          path: '/secret/measurements.csv'
        }
      ],
      createdAt: 1_710_000_000_000,
      updatedAt: 1_710_000_000_000
    },
    {
      id: 'message-agent-id',
      role: 'agent',
      content:
        '<think>\nprivate chain of thought\n</think>\n\nAnswer.\n\n<think>more private thought</think>',
      status: 'complete',
      eventIds: [],
      createdAt: 1_710_000_001_000,
      updatedAt: 1_710_000_001_000
    }
  ],
  artifacts: [
    {
      id: 'artifact-1',
      kind: 'managed-file',
      path: '/secret/generated/report.pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf'
    }
  ],
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_002_000
})

describe('conversation export projection', () => {
  it('removes complete provider think blocks while preserving ordinary Markdown', () => {
    expect(
      sanitizeExportMarkdown(
        '<think>\nfirst\n</think>\n\n# Result\n\n**kept**\n<think>second</think>'
      )
    ).toBe('# Result\n\n**kept**')
  })

  it('removes an unterminated provider think block through the end of the response', () => {
    expect(sanitizeExportMarkdown('before <think>unfinished private reasoning')).toBe('before')
  })

  it('projects only user-facing active messages and attachment names', () => {
    const document = createConversationExportDocument(createSession(), 1_710_000_003_000)

    expect(document).toMatchObject({
      version: 1,
      title: 'Protein <analysis>',
      messages: [
        {
          role: 'user',
          markdown: '# Question\n\nUse **Markdown**.',
          attachments: [
            { name: 'measurements.csv', mimeType: 'text/csv' },
            { name: 'report.pdf', mimeType: 'application/pdf' }
          ],
          images: []
        },
        {
          role: 'assistant',
          markdown: 'Answer.',
          attachments: [],
          images: []
        }
      ]
    })
    expect(JSON.stringify(document)).not.toContain('session-internal-id')
    expect(JSON.stringify(document)).not.toContain('/secret/')
    expect(JSON.stringify(document)).not.toContain('private-model')
    expect(JSON.stringify(document)).not.toContain('private chain of thought')
  })

  it('excludes hidden control messages from content and title projection', () => {
    const session = createSession()
    session.title = ''
    session.messages.unshift({
      id: 'hidden-control',
      role: 'user',
      content: 'Save as skill',
      status: 'complete',
      eventIds: [],
      turnIntent: 'save-as-skill',
      createdAt: 1_709_999_999_000,
      updatedAt: 1_709_999_999_000
    })

    const document = createConversationExportDocument(session, 1_710_000_003_000)

    expect(document.title).toBe('Question Use **Markdown**.')
    expect(document.messages).toHaveLength(2)
    expect(JSON.stringify(document)).not.toContain('Save as skill')
  })

  it('groups visible messages into prompt-owned turns without relying on response metadata', () => {
    const session = createSession()
    session.messages.push(
      {
        id: 'message-user-2',
        role: 'user',
        content: 'Follow-up question',
        status: 'complete',
        eventIds: [],
        createdAt: 1_710_000_004_000,
        updatedAt: 1_710_000_004_000
      },
      {
        id: 'message-agent-2',
        role: 'agent',
        content: 'Follow-up answer',
        status: 'complete',
        eventIds: [],
        createdAt: 1_710_000_005_000,
        updatedAt: 1_710_000_005_000
      }
    )

    expect(createConversationExportTurns(session.messages)).toMatchObject([
      {
        promptMessageId: 'message-user-id',
        messages: [{ id: 'message-user-id' }, { id: 'message-agent-id' }]
      },
      {
        promptMessageId: 'message-user-2',
        messages: [{ id: 'message-user-2' }, { id: 'message-agent-2' }]
      }
    ])
  })

  it('exports selected turns in conversation order and rejects stale prompt ids', () => {
    const session = createSession()
    session.messages.push(
      {
        id: 'message-user-2',
        role: 'user',
        content: 'Follow-up question',
        status: 'complete',
        eventIds: [],
        createdAt: 1_710_000_004_000,
        updatedAt: 1_710_000_004_000
      },
      {
        id: 'message-agent-2',
        role: 'agent',
        content: 'Follow-up answer',
        status: 'complete',
        eventIds: [],
        createdAt: 1_710_000_005_000,
        updatedAt: 1_710_000_005_000
      }
    )

    const document = createConversationExportDocument(session, 1_710_000_006_000, [
      'message-user-2'
    ])

    expect(document.messages.map((message) => message.markdown)).toEqual([
      'Follow-up question',
      'Follow-up answer'
    ])
    expect(() =>
      createConversationExportDocument(session, 1_710_000_006_000, ['missing-prompt'])
    ).toThrow('Selected conversation turns are no longer available.')
  })

  it('keeps the complete conversation title when the first turn is not selected', () => {
    const session = createSession()
    const firstPrompt =
      'Create a detailed reproducible research note comparing three open-science data management approaches.'
    session.messages[0].content = firstPrompt
    session.title = `${firstPrompt.slice(0, 48)}...`
    session.messages.push({
      id: 'message-user-2',
      role: 'user',
      content: 'Only export this follow-up',
      status: 'complete',
      eventIds: [],
      createdAt: 1_710_000_004_000,
      updatedAt: 1_710_000_004_000
    })

    const document = createConversationExportDocument(session, 1_710_000_005_000, [
      'message-user-2'
    ])

    expect(document.title).toBe(firstPrompt)
  })

  it('preserves think tags supplied by the user while removing assistant reasoning blocks', () => {
    const session = createSession()
    session.messages[0].content = 'Explain `<think>` and preserve <think>this example</think>.'

    const document = createConversationExportDocument(session, 1_710_000_003_000)

    expect(document.messages[0].markdown).toContain('<think>this example</think>')
    expect(document.messages[1].markdown).toBe('Answer.')
  })

  it('reduces attachment display names to basenames before export', () => {
    const session = createSession()
    session.messages[0].uploads![0].originalName = '/Users/researcher/private/measurements.csv'
    session.artifacts![0].name = String.raw`C:\Users\researcher\private\report.pdf`

    const document = createConversationExportDocument(session, 1_710_000_003_000)

    expect(document.messages[0].attachments).toEqual([
      { name: 'measurements.csv', mimeType: 'text/csv' },
      { name: 'report.pdf', mimeType: 'application/pdf' }
    ])
    expect(JSON.stringify(document)).not.toContain('researcher')
  })

  it('replaces legacy truncated automatic titles with a complete prompt-derived title', () => {
    const session = createSession()
    const prompt =
      'Create a detailed reproducible research note comparing three open-science data management approaches. Include:\n- tables\n- code'
    session.messages[0].content = prompt
    session.title = `${prompt.replace(/\s+/g, ' ').slice(0, 48)}...`

    expect(createConversationExportDocument(session, 1_710_000_003_000).title).toBe(
      'Create a detailed reproducible research note comparing three open-science data management approaches. Include: - tables - code'
    )
  })

  it('replaces headless task automatic titles with the complete prompt-derived title', () => {
    const session = createSession()
    const prompt =
      'Generate a reproducible analysis of the longitudinal dataset and summarize every validation step.'
    session.messages[0].content = prompt
    session.title = `${prompt.replace(/\s+/g, ' ').slice(0, 57)}...`

    expect(createConversationExportDocument(session, 1_710_000_003_000).title).toBe(prompt)
  })

  it('keeps the complete prompt-derived document title beyond the filename limit', () => {
    const session = createSession()
    const prompt = `😀${'x'.repeat(300)}`
    session.messages[0].content = prompt
    session.title = `${prompt.replace(/\s+/g, ' ').slice(0, 48)}...`

    const title = createConversationExportDocument(session, 1_710_000_003_000).title

    expect(title).toBe(prompt)
  })

  it('preserves manually assigned titles even when they end in an ellipsis', () => {
    const session = createSession()
    session.title = 'Lab notes...'
    session.messages[0].content =
      'Create a detailed reproducible research note comparing three approaches.'

    expect(createConversationExportDocument(session, 1_710_000_003_000).title).toBe('Lab notes...')
  })

  it('renders a normalized Markdown document without internal metadata', () => {
    const session = createSession()
    session.title = 'Protein\n<analysis>'
    session.messages[0].uploads![0].originalName = 'measurements_[final].csv'
    const markdown = renderConversationMarkdown(
      createConversationExportDocument(session, 1_710_000_003_000)
    )

    expect(markdown).toContain('title: "Protein <analysis>"')
    expect(markdown).toContain('# Protein \\<analysis\\>')
    expect(markdown).toContain('## User')
    expect(markdown).toContain('## Assistant')
    expect(markdown).toContain('- measurements\\_\\[final\\].csv (text/csv)')
    expect(markdown).not.toContain('/secret/')
    expect(markdown).not.toContain('<think>')
  })

  it('renders safe PDF HTML with Markdown formatting and no active embedded content', () => {
    const session = createSession()
    session.messages[0].content =
      '<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![remote](https://example.com/a.png)'
    const html = renderConversationHtml(createConversationExportDocument(session, Date.now()))

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<img')
    expect(html).toContain('[Image: remote]')
    expect(html).toContain("default-src 'none'")
  })

  it('includes persisted message images in PDF HTML without exposing them in Markdown', () => {
    const session = createSession()
    session.messages[1].images = [
      {
        id: 'image-1',
        mimeType: 'image/png',
        data: 'AQID',
        byteLength: 3
      }
    ]
    const document = createConversationExportDocument(session, 1_710_000_003_000)

    expect(renderConversationHtml(document)).toContain('src="data:image/png;base64,AQID"')
    expect(renderConversationMarkdown(document)).not.toContain('AQID')
    expect(renderConversationMarkdown(document)).toContain('- Image 1 (image/png)')
  })

  it('creates portable filenames and only truncates near filesystem byte limits', () => {
    expect(sanitizeExportFilename('  Results: alpha/beta?  ')).toBe('Results alpha beta')
    expect(sanitizeExportFilename('...')).toBe('conversation')
    expect(
      sanitizeExportFilename(
        'Create a detailed reproducible research note comparing three open-science data management approaches.'
      )
    ).toBe(
      'Create a detailed reproducible research note comparing three open-science data management approaches'
    )
    expect(sanitizeExportFilename('x'.repeat(300))).toBe(`${'x'.repeat(237)}...`)
    expect(sanitizeExportFilename('界'.repeat(80))).toBe('界'.repeat(80))
    expect(sanitizeExportFilename(`${'界'.repeat(81)}tail`)).toBe(`${'界'.repeat(79)}...`)
  })
})

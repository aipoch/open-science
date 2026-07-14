import { renderToStaticMarkup } from 'react-dom/server'
import type { JSX, PropsWithChildren } from 'react'
import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import type { UploadedAttachment } from '../../../../shared/uploads'
import { describe, expect, it, vi } from 'vitest'

import type { ToolActivityDetails } from './workspace-tool-activity-details'

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

vi.mock('@/components/ui/message-scroller', () => {
  const Wrapper = ({ children }: PropsWithChildren): JSX.Element => <div>{children}</div>
  const Item = ({
    children,
    messageId
  }: PropsWithChildren<{ messageId?: string }>): JSX.Element => (
    <div data-message-id={messageId}>{children}</div>
  )
  const Button = (): JSX.Element => <button type="button">Scroll to end</button>

  return {
    MessageScrollerProvider: Wrapper,
    MessageScroller: Wrapper,
    MessageScrollerViewport: Wrapper,
    MessageScrollerContent: Wrapper,
    MessageScrollerItem: Item,
    MessageScrollerButton: Button
  }
})

vi.mock('@/lib/utils', () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' '),
  formatByteSize: (size: number | undefined) =>
    typeof size === 'number' && size >= 0 ? `${size} B` : undefined
}))

// Stub the highlighted/diff blocks so SSR output stays deterministic without loading Shiki.
vi.mock('./WorkspaceToolCodeBlock', () => ({
  WorkspaceToolCodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="tool-code-block" data-language={language}>
      {code}
    </pre>
  )
}))

vi.mock('./WorkspaceToolDiffBlock', () => ({
  WorkspaceToolDiffBlock: ({
    section
  }: {
    section: { oldText: string | null; newText: string }
  }) => (
    <pre data-testid="tool-diff-block">
      {section.oldText}
      {section.newText}
    </pre>
  )
}))

vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: {
    getState: () => ({ upsertAndActivateItem: vi.fn() })
  }
}))

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Session',
  cwd: '/workspace',
  status: 'running',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createActivity = (overrides: Partial<ToolActivity>): ToolActivity => ({
  id: 'tool-search-1',
  kind: 'tool',
  title: '"top news July 6 2026"',
  status: 'completed',
  eventIds: ['event-1'],
  sortIndex: 2,
  toolKind: 'fetch',
  createdAt: 1710000000001,
  updatedAt: 1710000000001,
  ...overrides
})

const createUpload = (overrides: Partial<UploadedAttachment> = {}): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: 'session-1',
  name: 'first.png',
  originalName: 'first.png',
  path: '/Users/example/.open-science/uploads/default-project/session-1/first.png',
  mimeType: 'image/png',
  size: 1024,
  ...overrides
})

const renderScroller = async (session: ChatSession): Promise<string> => {
  const { WorkspaceMessageScroller } = await import('./WorkspaceMessageScroller')

  return renderToStaticMarkup(<WorkspaceMessageScroller activeSession={session} />)
}

describe('WorkspaceMessageScroller loading render', () => {
  it('renders an accessible agent loading row before streamed text arrives', async () => {
    const html = await renderScroller(
      createSession({
        activeRun: {
          promptMessageId: 'prompt-1',
          startedAt: 1710000000100
        },
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'Summarize this'
          })
        ]
      })
    )

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Agent is responding')
    expect(html).toContain('data-message-id="session-1-agent-loading"')
  })

  it('does not render loading after current-run agent text arrives', async () => {
    const html = await renderScroller(
      createSession({
        activeRun: {
          promptMessageId: 'prompt-1',
          startedAt: 1710000000100
        },
        messages: [
          createMessage({ id: 'prompt-1' }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Answer text',
            status: 'streaming',
            streamId: 'assistant-message-1',
            responseToMessageId: 'prompt-1'
          })
        ]
      })
    )

    expect(html).not.toContain('role="status"')
    expect(html).toContain('Answer text')
  })

  it('does not render loading for permission waits or missing active runs', async () => {
    const runningSession = createSession({
      activeRun: {
        promptMessageId: 'prompt-1',
        startedAt: 1710000000100
      },
      messages: [createMessage({ id: 'prompt-1' })]
    })

    await expect(
      renderScroller({ ...runningSession, status: 'waiting-permission' })
    ).resolves.not.toContain('role="status"')
    await expect(
      renderScroller({ ...runningSession, activeRun: undefined })
    ).resolves.not.toContain('role="status"')
  })

  it('renders generated artifact gallery cards under agent messages', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: 'prompt-1' }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Created the file',
            artifactIds: ['artifact-1']
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/Users/example/.open-science/artifacts/default-project/session-1/reply-1/result.txt',
            fileUrl:
              'file:///Users/example/.open-science/artifacts/default-project/session-1/reply-1/result.txt',
            name: 'result.txt',
            mimeType: 'text/plain',
            size: 2048,
            mtimeMs: 1710000000100
          }
        ]
      })
    )

    expect(html).toContain('Created the file')
    expect(html).toContain('GENERATED · 1')
    expect(html).toContain('type="button"')
    expect(html).not.toContain('href="file:///Users/example/.open-science')
    expect(html).toContain('result.txt')
    expect(html).toContain('aria-label="Preview generated file result.txt"')
    expect(html).toContain('TXT')
  })

  it('renders image cards and a more button for larger generated artifact sets without file urls', async () => {
    const artifacts = Array.from({ length: 7 }, (_, index) => ({
      id: `artifact-${index + 1}`,
      kind: 'managed-file' as const,
      path: `/Users/example/.open-science/artifacts/default-project/session-1/reply-1/file-${index + 1}.png`,
      fileUrl: `file:///Users/example/.open-science/artifacts/default-project/session-1/reply-1/file-${index + 1}.png`,
      name: `file-${index + 1}.png`,
      mimeType: 'image/png',
      size: 2048,
      mtimeMs: 1710000000100 + index
    }))

    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({ id: 'prompt-1' }),
          createMessage({
            id: 'reply-1',
            role: 'agent',
            content: 'Created the files',
            artifactIds: artifacts.map((artifact) => artifact.id)
          })
        ],
        artifacts
      })
    )

    expect(html).toContain('GENERATED · 7')
    expect(html).not.toContain('src="file:///Users/example/.open-science')
    expect(html).toContain('PNG')
    expect(html).toContain('+2 more')
    expect(html).toContain('aria-label="Expand generated files"')
    expect(html).not.toContain('Close generated files')
  })

  it('does not render generated artifact files under user messages', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'Please create a file',
            artifactIds: ['artifact-1']
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/Users/example/.open-science/artifacts/default-project/session-1/prompt-1/user-only.txt',
            fileUrl:
              'file:///Users/example/.open-science/artifacts/default-project/session-1/prompt-1/user-only.txt',
            name: 'user-only.txt',
            mimeType: 'text/plain',
            size: 1024,
            mtimeMs: 1710000000100
          }
        ]
      })
    )

    expect(html).toContain('Please create a file')
    expect(html).not.toContain('Generated files')
    expect(html).not.toContain('user-only.txt')
  })

  it('renders user-message uploads above prompt text in attachment order', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'What is in the first image',
            uploads: [
              createUpload({
                id: 'upload-1',
                name: 'pasted-image-2026-07-08T06-17-13.png',
                originalName: 'pasted-image-2026-07-08T06-17-13.png'
              }),
              createUpload({
                id: 'upload-2',
                name: 'pasted-image-2026-07-08T06-17-25.png',
                originalName: 'pasted-image-2026-07-08T06-17-25.png',
                path: '/Users/example/.open-science/uploads/default-project/session-1/pasted-image-2026-07-08T06-17-25.png'
              })
            ]
          })
        ]
      })
    )

    const firstIndex = html.indexOf('pasted-image-2026-07-08T06-17-13.png')
    const secondIndex = html.indexOf('pasted-image-2026-07-08T06-17-25.png', firstIndex + 1)
    const textIndex = html.indexOf('What is in the first image')

    expect(firstIndex).toBeGreaterThan(-1)
    expect(secondIndex).toBeGreaterThan(firstIndex)
    expect(textIndex).toBeGreaterThan(secondIndex)
    expect(html).toContain(
      'aria-label="Preview uploaded attachment pasted-image-2026-07-08T06-17-13.png"'
    )
    // Uploads are gray file pills without the legacy leading @ prefix.
    expect(html).toContain('bg-bg-200')
    expect(html).not.toContain('@pasted-image-2026-07-08T06-17-13.png')
  })

  it('renders user message parts as styled skill and artifact pills', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'Run /forecast on @clinical trial03.pdf',
            parts: [
              { type: 'text', text: 'Run ' },
              { type: 'skill', id: 'skill-forecast', name: 'forecast' },
              { type: 'text', text: ' on ' },
              {
                type: 'artifact',
                id: 'artifact-1',
                name: 'clinical trial03.pdf',
                path: '/p/clinical trial03.pdf',
                source: 'artifact'
              }
            ]
          })
        ]
      })
    )

    // Skill pill is blue; artifact pill is green; labels keep their / and @ markers.
    expect(html).toContain('text-skill-chip-foreground')
    expect(html).toContain('/forecast')
    expect(html).toContain('bg-mention-chip')
    expect(html).toContain('text-mention-chip-foreground')
    expect(html).toContain('@clinical trial03.pdf')
  })

  it('renders plain content for user messages without structured parts', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1', content: 'Just plain text' })]
      })
    )

    expect(html).toContain('Just plain text')
    expect(html).not.toContain('text-mention-chip-foreground')
  })

  it('renders uploads as gray pills labeled by filename', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [
          createMessage({
            id: 'prompt-1',
            content: 'Look at this',
            uploads: [
              createUpload({
                id: 'upload-1',
                name: 'report.pdf',
                originalName: 'report.pdf',
                mimeType: 'application/pdf',
                path: '/p/report.pdf'
              })
            ]
          })
        ]
      })
    )

    expect(html).toContain('bg-bg-200')
    expect(html).toContain('report.pdf')
    expect(html).not.toContain('@report.pdf')
    expect(html).toContain('aria-label="Preview uploaded attachment report.pdf"')
  })

  it('renders search activities as compact chips with details collapsed by default', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            providerToolName: 'WebSearch',
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: JSON.stringify({
                    query: 'top news July 6 2026',
                    results: [
                      {
                        title: 'Result 1',
                        url: 'https://example.com/result-1'
                      },
                      {
                        title: 'Result 2',
                        url: 'https://example.com/result-2'
                      }
                    ]
                  })
                }
              }
            ]
          }),
          createActivity({
            id: 'tool-search-2',
            title: '"top headlines July 6 2026 breaking news"',
            providerToolName: 'WebSearch',
            sortIndex: 3,
            createdAt: 1710000000002,
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: JSON.stringify({
                    query: 'top headlines July 6 2026 breaking news',
                    results: [
                      {
                        title: 'Breaking news result',
                        url: 'https://example.com/breaking-news'
                      }
                    ]
                  })
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('data-testid="tool-group"')
    expect(html).toContain('data-testid="tool-group-header"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Ran 2 searches')
    expect(html).toContain('2 steps')
    expect(html.match(/data-testid="tool-chip"/g)).toHaveLength(2)
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(html).toContain('Web Search')
    expect(html).toContain('top news July 6 2026')
    expect(html).toContain('top headlines July 6 2026 breaking news')
    expect(html).toContain('2 results')
    expect(html).toContain('aria-controls="tool-details-tool-search-1"')
    expect(html).not.toContain('id="tool-details-tool-search-1"')
    expect(html).not.toContain('query')
    expect(html).not.toContain('Result 1')
    expect(html).not.toContain('href="https://example.com/result-1"')
    expect(html).not.toContain('https://example.com/result-1')
    expect(html).not.toContain('Result 2')
    expect(html).not.toContain('https://example.com/result-2')
    expect(html).not.toContain('Breaking news result')
    expect(html).not.toContain('https://example.com/breaking-news')
  })

  it('keeps Claude web search payload links collapsed by default', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            title: '"Typhoon Bavi landfall time forecast 2026"',
            providerToolName: 'WebSearch',
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: [
                    'Web search results for query: "Typhoon Bavi landfall time forecast 2026"',
                    '',
                    'Links: [{"title":"Live typhoon updates","url":"https://typhoon.slt.zj.gov.cn/"},{"title":"Typhoon No. 9 “Bavi” likely to make landfall in East China!","url":"https://finance.sina.com.cn/wm/2026-07-05/doc-inifuper9136723.shtml"}]',
                    '',
                    'Based on the search results, here is the latest on the predicted landfall time of Typhoon "Bavi".'
                  ].join('\n')
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a search')
    expect(html).toContain('1 step')
    expect(html).toContain('2 results')
    expect(html).toContain('Typhoon Bavi landfall time forecast 2026')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Live typhoon updates')
    expect(html).not.toContain('href="https://typhoon.slt.zj.gov.cn/"')
    expect(html).not.toContain('Typhoon No. 9 “Bavi” likely to make landfall in East China!')
    expect(html).not.toContain(
      'href="https://finance.sina.com.cn/wm/2026-07-05/doc-inifuper9136723.shtml"'
    )
  })

  it('infers ToolSearch activity groups from runtime titles when tool kind is missing', async () => {
    const html = await renderScroller(
      createSession({
        status: 'running',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-search-1',
            title: '"latest typhoon updates July 2026"',
            status: 'in_progress',
            toolKind: undefined,
            sortIndex: 3,
            createdAt: 1710000000002
          }),
          createActivity({
            id: 'tool-search-2',
            title: '"typhoon 2026 national weather bureau latest forecast"',
            status: 'in_progress',
            toolKind: undefined,
            sortIndex: 4,
            createdAt: 1710000000003
          })
        ]
      })
    )

    expect(html).toContain('Ran 2 searches')
    expect(html).toContain('2 steps')
    expect(html).not.toContain('Used tool: ToolSearch')
    expect(html).toContain('Web Search')
    expect(html).toContain('latest typhoon updates July 2026')
    expect(html).toContain('typhoon 2026 national weather bureau latest forecast')
    expect(html).not.toContain('&quot;latest typhoon updates July 2026&quot;')
    expect(html).not.toContain('&quot;typhoon 2026 national weather bureau latest forecast&quot;')
    expect(html).not.toContain('Using tool: &quot;latest typhoon updates July 2026&quot;')
    expect(html).not.toContain(
      'Using tool: &quot;typhoon 2026 national weather bureau latest forecast&quot;'
    )
  })

  it('renders ACP WebSearch fetch activities as web search entries after tool selection', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-web-search',
            title: '"India high temperature latest news"',
            toolKind: 'fetch',
            sortIndex: 3,
            createdAt: 1710000000002,
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: [
                    'Web search results for query: "India high temperature latest news"',
                    '',
                    'Links: [{"title":"India heatwave latest","url":"https://example.com/india-heatwave"}]'
                  ].join('\n')
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a search')
    expect(html).toContain('1 step')
    expect(html).not.toContain('Used tool: ToolSearch')
    expect(html).toContain('Web Search')
    expect(html).toContain('India high temperature latest news')
    expect(html).toContain('1 result')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('India heatwave latest')
    expect(html).not.toContain('href="https://example.com/india-heatwave"')
  })

  it('does not infer quoted non-search activities from earlier explicit search activities', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-search-1',
            title: '"weather forecast"',
            providerToolName: 'WebSearch',
            toolKind: 'fetch',
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-read-1',
            title: '"README.md"',
            toolKind: 'read',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran a search')
    expect(html).toContain('2 steps')
    expect(html.match(/Web Search/g)).toHaveLength(1)
    expect(html).toContain('Used tool: ToolRead')
  })

  it('renders Claude Grep search-kind activities as ordinary tools without leaking title details', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-grep-1',
            title: 'grep "secret pattern" /workspace/private',
            providerToolName: 'Grep',
            toolKind: 'search',
            sortIndex: 2,
            createdAt: 1710000000001
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool')
    expect(html).toContain('Used tool: Grep')
    expect(html).not.toContain('Web Search')
    expect(html).not.toContain('secret pattern')
    expect(html).not.toContain('/workspace/private')
  })

  it('does not infer quoted non-search activities from an earlier ToolSearch wrapper', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-read-1',
            title: '"README.md"',
            toolKind: 'read',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool search, read a file')
    expect(html).toContain('2 steps')
    expect(html).toContain('Used tool: ToolSearch')
    expect(html).toContain('Used tool: ToolRead')
    expect(html).not.toContain('Used tool: &quot;README.md&quot;')
    expect(html).not.toContain('Ran 1 search')
    expect(html).not.toContain('Web Search')
  })

  it('does not infer completed quoted fetch activities without search payload evidence', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-fetch-1',
            title: '"https://example.com/resource"',
            toolKind: 'fetch',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool search, fetched a page')
    expect(html).toContain('2 steps')
    expect(html).toContain('Used tool: ToolSearch')
    expect(html).toContain('Used tool: ToolFetch')
    expect(html).not.toContain('https://example.com/resource')
    expect(html).not.toContain('Ran 1 search')
    expect(html).not.toContain('Web Search')
  })

  it('does not infer completed quoted fetch activities from ordinary link content', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-fetch-1',
            title: '"https://example.com/resource"',
            providerToolName: 'WebFetch',
            toolKind: 'fetch',
            sortIndex: 3,
            createdAt: 1710000000002,
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: '[Plain link](https://example.com/plain)'
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool search, fetched a page')
    expect(html).toContain('Used tool: ToolSearch')
    expect(html).toContain('Used tool: WebFetch')
    expect(html).not.toContain('https://example.com/resource')
    expect(html).not.toContain('Plain link')
    expect(html).not.toContain('https://example.com/plain')
    expect(html).not.toContain('Ran 1 search')
    expect(html).not.toContain('Web Search')
  })

  it('does not infer active quoted WebFetch activities from an earlier ToolSearch wrapper', async () => {
    const html = await renderScroller(
      createSession({
        status: 'running',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-wrapper',
            title: 'ToolSearch',
            toolKind: undefined,
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'tool-fetch-1',
            title: '"https://example.com/resource"',
            status: 'in_progress',
            providerToolName: 'WebFetch',
            toolKind: 'fetch',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran a tool search, fetched a page')
    expect(html).toContain('Using tool: WebFetch')
    expect(html).not.toContain('https://example.com/resource')
    expect(html).not.toContain('Ran 1 search')
    expect(html).not.toContain('Web Search')
  })
})

describe('WorkspaceMessageScroller tool detail rows', () => {
  it('renders execute tool activities collapsed by default', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'tool-bash-1',
            providerToolName: 'Bash',
            toolKind: 'execute',
            title: 'ls -la',
            terminalExitCode: 0,
            sortIndex: 2,
            toolContent: [
              { type: 'content', content: { type: 'text', text: '```console\ntotal 8\n```' } }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a command')
    expect(html).toContain('Bash')
    expect(html).toContain('ls -la')
    expect(html).toContain('exit 0')
    // Detail rows below the group stay collapsed until the user expands them.
    expect(html).not.toContain('data-testid="tool-details"')
    expect(html).not.toContain('total 8')
  })
})

describe('WorkspaceActivityGroup header summaries', () => {
  it('summarizes a mixed group by tool category', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'cmd-1',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'load data',
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'cmd-2',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'plot data',
            sortIndex: 3,
            createdAt: 1710000000002
          }),
          createActivity({
            id: 'skill-1',
            providerToolName: 'Skill',
            toolKind: 'other',
            title: 'figure-style',
            sortIndex: 4,
            createdAt: 1710000000003
          }),
          createActivity({
            id: 'call-1',
            providerToolName: 'request_network_access',
            toolKind: 'other',
            title: 'request access',
            sortIndex: 5,
            createdAt: 1710000000004
          })
        ]
      })
    )

    expect(html).toContain('Ran 2 commands, loaded a skill, made a call')
    expect(html).toContain('4 steps')
  })

  it('appends a failed-step count to the group step summary', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'cmd-ok',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'setup',
            status: 'completed',
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'cmd-fail',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'run',
            status: 'failed',
            sortIndex: 3,
            createdAt: 1710000000002
          })
        ]
      })
    )

    expect(html).toContain('Ran 2 commands')
    expect(html).toContain('2 steps · 1 failed')
  })

  it('summarizes an artifact-writing group as saving a file', async () => {
    const html = await renderScroller(
      createSession({
        status: 'idle',
        messages: [createMessage({ id: 'prompt-1' })],
        activities: [
          createActivity({
            id: 'cmd-1',
            providerToolName: 'python',
            toolKind: 'execute',
            title: 'render figure',
            sortIndex: 2,
            createdAt: 1710000000001
          }),
          createActivity({
            id: 'artifact-1',
            providerToolName: 'write_artifact_file',
            toolKind: 'other',
            title: 'Write artifact file',
            sortIndex: 3,
            createdAt: 1710000000002,
            rawInput: {
              filename: 'figure.png',
              mimeType: 'image/png',
              content: 'x',
              encoding: 'base64'
            },
            toolContent: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: JSON.stringify({
                    artifact: {
                      name: 'figure.png',
                      path: '/f/figure.png',
                      mimeType: 'image/png',
                      size: 4096
                    }
                  })
                }
              }
            ]
          })
        ]
      })
    )

    expect(html).toContain('Ran a command, saved a file')
    expect(html).toContain('2 steps')
  })
})

describe('WorkspaceToolDetailsRow expanded rendering', () => {
  it('renders command and output code blocks when expanded', async () => {
    const { WorkspaceToolDetailsRow } = await import('./WorkspaceToolDetailsRow')
    const details: ToolActivityDetails = {
      displayName: 'Bash',
      subtitle: 'ls -la',
      metaLabel: 'exit 0',
      sections: [
        { kind: 'code', label: 'Command', language: 'bash', text: 'ls -la' },
        { kind: 'code', label: 'Output', text: 'total 8' }
      ]
    }
    const html = renderToStaticMarkup(
      <WorkspaceToolDetailsRow
        activity={createActivity({ id: 'tool-bash-1', toolKind: 'execute' })}
        details={details}
        isExpanded
        onToggle={() => {}}
      />
    )

    expect(html).toContain('data-testid="tool-details"')
    expect(html).toContain('data-testid="tool-code-block"')
    expect(html).toContain('Command')
    expect(html).toContain('Output')
    expect(html).toContain('ls -la')
    expect(html).toContain('total 8')
  })

  it('renders diff blocks for edit tools when expanded', async () => {
    const { WorkspaceToolDetailsRow } = await import('./WorkspaceToolDetailsRow')
    const details: ToolActivityDetails = {
      displayName: 'Edit',
      subtitle: 'a.ts',
      metaLabel: '+1 −1',
      sections: [
        {
          kind: 'diff',
          label: 'a.ts',
          path: 'a.ts',
          oldText: 'const a = 1',
          newText: 'const a = 2',
          addedLines: 1,
          removedLines: 1
        }
      ]
    }
    const html = renderToStaticMarkup(
      <WorkspaceToolDetailsRow
        activity={createActivity({ id: 'tool-edit-1', toolKind: 'edit' })}
        details={details}
        isExpanded
        onToggle={() => {}}
      />
    )

    expect(html).toContain('data-testid="tool-diff-block"')
    expect(html).toContain('const a = 1')
    expect(html).toContain('const a = 2')
  })
})

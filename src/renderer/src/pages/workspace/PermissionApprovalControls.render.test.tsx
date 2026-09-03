// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { SkillView } from '../../../../shared/settings'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { PermissionApprovalControls } from './PermissionApprovalControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const longRequestTitle =
  'Bash pwd echo whoami echo list home directory with enough extra words to clip'
const longAlwaysOptionName =
  'Always Allow Bash permission that keeps going across the composer and should be hidden'
const allowOnceOptionNameWithAlways = 'Always in this label should not become always action'
const unknownKindOptionNameWithAlways = 'Always in this unknown kind should stay literal'

const permissionRequest: AcpPermissionRequest = {
  requestId: 'permission-1',
  sessionId: 'session-1',
  toolCallId: 'tool-1',
  title: longRequestTitle,
  options: [
    {
      optionId: 'reject-once',
      name: 'Reject once',
      kind: 'reject_once'
    },
    {
      optionId: 'allow-always',
      name: longAlwaysOptionName,
      kind: 'allow_always'
    },
    {
      optionId: 'allow-once',
      name: allowOnceOptionNameWithAlways,
      kind: 'allow_once'
    },
    {
      optionId: 'unknown-kind',
      name: unknownKindOptionNameWithAlways,
      kind: 'custom_permission'
    }
  ]
}

const bashPermissionRequest: AcpPermissionRequest = {
  requestId: 'bash-1',
  sessionId: 'session-1',
  toolCallId: 'tool-bash',
  title: 'ls -la /tmp',
  providerToolName: 'Bash',
  toolKind: 'execute',
  rawInput: { command: 'ls -la /tmp' },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
}

// The broker resolves provider-specific MCP names to this stable identity before the dialog sees it.
const notebookPermissionRequest: AcpPermissionRequest = {
  requestId: 'nb-1',
  sessionId: 'session-1',
  toolCallId: 'tool-nb',
  title: 'mcp__open-science-notebook__notebook_execute',
  providerToolName: 'mcp__open-science-notebook__notebook_execute',
  isMcp: true,
  mcpIdentity: 'open-science-notebook/notebook_execute',
  rawInput: { kernelKind: 'python', code: 'import numpy as np\nx = np.linspace(0, 1)' },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always', kind: 'allow_always' }
  ]
}

// R kernel run whose rawInput carries no explicit kernel field; language must be inferred from code.
const rNotebookRequest: AcpPermissionRequest = {
  requestId: 'nb-r-1',
  sessionId: 'session-1',
  toolCallId: 'tool-nb-r',
  title: 'mcp__open-science-notebook__notebook_execute',
  providerToolName: 'mcp__open-science-notebook__notebook_execute',
  isMcp: true,
  mcpIdentity: 'open-science-notebook/notebook_execute',
  rawInput: { code: 'df <- read.csv("x.csv")\nlibrary(ggplot2)' },
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
}

// repl_execute pins JavaScript regardless of code content.
const replRequest: AcpPermissionRequest = {
  requestId: 'nb-repl',
  sessionId: 'session-1',
  toolCallId: 'tool-repl',
  title: 'mcp__open-science-notebook__repl_execute',
  providerToolName: 'mcp__open-science-notebook__repl_execute',
  isMcp: true,
  mcpIdentity: 'open-science-notebook/repl_execute',
  rawInput: { code: 'const x = 1' },
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
}

// bash_execute pins bash regardless of code content.
const bashExecuteRequest: AcpPermissionRequest = {
  requestId: 'nb-bash',
  sessionId: 'session-1',
  toolCallId: 'tool-bashx',
  title: 'mcp__open-science-notebook__bash_execute',
  providerToolName: 'mcp__open-science-notebook__bash_execute',
  isMcp: true,
  mcpIdentity: 'open-science-notebook/bash_execute',
  rawInput: { command: 'ls' },
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
}

const noInputRequest: AcpPermissionRequest = {
  requestId: 'no-input-1',
  sessionId: 'session-1',
  toolCallId: 'tool-no-input',
  title: 'some tool',
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
}

const literaturePermissionRequest: AcpPermissionRequest = {
  requestId: 'literature-1',
  sessionId: 'session-1',
  toolCallId: 'tool-literature',
  title: 'mcp__open-science-literature__read_document',
  providerToolName: 'mcp__open-science-literature__read_document',
  isMcp: true,
  mcpIdentity: 'open-science-literature/read_document',
  rawInput: {
    documentId: '336232f9-9914-4ef9-8590-b726a85253bd',
    query: 'main contributions method architecture evaluation results'
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
}

const networkApprovalRequest: AcpPermissionRequest = {
  requestId: 'network-1',
  sessionId: 'session-1',
  toolCallId: 'app-approval:network-1',
  title: 'Connect to data.example.org?',
  appOwned: true,
  providerToolName: 'Open Science',
  rawInput: {
    notebookNetworkApproval: {
      hostname: 'data.example.org',
      port: 443,
      reason: 'Download the dataset requested in this conversation.'
    }
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
    {
      optionId: 'always-allow',
      name: 'Global',
      kind: 'allow_always',
      scope: 'global'
    },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
}

// A skills/load_skill approval: the broker pins the stable skills/load_skill identity and the
// raw input names the skill being loaded; the SKILL.md body is resolved from the skills catalog.
const skillLoadPermissionRequest: AcpPermissionRequest = {
  requestId: 'skill-1',
  sessionId: 'session-1',
  toolCallId: 'tool-skill',
  title: 'mcp__skills__load_skill',
  providerToolName: 'mcp__skills__load_skill',
  isMcp: true,
  mcpIdentity: 'skills/load_skill',
  rawInput: { skill: 'mcp-pubmed' },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
}

const catalogSkill: SkillView = {
  id: 'imported-mcp-pubmed',
  name: 'mcp-pubmed',
  displayName: 'PubMed Search',
  description: 'Search PubMed',
  source: 'imported',
  updatedAt: '2026-08-27T00:00:00Z',
  enabled: true
}

const installSkillDetail = (body: string): ReturnType<typeof vi.fn> => {
  const getSkillDetail = vi
    .fn()
    .mockResolvedValue({ ...catalogSkill, body, references: [], packageFiles: [] })
  window.api = { settings: { getSkillDetail } } as unknown as Window['api']
  return getSkillDetail
}

const installSkillDocumentResolver = (
  resolveSkillDocument: ReturnType<typeof vi.fn>
): ReturnType<typeof vi.fn> => {
  window.api = { settings: { resolveSkillDocument } } as unknown as Window['api']
  return resolveSkillDocument
}

const renderControls = (): string =>
  renderToStaticMarkup(
    <PermissionApprovalControls requests={[permissionRequest]} onRespond={() => undefined} />
  )

// A second queued request whose command/controls must stay hidden while the first is answered.
const secondRequestTitle = 'Second queued command that must not render yet'
const secondPermissionRequest: AcpPermissionRequest = {
  requestId: 'permission-2',
  sessionId: 'session-1',
  toolCallId: 'tool-2',
  title: secondRequestTitle,
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
}

describe('PermissionApprovalControls', () => {
  // jsdom-mounted cards to unmount after each test (static-markup tests mount nothing).
  const mounted: Array<{ root: Root; host: HTMLDivElement }> = []

  afterEach(async () => {
    for (const { root, host } of mounted.splice(0)) {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
    useSettingsStore.setState({ skills: [], skillsLoaded: false })
    window.api = undefined as unknown as Window['api']
    vi.restoreAllMocks()
  })

  const mountControls = async (request: AcpPermissionRequest): Promise<HTMLDivElement> => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<PermissionApprovalControls requests={[request]} onRespond={() => undefined} />)
    })
    mounted.push({ root, host })
    return host
  }

  it('renders Notebook domain requests as a conversation approval without exposing raw payload JSON', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[networkApprovalRequest]} onRespond={() => undefined} />
    )

    expect(html).toContain('Connect to data.example.org?')
    expect(html).toContain('Network access')
    expect(html).toContain('Notebook code requested access to data.example.org:443.')
    expect(html).toContain('Reason: Download the dataset requested in this conversation.')
    expect(html).toContain('Details')
    expect(html).toContain('Allow once')
    expect(html).toContain('Deny')
    expect(html).toContain('data-testid="scope-chevron"')
    expect(html).not.toContain('data-testid="extra-option"')
    expect(html).not.toContain('notebookNetworkApproval')
  })

  it('renders the Allow button with the conversation copy for the session scope by default', () => {
    const html = renderControls()
    expect(html).toContain('for this conversation')
    expect(html).not.toContain('for this call only')
    expect(html).toContain('data-testid="allow-primary"')
    expect(html).toContain('data-testid="deny-button"')
    expect(html).toContain('data-testid="scope-chevron"')
  })

  it('drops standalone card chrome when embedded in the composer interaction lane', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[permissionRequest]}
        onRespond={() => undefined}
        embedded
      />
    )

    expect(html).toContain('data-testid="permission-approval-controls"')
    expect(html).not.toContain('shadow-dialog')
    expect(html).not.toContain('motion-safe:slide-in-from-bottom-1')
  })

  it('renders the scope menu outside the embedded scroll surface and restores trigger focus', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)

    act(() => {
      root.render(
        <div data-testid="permission-composer-scroll">
          <PermissionApprovalControls
            requests={[permissionRequest]}
            onRespond={() => undefined}
            embedded
          />
        </div>
      )
    })
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="scope-chevron"]')
    act(() => trigger?.click())

    const menu = document.body.querySelector('[role="menu"][aria-label="Authorization scope"]')
    expect(menu).not.toBeNull()
    expect(host.contains(menu)).toBe(false)

    const once = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []
    ).find((item) => item.textContent?.includes('Once'))
    await act(async () => {
      once?.click()
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(trigger)

    act(() => root.unmount())
    host.remove()
  })

  it('pins the approval actions to the bottom while request content scrolls', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[permissionRequest]}
        onRespond={() => undefined}
        embedded
      />
    )

    expect(html).toMatch(/data-testid="permission-actions" class="[^"]*sticky[^"]*bottom-0[^"]*"/)
  })

  it('pins the permission title banner to the top while request content scrolls', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[permissionRequest]}
        onRespond={() => undefined}
        embedded
      />
    )

    expect(html).toMatch(/data-testid="permission-header" class="[^"]*sticky[^"]*top-0[^"]*"/)
  })

  it('does not show the second queued request', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[permissionRequest, secondPermissionRequest]}
        onRespond={() => undefined}
      />
    )
    expect(html).not.toContain(secondRequestTitle)
  })

  it('labels the managed artifact writer as an artifact save instead of command execution', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            title: 'mcp.open-science-artifacts.write_artifact_file',
            providerToolName: 'write_artifact_file',
            isMcp: true,
            mcpIdentity: 'open-science-artifacts/write_artifact_file',
            toolKind: 'execute'
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('Artifact save</span>')
    expect(html).toContain('Save as artifact?')
    expect(html).not.toContain('Command execution</span>')
  })

  it('shows a semantic Literature approval card without raw tool commands or document ids', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[literaturePermissionRequest]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('Search linked PDFs?')
    expect(html).toContain('main contributions method architecture evaluation results')
    expect(html).toContain('data-testid="literature-tool-card"')
    expect(html).not.toContain('mcp__open-science-literature__read_document')
    expect(html).not.toContain('336232f9-9914-4ef9-8590-b726a85253bd')
    expect(html).not.toContain('permission-code-toggle')
  })

  it('keeps an otherwise-opaque MCP request distinguishable without its protocol identity', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            title: 'mcp.open-science-artifacts.write_artifact_file',
            providerToolName: 'write_artifact_file',
            isMcp: true,
            mcpIdentity: 'open-science-artifacts/write_artifact_file',
            toolKind: 'execute',
            rawInput: undefined
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('Save as artifact?')
    expect(html).toContain('Artifact save</span>')
    expect(html).not.toContain('Use external service?')
    expect(html).not.toContain('write_artifact_file')
    expect(html).not.toContain('mcp.open-science-artifacts')
  })

  it('does not treat an unclassified raw MCP title as an artifact save', () => {
    const rawTitle = 'mcp__open-science-artifacts__write_artifact_file'
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            title: rawTitle,
            providerToolName: rawTitle,
            isMcp: false,
            toolKind: 'execute'
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('Run command?')
    expect(html).toContain('Command execution</span>')
    expect(html).not.toContain('Artifact save</span>')
  })

  it('keeps every MCP execute argument in the external-service input preview', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            title: 'mcp__runner__execute',
            providerToolName: 'mcp__runner__execute',
            isMcp: true,
            mcpIdentity: 'runner/execute',
            toolKind: 'execute',
            rawInput: { command: 'export-report --publish', target: 'production' }
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('External service input')
    expect(html).not.toContain('Run command')
    expect(html).toContain('data-language="json"')
    expect(html).toContain('export-report --publish')
    expect(html).toContain('production')
  })

  it('keeps an MCP request external while showing its humanized action and paths', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            title: 'mcp__open-science-artifacts__write_artifact_file',
            isMcp: true,
            mcpIdentity: 'open-science-artifacts/write_artifact_file',
            toolKind: 'edit',
            toolLocations: [{ path: 'report.md' }],
            rawInput: { value: 'updated' }
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('Artifact save</span>')
    expect(html).not.toContain('Open Science Artifacts / Write Artifact File')
    expect(html).toContain('report.md')
  })

  it('keeps a title-only non-MCP execute target visible without inventing a command preview', () => {
    const executeTitleOnly: AcpPermissionRequest = {
      requestId: 'exec-title-1',
      sessionId: 'session-1',
      toolCallId: 'tool-exec-title',
      title: 'python scripts/run_pipeline.py --full',
      toolKind: 'execute',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[executeTitleOnly]} onRespond={() => undefined} />
    )
    expect(html).toContain('Run command?')
    expect(html).not.toContain('data-testid="tool-code-block"')
    expect(html).toContain('python scripts/run_pipeline.py --full')
  })

  it('serializes prompts by rendering only the first pending request', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[permissionRequest, secondPermissionRequest]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain(longRequestTitle)
    expect(html).not.toContain(secondRequestTitle)
  })

  it('renders a code block for a bash request', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[bashPermissionRequest]} onRespond={() => undefined} />
    )
    expect(html).toContain('data-testid="tool-code-block"')
    expect(html).toContain('ls -la /tmp')
  })

  it('renders a code block with kernel code for a notebook request', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[notebookPermissionRequest]}
        onRespond={() => undefined}
      />
    )
    expect(html).toContain('data-testid="tool-code-block"')
    expect(html).toContain('import numpy as np')
  })

  it('shows an activity-style card title for the code section', () => {
    const notebookHtml = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[notebookPermissionRequest]}
        onRespond={() => undefined}
      />
    )
    expect(notebookHtml).toContain('data-testid="permission-code-toggle"')
    expect(notebookHtml).toContain('Start Notebook run')

    const bashHtml = renderToStaticMarkup(
      <PermissionApprovalControls requests={[bashPermissionRequest]} onRespond={() => undefined} />
    )
    expect(bashHtml).toContain('Run command')
  })

  it('uses the explicit kernelKind field to set the language', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[notebookPermissionRequest]}
        onRespond={() => undefined}
      />
    )
    expect(html).toContain('data-language="python"')
  })

  it('infers R language from code when no explicit kernel field is present', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[rNotebookRequest]} onRespond={() => undefined} />
    )
    expect(html).toContain('data-language="r"')
    expect(html).not.toContain('data-language="python"')
  })

  it('pins repl_execute to JavaScript and bash_execute to bash by tool name', () => {
    const replHtml = renderToStaticMarkup(
      <PermissionApprovalControls requests={[replRequest]} onRespond={() => undefined} />
    )
    expect(replHtml).toContain('data-language="javascript"')

    const bashHtml = renderToStaticMarkup(
      <PermissionApprovalControls requests={[bashExecuteRequest]} onRespond={() => undefined} />
    )
    expect(bashHtml).toContain('data-language="bash"')
  })

  it('recognizes the broker shape: namespaced title + bare leaf providerToolName', () => {
    // Real broker output (see runtime.test.ts): the server segment lives only in the namespaced
    // title, while providerToolName is the bare leaf. The dialog must still show the notebook code
    // and label, not fall through to Bash and display the namespaced title as a command.
    const brokerShape: AcpPermissionRequest = {
      requestId: 'nb-broker',
      sessionId: 'session-1',
      toolCallId: 'tool-nbb',
      title: 'mcp.open-science-notebook.notebook_execute',
      providerToolName: 'notebook_execute',
      toolKind: 'execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      rawInput: { kernelKind: 'python', code: 'print("hi")' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[brokerShape]} onRespond={() => undefined} />
    )
    expect(html).toContain('Start Notebook run')
    expect(html).toContain('data-testid="permission-impact-info"')
    expect(html).toContain('data-testid="permission-tool-info"')
    expect(html).toContain('data-language="python"')
    expect(html).toContain('print(&quot;hi&quot;)')
    // Must not misclassify as a shell command showing the namespaced title.
    expect(html).not.toContain('data-language="bash"')
  })

  it('recognizes the opencode single-underscore notebook tool name', () => {
    const opencodeShape: AcpPermissionRequest = {
      requestId: 'nb-oc',
      sessionId: 'session-1',
      toolCallId: 'tool-oc',
      title: 'open-science-notebook_notebook_execute',
      providerToolName: 'open-science-notebook_notebook_execute',
      toolKind: 'execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      rawInput: { kernelKind: 'python', code: 'print("oc")' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[opencodeShape]} onRespond={() => undefined} />
    )
    expect(html).toContain('Start Notebook run')
    expect(html).toContain('data-testid="permission-tool-info"')
    expect(html).toContain('data-language="python"')
    expect(html).not.toContain('data-language="bash"')
  })

  it('labels a fully-namespaced notebook request with the notebook badge cluster, not MCP', () => {
    // The header cluster must agree with the code-card header for real
    // mcp__<server>__notebook_execute names, not fall through to the generic MCP label.
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[{ ...notebookPermissionRequest, isMcp: true }]}
        onRespond={() => undefined}
      />
    )
    expect(html).toContain('data-testid="permission-category-badge"')
    expect(html).toContain('data-testid="permission-tool-info"')
    expect(html).toContain('Python execution</span>')
    expect(html).not.toContain('External service</span>')
  })

  it('shows a distinct execution category for each notebook runtime', () => {
    const pythonHtml = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[notebookPermissionRequest]}
        onRespond={() => undefined}
      />
    )
    expect(pythonHtml).toContain('>Python execution</span>')

    // The badge follows the inferred code language even without an explicit kernel field.
    const rHtml = renderToStaticMarkup(
      <PermissionApprovalControls requests={[rNotebookRequest]} onRespond={() => undefined} />
    )
    expect(rHtml).toContain('>R execution</span>')

    // repl_execute pins JavaScript even though its code looks generic.
    const replHtml = renderToStaticMarkup(
      <PermissionApprovalControls requests={[replRequest]} onRespond={() => undefined} />
    )
    expect(replHtml).toContain('>JS REPL</span>')
  })

  it('translates permission presentation copy while preserving dynamic service names', async () => {
    await i18next.changeLanguage('zh-Hans')
    try {
      const notebookHtml = renderToStaticMarkup(
        <PermissionApprovalControls requests={[rNotebookRequest]} onRespond={() => undefined} />
      )
      expect(notebookHtml).toContain('运行 R 代码？')
      expect(notebookHtml).toContain('>R 执行</span>')

      const serviceHtml = renderToStaticMarkup(
        <PermissionApprovalControls
          requests={[
            {
              ...permissionRequest,
              isMcp: true,
              mcpIdentity: 'custom-service/run_report',
              providerToolName: 'custom-service/run_report'
            }
          ]}
          onRespond={() => undefined}
        />
      )
      expect(serviceHtml).toContain('使用 Custom Service / Run Report？')
    } finally {
      await i18next.changeLanguage('en')
    }
  })

  it('renders complete permission actions in natural Japanese word order', async () => {
    await i18next.changeLanguage('ja')
    try {
      const onceHtml = renderToStaticMarkup(
        <PermissionApprovalControls requests={[noInputRequest]} onRespond={() => undefined} />
      )
      expect(onceHtml).toContain('>今回のみ許可</span>')

      const sessionHtml = renderToStaticMarkup(
        <PermissionApprovalControls requests={[permissionRequest]} onRespond={() => undefined} />
      )
      expect(sessionHtml).toContain('>この会話で許可</span>')
      expect(sessionHtml).not.toContain('許可する この会話のために')
    } finally {
      await i18next.changeLanguage('en')
    }
  })

  it('renders no code block when rawInput is absent', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[noInputRequest]} onRespond={() => undefined} />
    )
    expect(html).not.toContain('data-testid="tool-code-block"')
  })

  it('shows JSON args for an execute-suffixed tool that is not a notebook', () => {
    // A database executor ends in _execute but is not a notebook: its arguments must be shown
    // as JSON, not hidden by the notebook path (which returns nothing without a code field).
    const dbExecute: AcpPermissionRequest = {
      requestId: 'db-1',
      sessionId: 'session-1',
      toolCallId: 'tool-db',
      title: 'database_execute',
      providerToolName: 'database_execute',
      isMcp: true,
      mcpIdentity: 'database/execute',
      rawInput: { sql: 'DROP TABLE users' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[dbExecute]} onRespond={() => undefined} />
    )
    expect(html).toContain('data-testid="tool-code-block"')
    expect(html).toContain('DROP TABLE users')
    expect(html).not.toContain('Start Notebook run')
  })

  it('treats a notebook_execute from another MCP server as generic JSON, not a notebook', () => {
    // Same tool suffix but a different server: all arguments must stay reviewable as JSON, and it
    // must not be labeled a notebook cell.
    const lookalike: AcpPermissionRequest = {
      requestId: 'la-1',
      sessionId: 'session-1',
      toolCallId: 'tool-la',
      title: 'mcp__acme-db__notebook_execute',
      providerToolName: 'mcp__acme-db__notebook_execute',
      isMcp: true,
      mcpIdentity: 'acme-db/notebook_execute',
      rawInput: { target: 'prod', code: 'SELECT 1' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[lookalike]} onRespond={() => undefined} />
    )
    // JSON path shows every argument, including the production target the notebook path would hide.
    expect(html).toContain('data-language="json"')
    expect(html).toContain('prod')
    expect(html).not.toContain('Start Notebook run')
    expect(html).toContain('External service</span>')
  })

  it('keeps the request title visible when it is the only file target', () => {
    const write: AcpPermissionRequest = {
      requestId: 'wr-1',
      sessionId: 'session-1',
      toolCallId: 'tool-wr',
      title: 'Write report.md',
      providerToolName: 'Write',
      toolKind: 'edit',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[write]} onRespond={() => undefined} />
    )
    expect(html).toContain('data-testid="permission-impact-info"')
    expect(html).toContain('Write report.md')
  })

  it('keeps a stable built-in provider name visible when the title is generic', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            title: 'WebFetch',
            providerToolName: 'WebFetch',
            toolKind: 'fetch'
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('Network access</span>')
    expect(html).toContain('data-testid="permission-impact-info"')
    expect(html).toContain('WebFetch')
  })

  it('does not classify an untrusted notebook-looking name as notebook control', () => {
    const identifier = 'open_science_notebook_notebook_restart'
    const restart: AcpPermissionRequest = {
      requestId: 'restart-1',
      sessionId: 'session-1',
      toolCallId: 'tool-restart',
      title: identifier,
      providerToolName: identifier,
      isMcp: false,
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }

    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[restart]} onRespond={() => undefined} />
    )

    expect(html).toContain('Allow tool access?')
    expect(html).toContain('Tool access</span>')
    expect(html).not.toContain('Restart notebook?')
    expect(html).toContain('data-testid="permission-impact-info"')
    expect(html).toContain('data-testid="permission-tool-info"')
    expect(html).not.toContain('Notebook control</span>')
  })

  it('keeps trusted notebook control details in an impact tooltip without exposing its identifier', () => {
    const identifier = 'mcp__open-science-notebook__notebook_restart'
    const restart: AcpPermissionRequest = {
      requestId: 'restart-1',
      sessionId: 'session-1',
      toolCallId: 'tool-restart',
      title: identifier,
      providerToolName: identifier,
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_restart',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
    }

    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[restart]} onRespond={() => undefined} />
    )

    expect(html).toContain('Restart notebook?')
    expect(html).toContain('Notebook control</span>')
    expect(html).not.toContain(identifier)
  })

  it('surfaces a non-canonical option kind as its own labeled button', () => {
    // An option kind outside allow_*/reject_* must stay selectable rather than disappearing.
    const withCustom: AcpPermissionRequest = {
      requestId: 'custom-1',
      sessionId: 'session-1',
      toolCallId: 'tool-custom',
      title: 'Edit',
      providerToolName: 'Edit',
      toolKind: 'edit',
      options: [
        { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
        { optionId: 'opt-sandbox', name: 'Run in sandbox', kind: 'allow_sandbox' }
      ]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[withCustom]} onRespond={() => undefined} />
    )
    expect(html).toContain('data-testid="extra-option"')
    expect(html).toContain('Run in sandbox')
  })

  it('routes explicit Project and Global choices through the scope picker, not extra actions', () => {
    const twoAlways: AcpPermissionRequest = {
      requestId: 'two-1',
      sessionId: 'session-1',
      toolCallId: 'tool-two',
      title: 'Edit',
      providerToolName: 'Edit',
      toolKind: 'edit',
      options: [
        { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
        {
          optionId: 'opt-always-session',
          name: 'This session',
          kind: 'allow_always',
          scope: 'session'
        },
        {
          optionId: 'opt-always-project',
          name: 'This project',
          kind: 'allow_always',
          scope: 'project'
        },
        {
          optionId: 'opt-always-global',
          name: 'Global',
          kind: 'allow_always',
          scope: 'global'
        }
      ]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[twoAlways]} onRespond={() => undefined} />
    )
    expect(html).not.toContain('data-testid="extra-option"')
    expect(html).toContain('data-testid="scope-chevron"')
  })

  it('discloses the command prefix covered by remembered scopes', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...bashPermissionRequest,
            commandPrefix: ['python', 'analyze.py'],
            rawInput: { command: 'python analyze.py --input data.csv' }
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('Remembered scopes apply to commands starting with:')
    expect(html).toContain('[&quot;python&quot;,&quot;analyze.py&quot;]')
    expect(html).toContain('python analyze.py --input data.csv')
  })

  it('keeps reject_always reachable with a canonical label when Deny sends reject_once', () => {
    // Deny sends reject_once; reject_always must stay selectable (not hidden), and its label must
    // disclose the persistent scope rather than a generic "Deny".
    const canonical: AcpPermissionRequest = {
      requestId: 'canon-1',
      sessionId: 'session-1',
      toolCallId: 'tool-canon',
      title: 'Edit',
      providerToolName: 'Edit',
      toolKind: 'edit',
      options: [
        { optionId: 'a-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'a-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'r-once', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'r-always', name: 'Reject always', kind: 'reject_always' }
      ]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[canonical]} onRespond={() => undefined} />
    )
    expect(html).toContain('data-testid="extra-option"')
    expect(html).toContain('Reject always')
  })

  it('derives the action label from kind so an adversarial provider name cannot mislead', () => {
    // An allow_always option maliciously named "Reject" must still read as an Allow action.
    const adversarial: AcpPermissionRequest = {
      requestId: 'adv-1',
      sessionId: 'session-1',
      toolCallId: 'tool-adv',
      title: 'Edit',
      providerToolName: 'Edit',
      toolKind: 'edit',
      options: [
        { optionId: 'a-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'a-always-1', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'a-always-evil', name: 'Reject', kind: 'allow_always' }
      ]
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[adversarial]} onRespond={() => undefined} />
    )
    // The second allow_always surfaces as an extra, labeled with the canonical Allow action word,
    // never as a standalone "Reject".
    expect(html).toContain('data-testid="extra-option"')
    expect(html).toContain('Allow always · Reject')
    expect(html).not.toContain('>Reject<')
  })

  it('renders tool locations so the affected path is always visible', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            toolKind: 'edit',
            toolLocations: [{ path: '/repo/config/prod.env' }]
          }
        ]}
        onRespond={() => undefined}
      />
    )
    expect(html).toContain('/repo/config/prod.env')
  })

  it('renders the SKILL.md document for a catalog skill load instead of the raw JSON input', async () => {
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    const getSkillDetail = installSkillDetail('# mcp-pubmed\n\nSearch **PubMed** articles.')

    const host = await mountControls(skillLoadPermissionRequest)

    expect(getSkillDetail).toHaveBeenCalledWith('imported-mcp-pubmed')

    const toggle = host.querySelector('[data-testid="permission-skill-toggle"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(toggle?.textContent).toContain('PubMed Search')
    expect(toggle?.textContent).toContain('Skill')
    expect(host.querySelector('[data-testid="permission-code-toggle"]')).toBeNull()
    expect(host.querySelector('.shadow-sheet')).not.toBeNull()
    expect(host.querySelector('h1')?.textContent).toBe('mcp-pubmed')
  })

  it('resolves the skill from the Codex arguments envelope and namespaced tool identity', async () => {
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    const getSkillDetail = installSkillDetail('# mcp-pubmed')

    const host = await mountControls({
      ...skillLoadPermissionRequest,
      title: 'mcp.skills.load_skill',
      providerToolName: 'mcp.skills.load_skill',
      mcpIdentity: undefined,
      rawInput: { arguments: { skill: 'mcp-pubmed', args: '--depth full' } }
    })

    expect(getSkillDetail).toHaveBeenCalledWith('imported-mcp-pubmed')
    expect(host.querySelector('[data-testid="permission-skill-toggle"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="permission-code-toggle"]')).toBeNull()
  })

  it('resolves the skill document through the main-process resolver on a catalog miss', async () => {
    useSettingsStore.setState({ skills: [], skillsLoaded: true })
    const resolveSkillDocument = installSkillDocumentResolver(
      vi.fn().mockResolvedValue({
        name: 'mcp-pubmed',
        displayName: 'PubMed Connector',
        body: '# mcp-pubmed\n\nConnector-provided document.'
      })
    )

    const host = await mountControls(skillLoadPermissionRequest)

    expect(resolveSkillDocument).toHaveBeenCalledWith({ name: 'mcp-pubmed' })

    const toggle = host.querySelector('[data-testid="permission-skill-toggle"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.textContent).toContain('PubMed Connector')
    expect(host.querySelector('h1')?.textContent).toBe('mcp-pubmed')
    expect(host.textContent).toContain('Connector-provided document.')
    // The resolved document replaces the raw JSON input.
    expect(host.querySelector('[data-testid="permission-code-toggle"]')).toBeNull()
    expect(host.querySelector('[data-testid="tool-code-block"]')).toBeNull()
  })

  it('keeps the raw JSON input inside the skill section when no source provides the skill', async () => {
    useSettingsStore.setState({ skills: [], skillsLoaded: true })
    const resolveSkillDocument = installSkillDocumentResolver(vi.fn().mockResolvedValue(null))

    const host = await mountControls(skillLoadPermissionRequest)

    expect(resolveSkillDocument).toHaveBeenCalledWith({ name: 'mcp-pubmed' })

    const toggle = host.querySelector('[data-testid="permission-skill-toggle"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.textContent).toContain('mcp-pubmed')
    // The unavailable document falls back to the reviewable raw input inside the same section.
    const codeBlock = host.querySelector('[data-testid="tool-code-block"]')
    expect(codeBlock).not.toBeNull()
    expect(codeBlock?.textContent).toContain('"skill"')
    expect(codeBlock?.textContent).toContain('mcp-pubmed')
  })

  it('offers a retry when the skill document fetch fails', async () => {
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    const getSkillDetail = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValue({ body: '# mcp-pubmed\n\nRecovered.' })
    window.api = { settings: { getSkillDetail } } as unknown as Window['api']

    const host = await mountControls(skillLoadPermissionRequest)

    const retry = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(getSkillDetail).toHaveBeenCalledTimes(2)
    expect(host.querySelector('h1')?.textContent).toBe('mcp-pubmed')
    expect(host.textContent).toContain('Recovered.')
  })

  it('collapses and re-expands the skill document via the toggle', async () => {
    useSettingsStore.setState({ skills: [catalogSkill], skillsLoaded: true })
    installSkillDetail('# mcp-pubmed')

    const host = await mountControls(skillLoadPermissionRequest)
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="permission-skill-toggle"]')
    expect(host.querySelector('.shadow-sheet')).not.toBeNull()

    await act(async () => toggle?.click())
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.shadow-sheet')).toBeNull()

    await act(async () => toggle?.click())
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.shadow-sheet')).not.toBeNull()
  })
})

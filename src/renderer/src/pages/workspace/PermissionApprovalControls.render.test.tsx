import { renderToStaticMarkup } from 'react-dom/server'
import type { AcpPermissionRequest } from '../../../../shared/acp'
import { describe, expect, it } from 'vitest'

import { PermissionApprovalControls } from './PermissionApprovalControls'

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
  ],
  raw: {}
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
  ],
  raw: {}
}

// Real Claude Code MCP naming: mcp__<server>__<tool>. The dialog must recognize this format.
const notebookPermissionRequest: AcpPermissionRequest = {
  requestId: 'nb-1',
  sessionId: 'session-1',
  toolCallId: 'tool-nb',
  title: 'mcp__open-science-notebook__notebook_execute',
  providerToolName: 'mcp__open-science-notebook__notebook_execute',
  rawInput: { kernelKind: 'python', code: 'import numpy as np\nx = np.linspace(0, 1)' },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always', kind: 'allow_always' }
  ],
  raw: {}
}

// R kernel run whose rawInput carries no explicit kernel field; language must be inferred from code.
const rNotebookRequest: AcpPermissionRequest = {
  requestId: 'nb-r-1',
  sessionId: 'session-1',
  toolCallId: 'tool-nb-r',
  title: 'mcp__open-science-notebook__notebook_execute',
  providerToolName: 'mcp__open-science-notebook__notebook_execute',
  rawInput: { code: 'df <- read.csv("x.csv")\nlibrary(ggplot2)' },
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
  raw: {}
}

// repl_execute pins JavaScript regardless of code content.
const replRequest: AcpPermissionRequest = {
  requestId: 'nb-repl',
  sessionId: 'session-1',
  toolCallId: 'tool-repl',
  title: 'mcp__open-science-notebook__repl_execute',
  providerToolName: 'mcp__open-science-notebook__repl_execute',
  rawInput: { code: 'const x = 1' },
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
  raw: {}
}

// bash_execute pins bash regardless of code content.
const bashExecuteRequest: AcpPermissionRequest = {
  requestId: 'nb-bash',
  sessionId: 'session-1',
  toolCallId: 'tool-bashx',
  title: 'mcp__open-science-notebook__bash_execute',
  providerToolName: 'mcp__open-science-notebook__bash_execute',
  rawInput: { command: 'ls' },
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
  raw: {}
}

const noInputRequest: AcpPermissionRequest = {
  requestId: 'no-input-1',
  sessionId: 'session-1',
  toolCallId: 'tool-no-input',
  title: 'some tool',
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
  raw: {}
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
  ],
  raw: {}
}

describe('PermissionApprovalControls', () => {
  it('renders the Allow button with the conversation scope by default', () => {
    const html = renderControls()
    expect(html).toContain('for this conversation')
    expect(html).not.toContain('for this call only')
    expect(html).toContain('data-testid="allow-primary"')
    expect(html).toContain('data-testid="deny-button"')
    expect(html).toContain('data-testid="scope-chevron"')
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

  it('labels non-notebook MCP approvals as MCP instead of command execution', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            title: 'mcp.open-science-artifacts.write_artifact_file',
            providerToolName: 'write_artifact_file',
            isMcp: true,
            toolKind: 'execute'
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('MCP tool access</span>')
    expect(html).not.toContain('Command execution</span>')
  })

  it('keeps the tool identity visible for execute-kind MCP requests', () => {
    // An MCP tool reporting kind:'execute' (write_artifact_file) must not collapse into the
    // generic "Run command?" shell wording — the provider name is the only identity left when
    // the request carries no previewable command payload.
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            title: 'mcp.open-science-artifacts.write_artifact_file',
            providerToolName: 'write_artifact_file',
            isMcp: true,
            toolKind: 'execute',
            rawInput: undefined
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('Run write_artifact_file?')
    expect(html).not.toContain('Run command?')
  })

  it('shows the title for a non-Bash execute request with no command preview', () => {
    // A non-Bash execute request whose command lives only in the title: extractPermissionCode
    // has no Bash fallback here, so the title is the only place the command can appear — the
    // generic "Run command?" header must not leave the prompt opaque.
    const executeTitleOnly: AcpPermissionRequest = {
      requestId: 'exec-title-1',
      sessionId: 'session-1',
      toolCallId: 'tool-exec-title',
      title: 'python scripts/run_pipeline.py --full',
      toolKind: 'execute',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      raw: {}
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[executeTitleOnly]} onRespond={() => undefined} />
    )
    expect(html).toContain('Run command?')
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
    expect(notebookHtml).toContain('Run notebook cell')

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
      rawInput: { kernelKind: 'python', code: 'print("hi")' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      raw: {}
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[brokerShape]} onRespond={() => undefined} />
    )
    expect(html).toContain('Run notebook cell')
    expect(html).toContain('Notebook execution</span>')
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
      rawInput: { kernelKind: 'python', code: 'print("oc")' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      raw: {}
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[opencodeShape]} onRespond={() => undefined} />
    )
    expect(html).toContain('Run notebook cell')
    expect(html).toContain('Notebook execution</span>')
    expect(html).toContain('data-language="python"')
    expect(html).not.toContain('data-language="bash"')
  })

  it('labels a fully-namespaced notebook request as Notebook execution', () => {
    // The risk badge must agree with the code-card header for real mcp__<server>__notebook_execute
    // names, not fall through to the generic MCP label.
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[{ ...notebookPermissionRequest, isMcp: true }]}
        onRespond={() => undefined}
      />
    )
    expect(html).toContain('Notebook execution</span>')
    expect(html).not.toContain('MCP tool access</span>')
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
      rawInput: { sql: 'DROP TABLE users' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      raw: {}
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[dbExecute]} onRespond={() => undefined} />
    )
    expect(html).toContain('data-testid="tool-code-block"')
    expect(html).toContain('DROP TABLE users')
    expect(html).not.toContain('Run notebook cell')
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
      rawInput: { target: 'prod', code: 'SELECT 1' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      raw: {}
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[lookalike]} onRespond={() => undefined} />
    )
    // JSON path shows every argument, including the production target the notebook path would hide.
    expect(html).toContain('data-language="json"')
    expect(html).toContain('prod')
    expect(html).not.toContain('Run notebook cell')
    expect(html).not.toContain('Notebook execution</span>')
  })

  it('shows the request title as a detail line when the header hides the target', () => {
    // Provider "Write" with a target-bearing title and no rawInput: title must remain visible.
    const write: AcpPermissionRequest = {
      requestId: 'wr-1',
      sessionId: 'session-1',
      toolCallId: 'tool-wr',
      title: 'Write report.md',
      providerToolName: 'Write',
      toolKind: 'edit',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      raw: {}
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[write]} onRespond={() => undefined} />
    )
    expect(html).toContain('Write report.md')
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
      ],
      raw: {}
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[withCustom]} onRespond={() => undefined} />
    )
    expect(html).toContain('data-testid="extra-option"')
    expect(html).toContain('Run in sandbox')
  })

  it('keeps a second allow_always option selectable via a labeled button', () => {
    // Two distinct allow_always: the Allow control surfaces the first; the second must not vanish.
    const twoAlways: AcpPermissionRequest = {
      requestId: 'two-1',
      sessionId: 'session-1',
      toolCallId: 'tool-two',
      title: 'Edit',
      providerToolName: 'Edit',
      toolKind: 'edit',
      options: [
        { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'opt-always-session', name: 'Allow this session', kind: 'allow_always' },
        { optionId: 'opt-always-project', name: 'Allow this project', kind: 'allow_always' }
      ],
      raw: {}
    }
    const html = renderToStaticMarkup(
      <PermissionApprovalControls requests={[twoAlways]} onRespond={() => undefined} />
    )
    expect(html).toContain('data-testid="extra-option"')
    expect(html).toContain('Allow this project')
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
      ],
      raw: {}
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
      ],
      raw: {}
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
})

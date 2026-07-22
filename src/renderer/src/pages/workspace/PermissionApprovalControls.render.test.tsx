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
  it('shows the full command with copy and keeps details off action labels', () => {
    const html = renderControls()

    expect(html).toContain(longRequestTitle)
    expect(html).toContain('whitespace-pre-wrap break-words')
    expect(html).toContain('aria-label="Copy command"')
    expect(html).not.toContain(`title="${longAlwaysOptionName}"`)
    expect(html).toContain('flex min-w-0 flex-col items-stretch gap-2 overflow-hidden')
    expect(html).toContain('Always</span>')
    expect(html).not.toContain(`>${longAlwaysOptionName}</span>`)
  })

  it('orders actions by exact ACP kind with restrained design-system colors', () => {
    const html = renderControls()
    const alwaysIndex = html.indexOf('Always</span>')
    const allowOnceIndex = html.indexOf('Allow once</span>')
    const rejectIndex = html.indexOf('Reject</span>')
    const unknownKindIndex = html.indexOf(`${unknownKindOptionNameWithAlways}</span>`)
    const cancelIndex = html.indexOf('Cancel</span>')

    expect(alwaysIndex).toBeGreaterThan(-1)
    expect(allowOnceIndex).toBeGreaterThan(alwaysIndex)
    expect(rejectIndex).toBeGreaterThan(allowOnceIndex)
    expect(unknownKindIndex).toBeGreaterThan(rejectIndex)
    expect(cancelIndex).toBeGreaterThan(unknownKindIndex)
    expect(html).not.toContain(`>${allowOnceOptionNameWithAlways}</span>`)
    expect(html).toContain('border border-amber-200 bg-amber-50')
    expect(html).toContain('text-amber-900')
    expect(html).toContain('border border-amber-300 bg-white')
    expect(html).toContain('hover:bg-amber-100')
    expect(html).toContain('flex flex-wrap items-center justify-end gap-1 w-full overflow-hidden')
  })

  it('keeps multiple always-allow scopes distinguishable', () => {
    const html = renderToStaticMarkup(
      <PermissionApprovalControls
        requests={[
          {
            ...permissionRequest,
            options: [
              {
                optionId: 'allow-session',
                name: 'Allow for This Session',
                kind: 'allow_always'
              },
              {
                optionId: 'allow-always',
                name: "Allow and Don't Ask Again",
                kind: 'allow_always'
              },
              { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
              { optionId: 'decline', name: 'Decline', kind: 'reject_once' }
            ]
          }
        ]}
        onRespond={() => undefined}
      />
    )

    expect(html).toContain('Allow for This Session</span>')
    expect(html).toContain('Allow and Don&#x27;t Ask Again</span>')
    expect(html.match(/>Always<\/span>/g)).toBeNull()
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
})

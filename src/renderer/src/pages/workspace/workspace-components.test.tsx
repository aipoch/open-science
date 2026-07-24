import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const workspacePagePath = resolve(__dirname, 'WorkspacePage.tsx')
const workspaceSidebarPath = resolve(__dirname, 'WorkspaceSidebar.tsx')
const conversationPanelPath = resolve(__dirname, 'ConversationPanel.tsx')
const permissionApprovalControlsPath = resolve(__dirname, 'PermissionApprovalControls.tsx')
const appPath = resolve(__dirname, '../../App.tsx')
const workspaceMessageScrollerPath = resolve(__dirname, 'WorkspaceMessageScroller.tsx')
const workspaceActivityGroupPath = resolve(__dirname, 'WorkspaceActivityGroup.tsx')
const workspaceAgentLoadingRowPath = resolve(__dirname, 'WorkspaceAgentLoadingRow.tsx')
const workspaceMessageItemPath = resolve(__dirname, 'WorkspaceMessageItem.tsx')
const workspaceToolActivityGroupsPath = resolve(__dirname, 'workspace-tool-activity-groups.ts')
const workspaceToolActivityStylePath = resolve(__dirname, 'workspace-tool-activity-style.ts')
const workspaceWebSearchActivityRowPath = resolve(__dirname, 'WorkspaceWebSearchActivityRow.tsx')
const workspaceWebSearchDetailsPath = resolve(__dirname, 'workspace-web-search-details.ts')
const agentMarkdownPath = resolve(__dirname, '../../components/streamdown/AgentMarkdown.tsx')
const componentFileNames = [
  'WorkspaceSidebar.tsx',
  'ConversationPanel.tsx',
  'PreviewPanel.tsx',
  'RenameSessionDialog.tsx',
  'DeleteSessionDialog.tsx'
]

describe('workspace page component boundaries', () => {
  // Guards the page-level extraction without relying on Vitest alias resolution.
  it('keeps workspace regions in page-private component files', () => {
    const workspacePageSource = readFileSync(workspacePagePath, 'utf8')

    for (const fileName of componentFileNames) {
      const componentName = fileName.replace('.tsx', '')
      const componentSource = readFileSync(resolve(__dirname, fileName), 'utf8')

      expect(componentSource).toContain(`const ${componentName}`)
      expect(componentSource).toContain(`export { ${componentName} }`)
      expect(workspacePageSource).toContain(`import { ${componentName} } from './${componentName}'`)
      expect(workspacePageSource).toContain(`<${componentName}`)
    }
  })

  it('starts session persistence from the app shell and passes readiness into the workspace', () => {
    const appSource = readFileSync(appPath, 'utf8')
    const workspacePageSource = readFileSync(workspacePagePath, 'utf8')
    const workspaceSidebarSource = readFileSync(workspaceSidebarPath, 'utf8')
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')

    // Persistence is hoisted to App so sessions stay loaded across Home <-> Workspace navigation.
    expect(appSource).toContain(
      "import { useSessionPersistence } from '@/lib/session-persistence/session-persistence'"
    )
    expect(appSource).toContain('const isSessionPersistenceReady = useSessionPersistence()')
    expect(appSource).toContain('isSessionPersistenceReady={isSessionPersistenceReady}')

    expect(workspacePageSource).toContain('isSessionPersistenceReady')
    expect(workspacePageSource).toContain('isSessionPersistenceReady &&')
    expect(workspacePageSource).toContain('canCreateConversation={isSessionPersistenceReady}')
    expect(workspacePageSource).toContain('canEditDraft={canEditDraft}')
    expect(workspacePageSource).toContain('if (!isSessionPersistenceReady) return')
    expect(workspaceSidebarSource).toContain('disabled={!canCreateConversation}')
    expect(conversationPanelSource).toContain('disabled={!canEditDraft}')
  })

  it('keeps ACP debug routes and launchers out of the workspace renderer', () => {
    const appSource = readFileSync(appPath, 'utf8')
    const sidebarSource = readFileSync(resolve(__dirname, 'WorkspaceSidebar.tsx'), 'utf8')

    expect(appSource).not.toContain('acp-debug')
    expect(appSource).not.toContain('AcpDebugPage')
    expect(sidebarSource).not.toContain('AcpDebugLauncher')
    expect(sidebarSource).not.toContain('ACP Debug')
  })

  it('does not keep the debug-only transcript projection helper', () => {
    expect(existsSync(resolve(__dirname, '../../lib/acp/agent-transcript.ts'))).toBe(false)
    expect(existsSync(resolve(__dirname, '../../lib/acp/agent-transcript.test.ts'))).toBe(false)
  })

  // Permission approval has its own action mapping and layout rules, so keep it behind a page-private module.
  it('extracts permission approval controls out of the conversation panel', () => {
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')

    expect(existsSync(permissionApprovalControlsPath)).toBe(true)

    const permissionApprovalControlsSource = readFileSync(permissionApprovalControlsPath, 'utf8')

    expect(permissionApprovalControlsSource).toContain('const PermissionApprovalControls')
    expect(permissionApprovalControlsSource).toContain('export { PermissionApprovalControls }')
    expect(conversationPanelSource).toContain(
      "import { PermissionApprovalControls } from './PermissionApprovalControls'"
    )
    expect(conversationPanelSource).toContain('<PermissionApprovalControls')
    expect(conversationPanelSource).not.toContain('getPermissionActionKind')
    expect(conversationPanelSource).not.toContain('getOrderedPermissionOptions')
  })

  it('keeps the sidebar status dot decorative while render tests cover status text', () => {
    const workspaceSidebarSource = readFileSync(workspaceSidebarPath, 'utf8')

    expect(workspaceSidebarSource).toContain('aria-hidden="true"')
    expect(workspaceSidebarSource).not.toContain('aria-label={`Session status: ${session.status}`}')
  })

  it('uses workspace style tokens instead of migrated hardcoded colors', () => {
    const workspaceSources = [
      readFileSync(workspacePagePath, 'utf8'),
      readFileSync(workspaceSidebarPath, 'utf8'),
      readFileSync(conversationPanelPath, 'utf8'),
      readFileSync(workspaceMessageScrollerPath, 'utf8'),
      readFileSync(workspaceActivityGroupPath, 'utf8'),
      readFileSync(workspaceAgentLoadingRowPath, 'utf8'),
      readFileSync(workspaceMessageItemPath, 'utf8'),
      readFileSync(workspaceToolActivityStylePath, 'utf8'),
      readFileSync(workspaceWebSearchActivityRowPath, 'utf8'),
      readFileSync(resolve(__dirname, 'DeleteSessionDialog.tsx'), 'utf8'),
      readFileSync(resolve(__dirname, 'RenameSessionDialog.tsx'), 'utf8'),
      readFileSync(resolve(__dirname, 'SessionNotebookDialog.tsx'), 'utf8'),
      readFileSync(resolve(__dirname, 'notebook-code.tsx'), 'utf8')
    ].join('\n')

    for (const hardcodedColor of [
      '#c6613f',
      '#b95538',
      '#ebe7df',
      '#6b6b6b',
      '#c95f3f',
      '#1f1f1f',
      '#e5e1da',
      '#f7f6f2',
      '#d4473b',
      '#c03d32'
    ]) {
      expect(workspaceSources).not.toContain(hardcodedColor)
    }
  })

  it('does not keep duplicate workspace token aliases after consolidation', () => {
    const workspaceSources = [
      readFileSync(workspacePagePath, 'utf8'),
      readFileSync(workspaceSidebarPath, 'utf8'),
      readFileSync(conversationPanelPath, 'utf8'),
      readFileSync(workspaceMessageScrollerPath, 'utf8'),
      readFileSync(workspaceActivityGroupPath, 'utf8'),
      readFileSync(workspaceAgentLoadingRowPath, 'utf8'),
      readFileSync(workspaceMessageItemPath, 'utf8'),
      readFileSync(workspaceToolActivityStylePath, 'utf8'),
      readFileSync(workspaceWebSearchActivityRowPath, 'utf8'),
      readFileSync(resolve(__dirname, 'DeleteSessionDialog.tsx'), 'utf8'),
      readFileSync(resolve(__dirname, 'RenameSessionDialog.tsx'), 'utf8'),
      readFileSync(resolve(__dirname, 'SessionNotebookDialog.tsx'), 'utf8'),
      readFileSync(resolve(__dirname, 'notebook-code.tsx'), 'utf8')
    ].join('\n')
    const mainCssSource = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

    expect(mainCssSource).not.toContain('--color-bg-100')
    expect(mainCssSource).not.toContain('--color-text-400')
    expect(workspaceSources).not.toContain('bg-bg-100')
    expect(workspaceSources).not.toContain('text-text-400')
  })

  it('defines the token used by mention popup shadows', () => {
    const mainCssSource = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const mentionPopupSources = [
      resolve(__dirname, 'composer/SkillMentionPopup.tsx'),
      resolve(__dirname, 'composer/ArtifactMentionPopup.tsx')
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')

    expect(mentionPopupSources).toContain('var(--always-black)')
    expect(mainCssSource).toContain('--always-black:')
  })

  it('uses the shared primary token for every workspace emphasis state', () => {
    const emphasisSources = [
      conversationPanelPath,
      workspaceActivityGroupPath,
      resolve(__dirname, 'ComposerModelPicker.tsx'),
      resolve(__dirname, 'NotebookPreview.tsx'),
      resolve(__dirname, 'ProjectFilesView.tsx'),
      resolve(__dirname, '../../components/FileDropOverlay.tsx'),
      resolve(__dirname, 'previews/renderers/PdbPreview.tsx')
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
    const mainCssSource = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const deprecatedActionToken = ['action', 'primary'].join('-')

    expect(`${mainCssSource}\n${emphasisSources}`).not.toContain(deprecatedActionToken)
    expect(emphasisSources).toContain('bg-primary')
    expect(emphasisSources).toContain('text-primary')
  })

  it('keeps first-batch workspace dialogs on the settings dialog chrome', () => {
    const renameSource = readFileSync(resolve(__dirname, 'RenameSessionDialog.tsx'), 'utf8')
    const deleteSource = readFileSync(resolve(__dirname, 'DeleteSessionDialog.tsx'), 'utf8')
    const notebookSource = readFileSync(resolve(__dirname, 'SessionNotebookDialog.tsx'), 'utf8')

    for (const source of [renameSource, notebookSource]) {
      expect(source).toContain('dialogOverlayClassName')
      expect(source).toContain('dialogPanelClassName')
      expect(source).toContain('onInteractOutside={(event) => event.preventDefault()}')
      expect(source).not.toContain('backdrop-blur')
    }

    expect(deleteSource).toContain('dialogOverlayClassName')
    expect(deleteSource).toContain('dialogPanelClassName')
    expect(deleteSource).toContain('AlertDialog.Root')
    expect(deleteSource).not.toContain('backdrop-blur')

    expect(notebookSource).toContain('dialogPanelClassName(')
    expect(notebookSource).toContain('w-[calc(100%-2rem)] max-w-5xl')
  })
})

describe('conversation message scroller integration', () => {
  // The conversation panel delegates transcript scrolling to a local usage wrapper.
  it('uses the shadcn message scroller wrapper for transcript scrolling', () => {
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')

    if (!existsSync(workspaceMessageScrollerPath)) {
      expect(existsSync(workspaceMessageScrollerPath)).toBe(true)
      return
    }

    const workspaceMessageScrollerSource = readFileSync(workspaceMessageScrollerPath, 'utf8')

    expect(workspaceMessageScrollerSource).toContain('const WorkspaceMessageScroller')
    expect(workspaceMessageScrollerSource).toContain('export { WorkspaceMessageScroller }')
    expect(conversationPanelSource).toContain(
      "import { WorkspaceMessageScroller } from './WorkspaceMessageScroller'"
    )
    expect(conversationPanelSource).toContain('<WorkspaceMessageScroller')
    expect(conversationPanelSource).toContain('activeSession={activeSession}')
    expect(conversationPanelSource).not.toContain('@/components/ui/scroll-area')
    expect(conversationPanelSource).not.toContain('<ScrollArea')
  })

  // The wrapper follows the documented new-turn anchoring behavior from Message Scroller.
  it('configures documented message scroller anchoring for chat turns', () => {
    if (!existsSync(workspaceMessageScrollerPath)) {
      expect(existsSync(workspaceMessageScrollerPath)).toBe(true)
      return
    }

    const workspaceMessageScrollerSource = readFileSync(workspaceMessageScrollerPath, 'utf8')
    const workspaceMessageItemSource = readFileSync(workspaceMessageItemPath, 'utf8')

    expect(workspaceMessageScrollerSource).toContain('autoScroll')
    expect(workspaceMessageScrollerSource).toContain('defaultScrollPosition="last-anchor"')
    expect(workspaceMessageScrollerSource).toContain(
      "key={activeSession?.id ?? 'empty-conversation'}"
    )
    expect(workspaceMessageScrollerSource).toContain('scrollPreviousItemPeek={64}')
    expect(workspaceMessageScrollerSource).toContain('<WorkspaceMessageItem')
    expect(workspaceMessageItemSource).toContain("scrollAnchor={message.role === 'user'}")
    expect(workspaceMessageItemSource).toContain('messageId={message.id}')
    expect(workspaceMessageItemSource).toContain('<AgentMarkdown')
    expect(workspaceMessageItemSource).toContain('content={message.content}')
  })

  // Agent replies should read as a full-width transcript surface, while user bubbles stay compact.
  it('renders agent replies across the full scroller width', () => {
    if (!existsSync(workspaceMessageScrollerPath)) {
      expect(existsSync(workspaceMessageScrollerPath)).toBe(true)
      return
    }

    const workspaceMessageItemSource = readFileSync(workspaceMessageItemPath, 'utf8')
    const workspaceMessageScrollerSource = readFileSync(workspaceMessageScrollerPath, 'utf8')

    expect(workspaceMessageItemSource).toContain(
      'className="group flex items-center justify-end gap-1"'
    )
    expect(workspaceMessageItemSource).toContain(
      "'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text md:max-w-[min(85%,56rem)] md:px-4 md:py-2.5 md:text-[15px]'"
    )
    expect(workspaceMessageItemSource).toContain(
      "'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px]'"
    )
    expect(workspaceMessageScrollerSource).toContain('conversationContentClassName')
    expect(workspaceMessageScrollerSource).toContain('mx-auto w-full max-w-4xl')
  })

  it('matches the reference page chat background and assistant progress surfaces', () => {
    if (!existsSync(workspaceMessageScrollerPath)) {
      expect(existsSync(workspaceMessageScrollerPath)).toBe(true)
      return
    }

    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')
    const workspaceMessageScrollerSource = readFileSync(workspaceMessageScrollerPath, 'utf8')
    const workspaceAgentLoadingRowSource = readFileSync(workspaceAgentLoadingRowPath, 'utf8')

    expect(conversationPanelSource).toContain('bg-bg-10')
    expect(conversationPanelSource).toContain('composerContentClassName')
    expect(conversationPanelSource).toContain('mx-auto w-full max-w-4xl')
    expect(conversationPanelSource).toContain('px-4 pb-2')
    expect(conversationPanelSource).toContain('px-1 md:px-3')
    expect(workspaceMessageScrollerSource).toContain('bg-bg-10')
    expect(workspaceMessageScrollerSource).toContain('pb-[56px]')
    expect(workspaceMessageScrollerSource).toContain('bg-gradient-to-b from-bg-10 to-bg-10/0')
    expect(workspaceAgentLoadingRowSource).toContain('rounded-2xl bg-bg-200 px-3 py-2')
  })

  it('uses compact prose spacing for agent markdown', () => {
    const agentMarkdownSource = readFileSync(agentMarkdownPath, 'utf8')

    expect(agentMarkdownSource).toContain('prose-sm')
    expect(agentMarkdownSource).toContain('prose-p:my-1')
    expect(agentMarkdownSource).toContain('prose-ul:my-1')
    expect(agentMarkdownSource).toContain('prose-li:my-0.5')
  })

  it('keeps permission prompts constrained to the conversation content width', () => {
    const permissionApprovalControlsSource = readFileSync(permissionApprovalControlsPath, 'utf8')

    // Outer container maintains width constraints (overflow-visible so the scope dropdown is not clipped)
    expect(permissionApprovalControlsSource).toContain(
      'className="mb-2 w-full max-w-full rounded-lg border border-border-200'
    )
    // Header maintains min-w-0 for text truncation
    expect(permissionApprovalControlsSource).toContain(
      'className="mb-2 flex min-w-0 items-center gap-2"'
    )
    // Code block uses WorkspaceToolCodeBlock with max-height constraint
    expect(permissionApprovalControlsSource).toContain('WorkspaceToolCodeBlock')
    // Button row maintains layout constraints
    expect(permissionApprovalControlsSource).toContain(
      'className="flex items-center justify-end gap-2"'
    )
  })

  it('keeps composer attachment UI inline with the composer', () => {
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')

    expect(existsSync(resolve(__dirname, 'ComposerAttachmentList.tsx'))).toBe(false)
    expect(conversationPanelSource).toContain('onPaste={handleMessageDraftPaste}')
    expect(conversationPanelSource).toContain('type="file"')
    expect(conversationPanelSource).toContain('multiple')
    expect(conversationPanelSource).toContain('onRemoveAttachment')
    expect(conversationPanelSource).not.toContain('ComposerAttachmentList')
  })

  // Runtime tool calls should be visible without becoming assistant markdown content.
  it('renders session activities separately from chat messages', () => {
    if (!existsSync(workspaceMessageScrollerPath)) {
      expect(existsSync(workspaceMessageScrollerPath)).toBe(true)
      return
    }

    const workspaceMessageScrollerSource = readFileSync(workspaceMessageScrollerPath, 'utf8')

    expect(workspaceMessageScrollerSource).toContain('createConversationItems')
    expect(workspaceMessageScrollerSource).toContain('groupConversationItems')
    expect(workspaceMessageScrollerSource).toContain('<WorkspaceActivityGroup')
    expect(workspaceMessageScrollerSource).not.toContain('createActivityDetailsDomId')
    expect(workspaceMessageScrollerSource).not.toContain('formatWebSearchDetails')
    expect(workspaceMessageScrollerSource).not.toContain('formatActivityTitle(activity)')
    expect(workspaceMessageScrollerSource).not.toContain('formatActivityDisplayTitle(activity)')
    expect(workspaceMessageScrollerSource).not.toContain('isWebSearchActivity(activity)')
    expect(workspaceMessageScrollerSource).not.toContain('createActivityToggleLabel(')
    expect(workspaceMessageScrollerSource).not.toContain('renderWebSearchDetails(')
    expect(workspaceMessageScrollerSource).not.toContain('formatActivityDetails(activity)')
    expect(workspaceMessageScrollerSource).toContain('conversationItems.map((item, itemIndex)')
    expect(workspaceMessageScrollerSource).toMatch(/import \{[^}]*\buseState\b[^}]*\} from 'react'/)
    expect(workspaceMessageScrollerSource).toContain('const currentSessionId = activeSession?.id')
    expect(workspaceMessageScrollerSource).toContain(
      'collapsedActivityGroupState.sessionId === currentSessionId'
    )
    expect(workspaceMessageScrollerSource).toContain(
      'activityExpansionOverrideState.sessionId === currentSessionId'
    )
    expect(workspaceMessageScrollerSource).not.toContain('<AgentMarkdown')
    expect(workspaceMessageScrollerSource).not.toContain('content={message.content}')
  })

  it('keeps transcript rendering modules focused by responsibility', () => {
    expect(existsSync(workspaceMessageItemPath)).toBe(true)
    expect(existsSync(workspaceActivityGroupPath)).toBe(true)
    expect(existsSync(workspaceWebSearchActivityRowPath)).toBe(true)
    expect(existsSync(workspaceAgentLoadingRowPath)).toBe(true)
    expect(existsSync(workspaceToolActivityGroupsPath)).toBe(true)
    expect(existsSync(workspaceWebSearchDetailsPath)).toBe(true)

    const workspaceMessageScrollerSource = readFileSync(workspaceMessageScrollerPath, 'utf8')
    const workspaceActivityGroupSource = readFileSync(workspaceActivityGroupPath, 'utf8')
    const workspaceWebSearchActivityRowSource = readFileSync(
      workspaceWebSearchActivityRowPath,
      'utf8'
    )
    const workspaceMessageItemSource = readFileSync(workspaceMessageItemPath, 'utf8')
    const workspaceAgentLoadingRowSource = readFileSync(workspaceAgentLoadingRowPath, 'utf8')

    expect(workspaceMessageScrollerSource).toContain(
      "import { WorkspaceMessageItem } from './WorkspaceMessageItem'"
    )
    expect(workspaceMessageScrollerSource).toContain(
      "import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'"
    )
    expect(workspaceMessageScrollerSource).toContain(
      "import { WorkspaceAgentLoadingRow } from './WorkspaceAgentLoadingRow'"
    )
    expect(workspaceActivityGroupSource).toContain('const WorkspaceActivityGroup')
    expect(workspaceActivityGroupSource).toContain('data-testid="tool-group"')
    expect(workspaceActivityGroupSource).toContain('data-testid="tool-group-header"')
    expect(workspaceActivityGroupSource).toContain('<WorkspaceWebSearchActivityRow')
    expect(workspaceActivityGroupSource).toContain(
      'formatActivityGroupTitle(group.activities, group.title)'
    )
    expect(workspaceActivityGroupSource).toContain('getRenderableActivityEntries(group.activities)')
    expect(workspaceWebSearchActivityRowSource).toContain('const WorkspaceWebSearchActivityRow')
    expect(workspaceWebSearchActivityRowSource).toContain('<WorkspaceToolActivityRowButton')
    expect(workspaceWebSearchActivityRowSource).toContain('panelTestId="tool-search-details"')
    expect(workspaceWebSearchActivityRowSource).toContain(
      'formatResultCountLabel(details.resultCount)'
    )
    expect(workspaceWebSearchActivityRowSource).toContain(
      'canExpand={Boolean(details.query || details.resultCount)}'
    )
    expect(workspaceMessageItemSource).toContain('const WorkspaceMessageItem')
    expect(workspaceMessageItemSource).toContain('<AgentMarkdown')
    expect(workspaceMessageItemSource).toContain('content={message.content}')
    expect(workspaceAgentLoadingRowSource).toContain('const WorkspaceAgentLoadingRow')
    expect(workspaceAgentLoadingRowSource).toContain('Agent is responding')
  })

  // Non-search tool calls render an expandable details row backed by a dedicated parser module.
  it('wires expandable tool detail rows into the activity group', () => {
    const workspaceToolActivityDetailsPath = resolve(
      __dirname,
      'workspace-tool-activity-details.ts'
    )
    const workspaceToolDetailsRowPath = resolve(__dirname, 'WorkspaceToolDetailsRow.tsx')
    const workspaceToolCodeBlockPath = resolve(__dirname, 'WorkspaceToolCodeBlock.tsx')
    const workspaceToolDiffBlockPath = resolve(__dirname, 'WorkspaceToolDiffBlock.tsx')
    const workspaceToolRowButtonPath = resolve(__dirname, 'WorkspaceToolActivityRowButton.tsx')

    expect(existsSync(workspaceToolActivityDetailsPath)).toBe(true)
    expect(existsSync(workspaceToolDetailsRowPath)).toBe(true)
    expect(existsSync(workspaceToolCodeBlockPath)).toBe(true)
    expect(existsSync(workspaceToolDiffBlockPath)).toBe(true)
    expect(existsSync(workspaceToolRowButtonPath)).toBe(true)

    const workspaceActivityGroupSource = readFileSync(workspaceActivityGroupPath, 'utf8')
    const workspaceToolDetailsRowSource = readFileSync(workspaceToolDetailsRowPath, 'utf8')
    const workspaceToolCodeBlockSource = readFileSync(workspaceToolCodeBlockPath, 'utf8')
    const workspaceToolRowButtonSource = readFileSync(workspaceToolRowButtonPath, 'utf8')

    expect(workspaceActivityGroupSource).toContain('buildToolActivityDetails(activity)')
    expect(workspaceActivityGroupSource).toContain('<WorkspaceToolDetailsRow')
    expect(workspaceToolDetailsRowSource).toContain('const WorkspaceToolDetailsRow')
    expect(workspaceToolDetailsRowSource).toContain('<WorkspaceToolActivityRowButton')
    expect(workspaceToolDetailsRowSource).toContain('panelTestId="tool-details"')
    expect(workspaceToolDetailsRowSource).toContain('<WorkspaceToolCodeBlock')
    expect(workspaceToolDetailsRowSource).toContain('<WorkspaceToolDiffBlock')
    // The expandable row shell (icon + label + panel + aria wiring) is shared by both row types.
    expect(workspaceToolRowButtonSource).toContain('const WorkspaceToolActivityRowButton')
    expect(workspaceToolRowButtonSource).toContain('data-testid="tool-chip"')
    expect(workspaceToolRowButtonSource).toContain('aria-controls={canExpand ? detailsDomId')
    // Code blocks reuse the shared Shiki highlighter for consistent syntax colors.
    expect(workspaceToolCodeBlockSource).toContain("from '@streamdown/code'")
    expect(workspaceToolCodeBlockSource).toContain('code.highlight(')
  })

  it('keeps generated artifact cards the same size when expanded inline', () => {
    if (!existsSync(workspaceMessageScrollerPath)) {
      expect(existsSync(workspaceMessageScrollerPath)).toBe(true)
      return
    }

    const workspaceMessageItemSource = readFileSync(workspaceMessageItemPath, 'utf8')

    expect(workspaceMessageItemSource).toContain('const artifactCardClassName')
    expect(workspaceMessageItemSource).toContain('h-[82px] w-[128px]')
    expect(workspaceMessageItemSource).toContain('grid-cols-[repeat(auto-fill,128px)]')
    expect(workspaceMessageItemSource).toContain('artifactGalleryClassName')
    expect(workspaceMessageItemSource).not.toContain('overflow-x-auto')
    expect(workspaceMessageItemSource).not.toContain("isGrid ? 'h-[132px] w-full'")
    expect(workspaceMessageItemSource).not.toContain('h-[92px]')
  })

  // Running sessions render a transient assistant row until the first text chunk appears.
  it('renders an accessible agent loading indicator before streamed text arrives', () => {
    if (!existsSync(workspaceMessageScrollerPath)) {
      expect(existsSync(workspaceMessageScrollerPath)).toBe(true)
      return
    }

    const workspaceMessageScrollerSource = readFileSync(workspaceMessageScrollerPath, 'utf8')
    const workspaceAgentLoadingRowSource = readFileSync(workspaceAgentLoadingRowPath, 'utf8')
    const workspaceMessageItemSource = readFileSync(workspaceMessageItemPath, 'utf8')

    expect(workspaceMessageScrollerSource).toContain(
      "import { shouldShowAgentLoadingMessage } from './agent-loading-message'"
    )
    expect(workspaceMessageScrollerSource).toContain(
      'const showAgentLoadingMessage = shouldShowAgentLoadingMessage(activeSession)'
    )
    expect(workspaceMessageScrollerSource).toContain('<WorkspaceAgentLoadingRow')
    expect(workspaceAgentLoadingRowSource).toContain('role="status"')
    expect(workspaceAgentLoadingRowSource).toContain('aria-live="polite"')
    expect(workspaceAgentLoadingRowSource).toContain('Agent is responding')
    expect(workspaceMessageItemSource).toContain("isAnimating={message.status === 'streaming'}")
  })
})

describe('conversation composer editor integration', () => {
  // The composer is a contenteditable ComposerEditor that owns Enter-to-send and skill chips.
  it('wires the ComposerEditor submit path to the skill-id send handler', () => {
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')

    expect(conversationPanelSource).toContain(
      "import { ComposerEditor } from './composer/ComposerEditor'"
    )
    expect(conversationPanelSource).toContain('onSendMessage(docToSkillIds(draftDoc))')
    expect(conversationPanelSource).toContain('onSubmit={handleSubmit}')
    expect(conversationPanelSource).toContain('onDocChange={onDraftDocChange}')
  })
})

describe('preview workbench integration', () => {
  // The workspace shell owns the resizable panel ref while preview state stays in the workbench store.
  it('wires preview open requests to the right resizable panel', () => {
    const workspacePageSource = readFileSync(workspacePagePath, 'utf8')

    expect(workspacePageSource).toContain('usePreviewWorkbenchStore')
    expect(workspacePageSource).toContain("from '@/stores/preview-workbench-store'")
    expect(workspacePageSource).toContain(
      "import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'"
    )
    expect(workspacePageSource).toContain(
      'const previewPanelRef = useRef<PanelImperativeHandle | null>(null)'
    )
    expect(workspacePageSource).toContain(
      'const previewOpenRequestVersion = usePreviewWorkbenchStore((state) => state.openRequestVersion)'
    )
    expect(workspacePageSource).toContain("import { animate } from 'motion'")
    expect(workspacePageSource).toContain('animatePreviewPanelSize')
    expect(workspacePageSource).toContain('panelRef={previewPanelRef}')
    expect(workspacePageSource).toContain('onResize={syncPreviewPanelResize}')
    expect(workspacePageSource).toContain("disabled={previewPanelState === 'collapsed'}")
    expect(workspacePageSource).toContain("aria-hidden={previewPanelState === 'collapsed'}")
  })

  it('sizes the conversation and preview split by percentages', () => {
    const workspacePageSource = readFileSync(workspacePagePath, 'utf8')
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')
    const previewPanelSource = readFileSync(resolve(__dirname, 'PreviewPanel.tsx'), 'utf8')

    expect(workspacePageSource).toContain(
      'panelSize.asPercentage <= PREVIEW_PANEL_COLLAPSED_THRESHOLD'
    )
    expect(conversationPanelSource).toContain('defaultSize="60%"')
    expect(conversationPanelSource).toContain('minSize="30%"')
    expect(conversationPanelSource).not.toContain('minSize="520px"')
    expect(workspacePageSource).toContain(
      'const PREVIEW_PANEL_MIN_OPEN_SIZE_CSS = `${PREVIEW_PANEL_MIN_OPEN_SIZE}%`'
    )
    expect(workspacePageSource).toContain(
      'const PREVIEW_PANEL_DEFAULT_SIZE_CSS = `${PREVIEW_PANEL_DEFAULT_SIZE}%`'
    )
    expect(workspacePageSource).toContain(
      'const PREVIEW_PANEL_COLLAPSED_SIZE_CSS = `${PREVIEW_PANEL_COLLAPSED_SIZE}%`'
    )
    expect(previewPanelSource).toContain('defaultSize={defaultSize}')
    expect(previewPanelSource).toContain('minSize={minSize}')
    expect(previewPanelSource).toContain('collapsedSize="0%"')
    expect(previewPanelSource).not.toContain('maxSize=')
    expect(previewPanelSource).not.toContain('preserve-pixel-size')
  })

  it('animates panel expand and collapse through percentage resize', () => {
    const workspacePageSource = readFileSync(workspacePagePath, 'utf8')

    expect(workspacePageSource).toContain('currentPanel.resize(`${Number(size.toFixed(3))}%`)')
    expect(workspacePageSource).toContain('onUpdate: resizePanel')
    expect(workspacePageSource).toContain('prefersReducedMotion')
    expect(workspacePageSource).toContain(
      'const PREVIEW_PANEL_ANIMATING_MIN_SIZE = PREVIEW_PANEL_COLLAPSED_SIZE_CSS'
    )
    expect(workspacePageSource).toContain('hasSyncedInitialPreviewPanelSizeRef')
  })

  // Notebook availability is pushed by the main process after the agent first calls notebook MCP.
  it('promotes agent notebook availability into a composer entry without auto-opening preview', () => {
    const workspacePageSource = readFileSync(workspacePagePath, 'utf8')
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')

    expect(workspacePageSource).toContain('window.api.notebook.onAvailable')
    expect(workspacePageSource).toContain('setNotebookReferences')
    expect(workspacePageSource).toContain('upsertPreviewItem(createNotebookPreviewItem(notebook))')
    expect(workspacePageSource).toContain(
      'upsertAndActivatePreviewItem(createNotebookPreviewItem(notebook))'
    )
    expect(workspacePageSource).toContain('notebookReference={activeNotebookReference}')
    expect(workspacePageSource).toContain('onOpenNotebook={openNotebookPreview}')
    expect(conversationPanelSource).toContain('notebookReference: NotebookSessionReference')
    expect(conversationPanelSource).toContain(
      'onOpenNotebook: (notebook: NotebookSessionReference)'
    )
    expect(conversationPanelSource).toContain('aria-label="Open notebook"')
    expect(conversationPanelSource).toContain('<BookOpen')
  })

  // The conversation title exposes the only always-visible manual panel toggle.
  it('puts the preview panel toggle at the right edge of the conversation title', () => {
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')

    expect(conversationPanelSource).toContain('PanelRight')
    expect(conversationPanelSource).toContain('isPreviewPanelCollapsed: boolean')
    expect(conversationPanelSource).toContain('onTogglePreviewPanel: () => void')
    expect(conversationPanelSource).toContain('aria-controls="right-panel"')
    expect(conversationPanelSource).toContain(
      "aria-label={isPreviewPanelCollapsed ? 'Expand preview panel' : 'Collapse preview panel'}"
    )
    expect(conversationPanelSource).toContain('<PanelRight')
    expect(conversationPanelSource).toContain("'text-action-panel-toggle' : 'text-primary'")
    expect(conversationPanelSource).toContain('fill="none"')
  })

  // The right panel uses react-resizable-panels collapse semantics instead of conditional rendering.
  it('configures the preview panel as a collapsible resizable panel', () => {
    const previewPanelSource = readFileSync(resolve(__dirname, 'PreviewPanel.tsx'), 'utf8')

    expect(previewPanelSource).toContain(
      "import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'"
    )
    expect(previewPanelSource).toContain('panelRef: React.Ref<PanelImperativeHandle>')
    expect(previewPanelSource).toContain('defaultSize: string')
    expect(previewPanelSource).toContain('minSize: string')
    expect(previewPanelSource).toContain(
      'onResize: (panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void'
    )
    expect(previewPanelSource).toContain('panelRef={panelRef}')
    expect(previewPanelSource).toContain('collapsible')
    expect(previewPanelSource).toContain('collapsedSize="0%"')
    expect(previewPanelSource).toContain('onResize={handleResize}')
    expect(previewPanelSource).toContain(
      "import { PreviewFileContent } from './previews/PreviewFileContent'"
    )
    expect(previewPanelSource).toContain(
      "import { PreviewToolContent } from './previews/PreviewToolContent'"
    )
    expect(previewPanelSource).toContain(
      "if (item.type === 'tool') return <PreviewToolContent item={item} />"
    )
    expect(previewPanelSource).toContain('<PreviewFileContent item={item} />')
  })

  // The notebook pane renders shared execution history while user code enters through terminal input.
  it('renders notebook preview as history plus terminal input without toolbar run controls', () => {
    const notebookPreviewSource = readFileSync(resolve(__dirname, 'NotebookPreview.tsx'), 'utf8')

    expect(notebookPreviewSource).toContain('const NotebookRunCell')
    expect(notebookPreviewSource).toContain('const TerminalScrollback')
    expect(notebookPreviewSource).toContain('const TerminalInput')
    expect(notebookPreviewSource).toContain('data-testid="notebook-cells"')
    expect(notebookPreviewSource).toContain('data-testid="kernel-terminal-input"')
    expect(notebookPreviewSource).toContain("import { NotebookCodeBlock } from './notebook-code'")
    expect(notebookPreviewSource).toContain('window.api.notebook.state')
    expect(notebookPreviewSource).toContain('window.api.notebook.execute')
    expect(notebookPreviewSource).toContain('window.api.notebook.onChanged')
    expect(notebookPreviewSource).toContain('notebookState?.runs')
    expect(notebookPreviewSource).toContain("source: 'user'")
    expect(notebookPreviewSource).toContain("inputKind: 'terminal'")
    expect(notebookPreviewSource).toContain(
      "import {\n  resolveRunErrorLine,\n  environmentLabel,\n  isProblemRunStatus,\n  kernelKindLabel,\n  kernelOriginLabel,\n  resolveRunEnvironment,\n  resolveRunKernelKind\n} from './notebook-cell-utils'"
    )
    expect(notebookPreviewSource).toContain('[{index}]')
    expect(notebookPreviewSource).toContain('resolveRunKernelKind(run)')
    expect(notebookPreviewSource).not.toContain('aria-label="Refresh notebook"')
    expect(notebookPreviewSource).not.toContain('aria-label="Restart notebook"')
    expect(notebookPreviewSource).not.toContain('text-text-400')
    expect(notebookPreviewSource).not.toContain('text-session-running')
    expect(notebookPreviewSource).not.toContain('text-session-waiting')
    expect(notebookPreviewSource).not.toContain('AgentMarkdown')
  })
})

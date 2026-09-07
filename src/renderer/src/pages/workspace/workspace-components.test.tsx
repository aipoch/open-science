import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const workspacePagePath = resolve(__dirname, 'WorkspacePage.tsx')
const workspacePanelLayoutPath = resolve(__dirname, 'workspace-panel-layout.tsx')
const workspaceSidebarPath = resolve(__dirname, 'WorkspaceSidebar.tsx')
const workspaceSidebarContainerPath = resolve(__dirname, 'WorkspaceSidebarContainer.tsx')
const conversationPanelPath = resolve(__dirname, 'ConversationPanel.tsx')
const permissionApprovalControlsPath = resolve(__dirname, 'PermissionApprovalControls.tsx')
const appPath = resolve(__dirname, '../../App.tsx')
const presentationHostPath = resolve(__dirname, '../../ApplicationPresentationHost.tsx')
const applicationStartupPath = resolve(__dirname, '../../hooks/useApplicationStartup.ts')
const workspaceMessageScrollerPath = resolve(__dirname, 'WorkspaceMessageScroller.tsx')
const workspaceConversationTimelinePath = resolve(__dirname, 'workspace-conversation-timeline.ts')
const workspaceActivityGroupPath = resolve(__dirname, 'WorkspaceActivityGroup.tsx')
const workspaceAgentLoadingRowPath = resolve(__dirname, 'WorkspaceAgentLoadingRow.tsx')
const workspaceMessageItemPath = resolve(__dirname, 'WorkspaceMessageItem.tsx')
const workspaceArtifactVisibilityPath = resolve(__dirname, 'WorkspaceArtifactVisibility.tsx')
const workspaceToolActivityGroupsPath = resolve(__dirname, 'workspace-tool-activity-groups.ts')
const workspaceToolActivityStylePath = resolve(__dirname, 'workspace-tool-activity-style.ts')
const workspaceWebSearchActivityRowPath = resolve(__dirname, 'WorkspaceWebSearchActivityRow.tsx')
const workspaceWebSearchDetailsPath = resolve(__dirname, 'workspace-web-search-details.ts')
const agentMarkdownPath = resolve(__dirname, '../../components/streamdown/AgentMarkdown.tsx')
const projectFilesFacadePath = resolve(__dirname, 'ProjectFilesView.tsx')
const projectFilesPresentationOwnerPath = resolve(__dirname, 'project-files-presentation-owner.tsx')
const rawLineCount = (source: string): number => source.trimEnd().split(/\r?\n/).length
const componentFileNames = [
  'WorkspaceSidebar.tsx',
  'ConversationPanel.tsx',
  'PreviewPanel.tsx',
  'EditSessionDialog.tsx',
  'DeleteSessionDialog.tsx'
]

describe('workspace page component boundaries', () => {
  // Guards the page-level extraction without relying on Vitest alias resolution.
  it('keeps workspace regions in page-private component files', () => {
    const workspacePageSource = readFileSync(workspacePagePath, 'utf8')
    const workspacePanelLayoutSource = readFileSync(workspacePanelLayoutPath, 'utf8')
    const workspaceSidebarSource = readFileSync(workspaceSidebarPath, 'utf8')
    // The sidebar's session-list subscription lives in a container between the page and the view.
    const workspaceSidebarContainerSource = readFileSync(workspaceSidebarContainerPath, 'utf8')

    for (const fileName of componentFileNames) {
      const componentName = fileName.replace('.tsx', '')
      const componentSource = readFileSync(resolve(__dirname, fileName), 'utf8')
      const ownerSource =
        componentName === 'PreviewPanel'
          ? workspacePanelLayoutSource
          : componentName === 'WorkspaceSidebar'
            ? workspaceSidebarContainerSource
            : workspacePageSource

      expect(componentSource).toContain(`const ${componentName}`)
      expect(componentSource).toContain(`export { ${componentName} }`)
      expect(ownerSource).toContain(`import { ${componentName} } from './${componentName}'`)
      expect(ownerSource).toContain(`<${componentName}`)
    }

    expect(workspacePageSource).toContain(
      "import { WorkspaceSidebarContainer } from './WorkspaceSidebarContainer'"
    )
    expect(workspacePageSource).toContain('<WorkspaceSidebarContainer')
    expect(workspaceSidebarContainerSource).toContain('starNudgeKey={projectId}')
    expect(workspaceSidebarSource).toContain('nudgeKey={activeStarNudgeKey}')

    expect(workspacePageSource).toContain(
      "import { WorkspacePanelLayout } from './workspace-panel-layout'"
    )
    expect(workspacePageSource).toContain('<WorkspacePanelLayout')
    expect(workspacePanelLayoutSource).toContain('const WorkspacePanelLayout')
    expect(workspacePanelLayoutSource).toContain('export { WorkspacePanelLayout }')
    expect(workspacePageSource).not.toContain("from './PreviewPanel'")
  })

  it('keeps project file presentation behind its private owner module', () => {
    const facadeSource = readFileSync(projectFilesFacadePath, 'utf8')
    const presentationSource = readFileSync(projectFilesPresentationOwnerPath, 'utf8')
    const previewToolSource = readFileSync(
      resolve(__dirname, 'previews/PreviewToolContent.tsx'),
      'utf8'
    )
    const moduleImpact = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../../scripts/ci/module-impact.json'), 'utf8')
    ) as {
      modules: { project_files_view: { ownerPaths: string[] } }
    }

    expect(rawLineCount(facadeSource)).toBeLessThanOrEqual(900)
    // Translation wrappers and Notebook kernel-stop confirmations add render-only lines to the
    // granted-roots presentation. Keep the cap close to the current size so functional
    // responsibilities still have to move behind an owner.
    expect(rawLineCount(presentationSource)).toBeLessThanOrEqual(810)
    expect(facadeSource).toContain("from './project-files-presentation-owner'")
    expect(presentationSource).not.toContain("from './ProjectFilesView'")
    expect(facadeSource.match(/export \{ ProjectFilesView \}/g)).toHaveLength(1)
    expect(previewToolSource).toContain("from '../ProjectFilesView'")
    expect(previewToolSource).not.toContain('project-files-presentation-owner')
    expect(moduleImpact.modules.project_files_view.ownerPaths).toContain(
      'src/renderer/src/pages/workspace/project-files-presentation-owner.tsx'
    )
  })

  it('starts session persistence from the app shell and passes readiness into the workspace', () => {
    const appSource = readFileSync(appPath, 'utf8')
    const hostSource = readFileSync(presentationHostPath, 'utf8')
    const startupSource = readFileSync(applicationStartupPath, 'utf8')
    const workspacePageSource = readFileSync(workspacePagePath, 'utf8')
    const workspaceSidebarSource = readFileSync(workspaceSidebarPath, 'utf8')
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')

    // Persistence is hoisted to the app-shell startup owner so sessions stay loaded across Home <-> Workspace navigation.
    expect(startupSource).toContain("from '@/lib/session-persistence/session-persistence'")
    expect(startupSource).toContain('const sessions = useSessionPersistence()')
    expect(hostSource).toContain('useApplicationStartup()')
    expect(hostSource).toContain('isSessionPersistenceReady={sessions.isReady}')
    expect(hostSource).toContain('<WorkspaceComputeRecoveryBridge enabled={sessions.isReady} />')
    expect(appSource).not.toContain('useSessionPersistence')
    expect(workspacePageSource).not.toContain('useJobAnalysisEffect')

    expect(workspacePageSource).toContain('isSessionPersistenceReady')
    expect(workspacePageSource).toContain('isSessionPersistenceReady &&')
    expect(workspacePageSource).toContain('canCreateConversation={isSessionPersistenceReady}')
    expect(workspacePageSource).toContain('canMutateConversations={isSessionPersistenceReady}')
    expect(workspacePageSource).toContain('view={{')
    expect(workspacePageSource).toContain('canEditDraft,')
    expect(workspacePageSource).toContain('if (!isSessionPersistenceReady) return')
    expect(workspaceSidebarSource).toContain('disabled={!canCreateConversation}')
    expect(workspaceSidebarSource).toMatch(
      /createSessionActionBindings\(\{\s*canMutateConversations,/u
    )
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
      readFileSync(resolve(__dirname, 'EditSessionDialog.tsx'), 'utf8'),
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
      readFileSync(resolve(__dirname, 'EditSessionDialog.tsx'), 'utf8'),
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

  it('uses one theme-aware fade treatment for horizontal workspace scrollers', () => {
    const mainCssSource = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const horizontalScrollerSources = [
      'PreviewPanel.tsx',
      'NotebookPreview.tsx',
      'NotebookInputDataStrip.tsx',
      'ArtifactProvenancePanel.tsx'
    ].map((fileName) => readFileSync(resolve(__dirname, fileName), 'utf8'))

    expect(mainCssSource).toContain('.scroll-fade-x')
    expect(mainCssSource).toContain(".scroll-fade-x[data-scroll-fade='both']")
    expect(mainCssSource).toContain('-webkit-mask-image: var(--scroll-fade-x-mask, none)')
    expect(mainCssSource).toContain('hsl(var(--always-black))')
    for (const source of horizontalScrollerSources) expect(source).toContain('scroll-fade-x')
  })

  it('keeps desktop workspace bottom spacing aligned with the tighter top spacing', () => {
    const workspacePanelLayoutSource = readFileSync(workspacePanelLayoutPath, 'utf8')
    const sidebarSource = readFileSync(workspaceSidebarPath, 'utf8')
    const conversationPanelSource = readFileSync(conversationPanelPath, 'utf8')
    const previewPanelSource = readFileSync(resolve(__dirname, 'PreviewPanel.tsx'), 'utf8')

    expect(workspacePanelLayoutSource).not.toContain('-my-[10px]')
    expect(workspacePanelLayoutSource).not.toContain('h-[calc(100%+20px)]')
    expect(workspacePanelLayoutSource).toContain("'min-w-0 flex-1'")
    expect(sidebarSource).toContain('m-[0.7px]')
    expect(sidebarSource).not.toContain('m-px flex min-h-0')
    expect(sidebarSource).not.toContain('m-0.5 flex min-h-0')
    expect(sidebarSource).not.toContain('m-1 flex min-h-0')
    expect(sidebarSource).not.toContain('m-2 flex min-h-0')
    expect(conversationPanelSource).toContain('p-[6px] pl-4')
    expect(conversationPanelSource).toContain('md:pb-[6px]')
    expect(previewPanelSource).toContain('py-[0.7px]')
    expect(previewPanelSource).not.toContain('py-px')
    expect(previewPanelSource).not.toContain('py-0.5')
    expect(previewPanelSource).not.toContain('py-1')
    expect(previewPanelSource).not.toContain('py-2')
    expect(previewPanelSource).not.toContain('py-[10px]')
  })

  it('registers the semantic chart tokens used by the response Usage breakdown', () => {
    const mainCssSource = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const messageItemSource = readFileSync(workspaceMessageItemPath, 'utf8')

    for (const token of ['chart-1', 'chart-2', 'chart-3']) {
      expect(messageItemSource).toContain(`bg-${token}`)
      expect(mainCssSource).toContain(`--color-${token}: var(--${token});`)
      expect(mainCssSource.match(new RegExp(`--${token}:`, 'g'))).toHaveLength(2)
    }
  })

  it('uses the shared primary token for every workspace emphasis state', () => {
    const emphasisSources = [
      conversationPanelPath,
      workspaceActivityGroupPath,
      resolve(__dirname, 'ComposerModelPicker.tsx'),
      resolve(__dirname, 'NotebookPreview.tsx'),
      projectFilesFacadePath,
      projectFilesPresentationOwnerPath,
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
    const editSource = readFileSync(resolve(__dirname, 'EditSessionDialog.tsx'), 'utf8')
    const deleteSource = readFileSync(resolve(__dirname, 'DeleteSessionDialog.tsx'), 'utf8')
    const notebookSource = readFileSync(resolve(__dirname, 'SessionNotebookDialog.tsx'), 'utf8')

    for (const source of [editSource, notebookSource]) {
      expect(source).toContain('dialogOverlayClassName')
      expect(source).toContain('dialogPanelClassName')
      expect(source).not.toContain('backdrop-blur')
    }
    expect(notebookSource).toContain('onInteractOutside={(event) => event.preventDefault()}')

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
    expect(workspaceMessageItemSource).toContain('<SessionMessageMarkdown')
    expect(workspaceMessageItemSource).toContain('content={assistantPresentation.content}')
    expect(workspaceMessageItemSource).toContain('useSmoothStreamingContent(')
    expect(workspaceMessageItemSource).toContain('artifacts={artifacts}')
    expect(workspaceMessageItemSource).toContain('onPreviewArtifact={onPreviewArtifact}')
    expect(workspaceMessageItemSource).toContain('onPreviewArtifactModal={onPreviewArtifactModal}')
  })

  // The transcript shares the composer's centered content track; agent replies fill that track,
  // while user bubbles stay compact and right-aligned within it.
  it('aligns the transcript width with the composer', () => {
    if (!existsSync(workspaceMessageScrollerPath)) {
      expect(existsSync(workspaceMessageScrollerPath)).toBe(true)
      return
    }

    const workspaceMessageItemSource = readFileSync(workspaceMessageItemPath, 'utf8')
    const workspaceMessageScrollerSource = readFileSync(workspaceMessageScrollerPath, 'utf8')

    expect(workspaceMessageItemSource).toContain('className="group flex flex-col items-end"')
    expect(workspaceMessageItemSource).toContain('data-slot="user-bubble-row"')
    expect(workspaceMessageItemSource).toContain('data-slot="user-message-actions"')
    expect(workspaceMessageItemSource).toContain('data-slot="user-message-footer"')
    expect(workspaceMessageItemSource).toContain(
      "'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text md:max-w-[min(85%,56rem)] md:px-4 md:py-2.5 md:text-[15px]'"
    )
    expect(workspaceMessageItemSource).toContain(
      "'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px]'"
    )
    expect(workspaceMessageScrollerSource).toContain(
      'className="mx-auto w-full max-w-4xl gap-0 px-4 pb-[56px]"'
    )
    // Rows must stay direct children of MessageScrollerContent; no transcript wrapper div.
    expect(workspaceMessageScrollerSource).not.toContain('conversationContentClassName')
  })

  it('matches the reference page chat background and transparent assistant progress', () => {
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
    expect(conversationPanelSource).toContain(
      'px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] md:px-4 md:pb-[6px]'
    )
    expect(conversationPanelSource).toContain('px-1 md:px-3')
    expect(workspaceMessageScrollerSource).toContain('bg-bg-10')
    expect(workspaceMessageScrollerSource).toContain('pb-[56px]')
    expect(workspaceMessageScrollerSource).toContain('bg-gradient-to-b from-bg-10 to-bg-10/0')
    expect(workspaceAgentLoadingRowSource).toContain(
      "cn(assistantMessageSurfaceClassName, 'px-0 py-2')"
    )
    expect(workspaceAgentLoadingRowSource).not.toContain('rounded-2xl bg-bg-200')
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

    // Common content stays width-constrained; standalone chrome is omitted by embedded callers.
    expect(permissionApprovalControlsSource).toContain(
      "'flex w-full max-w-full flex-col gap-3 bg-card"
    )
    expect(permissionApprovalControlsSource).toContain(
      "'mb-2 rounded-xl border border-border shadow-dialog"
    )
    expect(permissionApprovalControlsSource).toContain('!embedded &&')
    // Header maintains min-w-0 for text truncation
    expect(permissionApprovalControlsSource).toContain("'flex min-w-0 items-center gap-2'")
    expect(permissionApprovalControlsSource).toContain(
      "'sticky top-0 z-10 -mx-4 -mt-4 -mb-3 bg-card"
    )
    // Code block uses WorkspaceToolCodeBlock with max-height constraint
    expect(permissionApprovalControlsSource).toContain('WorkspaceToolCodeBlock')
    // Button row maintains layout constraints
    expect(permissionApprovalControlsSource).toContain(
      "'flex flex-wrap items-center justify-end gap-2'"
    )
    expect(permissionApprovalControlsSource).toContain("'sticky bottom-0 z-10 -mx-4 -mb-4 bg-card")
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
    const workspaceConversationTimelineSource = readFileSync(
      workspaceConversationTimelinePath,
      'utf8'
    )

    expect(workspaceMessageScrollerSource).toContain('createWorkspaceConversationTimeline')
    expect(workspaceConversationTimelineSource).toContain('createConversationItems')
    expect(workspaceConversationTimelineSource).toContain('groupConversationItems')
    expect(workspaceConversationTimelineSource).toContain("type: 'turn-completion'")
    expect(workspaceMessageScrollerSource).toContain('<WorkspaceActivityGroup')
    expect(workspaceMessageScrollerSource).not.toContain('createActivityDetailsDomId')
    expect(workspaceMessageScrollerSource).not.toContain('formatWebSearchDetails')
    expect(workspaceMessageScrollerSource).not.toContain('formatActivityTitle(activity)')
    expect(workspaceMessageScrollerSource).not.toContain('formatActivityDisplayTitle(activity)')
    expect(workspaceMessageScrollerSource).not.toContain('isWebSearchActivity(activity)')
    expect(workspaceMessageScrollerSource).not.toContain('createActivityToggleLabel(')
    expect(workspaceMessageScrollerSource).not.toContain('renderWebSearchDetails(')
    expect(workspaceMessageScrollerSource).not.toContain('formatActivityDetails(activity)')
    expect(workspaceMessageScrollerSource).toContain(
      'transcriptWindow.entries.map(({ item, itemIndex })'
    )
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
    expect(existsSync(workspaceArtifactVisibilityPath)).toBe(true)
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

    expect(workspaceMessageScrollerSource).toContain('WorkspaceAssistantTurnCompletion')
    expect(workspaceMessageScrollerSource).toContain('WorkspaceMessageItem')
    expect(workspaceMessageScrollerSource).toContain("from './WorkspaceArtifactVisibility'")
    expect(workspaceMessageScrollerSource).not.toContain('projectRootArtifactVisibility')
    expect(workspaceMessageScrollerSource).not.toContain('resolveVersionDescriptors')
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
    expect(workspaceActivityGroupSource).toMatch(
      /formatActivityGroupPresentationTitle\(\s*group\.activities,\s*group\.title,\s*permission,\s*notebookRunsById,\s*t\s*\)/
    )
    expect(workspaceActivityGroupSource).toContain('getRenderableActivityEntries(group.activities)')
    expect(workspaceWebSearchActivityRowSource).toContain('const WorkspaceWebSearchActivityRow')
    expect(workspaceWebSearchActivityRowSource).toContain('<WorkspaceToolActivityRowButton')
    expect(workspaceWebSearchActivityRowSource).toContain('panelTestId="tool-search-details"')
    expect(workspaceWebSearchActivityRowSource).toContain(
      'formatResultCountLabel(details.resultCount, t)'
    )
    expect(workspaceWebSearchActivityRowSource).toContain(
      'canExpand={Boolean(details.query || details.resultCount)}'
    )
    expect(workspaceMessageItemSource).toContain('const WorkspaceMessageItem')
    expect(workspaceMessageItemSource).toContain('<SessionMessageMarkdown')
    expect(workspaceMessageItemSource).toContain('content={assistantPresentation.content}')
    expect(workspaceAgentLoadingRowSource).toContain('const WorkspaceAgentLoadingRow')
    expect(workspaceAgentLoadingRowSource).toContain('thinking')
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

    expect(workspaceActivityGroupSource).toContain('buildToolActivityDetails(activity, t)')
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
    // Code blocks reuse the shared lazy Shiki highlighter for consistent syntax colors.
    expect(workspaceToolCodeBlockSource).toContain(
      "from '@/components/streamdown/use-code-highlighter'"
    )
    expect(workspaceToolCodeBlockSource).toContain('highlighter.highlight(')
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
      "import { getAgentLoadingPhase } from './agent-loading-message'"
    )
    expect(workspaceMessageScrollerSource).toContain(
      'const agentLoadingPhase = getAgentLoadingPhase(activeSession, { credentialPending })'
    )
    expect(workspaceMessageScrollerSource).toContain('<WorkspaceAgentLoadingRow')
    expect(workspaceAgentLoadingRowSource).toContain('role="status"')
    expect(workspaceAgentLoadingRowSource).toContain('aria-live="polite"')
    expect(workspaceAgentLoadingRowSource).toContain('thinking')
    expect(workspaceMessageItemSource).toContain('isAnimating={isAssistantPresenting}')
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
    expect(conversationPanelSource).toContain('onDocChange={onValidatedDraftDocChange}')
  })
})

describe('notebook preview integration', () => {
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
      "import {\n  resolveRunErrorLine,\n  environmentLabel,\n  isProblemRunStatus,\n  kernelKindLabel,\n  kernelOriginLabel,\n  notebookRunStatusLabel,\n  resolveRunEnvironment,\n  resolveRunKernelKind\n} from './notebook-cell-utils'"
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

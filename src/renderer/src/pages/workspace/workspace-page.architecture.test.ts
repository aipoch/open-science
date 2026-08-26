import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isPropertySignature,
  isPropertyAccessExpression,
  isStringLiteralLike,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  ScriptKind,
  ScriptTarget,
  type Node
} from 'typescript'

import { describe, expect, it } from 'vitest'

const workspaceDirectory = __dirname
const repositoryRoot = resolve(workspaceDirectory, '../../../../..')
const rendererRoot = resolve(workspaceDirectory, '../..')
const manifestPath = resolve(repositoryRoot, 'scripts/ci/module-impact.json')
const architectureTestPath = 'src/renderer/src/pages/workspace/workspace-page.architecture.test.ts'
const conversationPanelPath = resolve(workspaceDirectory, 'ConversationPanel.tsx')
const ownerPaths = {
  page: resolve(workspaceDirectory, 'WorkspacePage.tsx'),
  layout: resolve(workspaceDirectory, 'workspace-panel-layout.tsx'),
  composer: resolve(workspaceDirectory, 'workspace-composer-controller.ts'),
  conversation: resolve(workspaceDirectory, 'workspace-conversation-controller.ts'),
  messageQueue: resolve(workspaceDirectory, 'workspace-message-queue-controller.ts'),
  messageQueueOwner: resolve(workspaceDirectory, 'workspace-message-queue-owner.ts'),
  branchSwitchGuard: resolve(workspaceDirectory, 'use-workspace-branch-switch-guard.ts'),
  sideChat: resolve(workspaceDirectory, 'use-side-chat-controller.ts'),
  session: resolve(workspaceDirectory, 'workspace-session-controller.ts'),
  sessionDetails: resolve(workspaceDirectory, 'workspace-session-details-controller.ts'),
  sessionAgentConfiguration: resolve(
    workspaceDirectory,
    'workspace-session-agent-configuration-controller.ts'
  )
} as const

// Private to the queue facade. Keep these out of module-impact ownerPaths so a split
// does not trip the global full-suite gate; controller and owner remain the registered boundary.
const queueInternalPaths = {
  admission: resolve(workspaceDirectory, 'workspace-message-queue-admission.ts'),
  drain: resolve(workspaceDirectory, 'workspace-message-queue-drain.ts'),
  projection: resolve(workspaceDirectory, 'workspace-message-queue-projection.ts'),
  announcement: resolve(workspaceDirectory, 'workspace-message-queue-announcement.ts')
} as const

const readSource = (path: string): string => readFileSync(path, 'utf8')
const rawLineCount = (source: string): number => source.trimEnd().split(/\r?\n/).length
const portableRelativePath = (path: string): string =>
  relative(rendererRoot, path).replaceAll('\\', '/')
const modulePath = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, '')
const productionSources = (): string[] => {
  const sources: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        ['.ts', '.tsx'].includes(extname(path)) &&
        !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
      ) {
        sources.push(path)
      }
    }
  }
  visit(rendererRoot)
  return sources.sort()
}
const importedTargets = (sourcePath: string): string[] => {
  const targets: string[] = []
  const sourceFile = createSourceFile(
    sourcePath,
    readSource(sourcePath),
    ScriptTarget.Latest,
    true,
    extname(sourcePath) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
  const visit = (node: Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text
      if (specifier.startsWith('@/')) targets.push(resolve(rendererRoot, specifier.slice(2)))
      else if (specifier.startsWith('.')) targets.push(resolve(dirname(sourcePath), specifier))
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return targets.map(modulePath)
}
const productionSourcePaths = productionSources()
const importedTargetsBySource = new Map(
  productionSourcePaths.map((path) => [path, importedTargets(path)] as const)
)
const importersOf = (targetPath: string): string[] =>
  productionSourcePaths
    .filter((path) => importedTargetsBySource.get(path)?.includes(modulePath(targetPath)) === true)
    .map(portableRelativePath)
const conversationCommandCalls = (sourcePath: string): string[] => {
  const commands = new Set([
    'sendMessage',
    'resendEditedMessage',
    'resumeInterruptedSession',
    'cancelRun',
    'deleteSession'
  ])
  const calls: string[] = []
  const sourceFile = createSourceFile(
    sourcePath,
    readSource(sourcePath),
    ScriptTarget.Latest,
    true,
    ScriptKind.TSX
  )
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      const name = isIdentifier(node.expression)
        ? node.expression.text
        : isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined
      if (name && commands.has(name)) calls.push(name)
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

const conversationPanelPropNames = (): string[] => {
  const sourceFile = createSourceFile(
    conversationPanelPath,
    readSource(conversationPanelPath),
    ScriptTarget.Latest,
    true,
    ScriptKind.TSX
  )
  const props = sourceFile.statements
    .filter(isTypeAliasDeclaration)
    .find((statement) => statement.name.text === 'ConversationPanelProps')
  if (!props || !isTypeLiteralNode(props.type)) return []
  return props.type.members
    .filter(isPropertySignature)
    .map((property) => (isIdentifier(property.name) ? property.name.text : property.name.getText()))
}

describe('workspace page architecture', () => {
  it('keeps the page and extracted owners within their completion gates', () => {
    // Session-model fallback and conversation Memory add page wiring for extracted owners.
    expect(rawLineCount(readSource(ownerPaths.page))).toBeLessThanOrEqual(1_245)
    for (const ownerPath of [
      ownerPaths.layout,
      ownerPaths.composer,
      ownerPaths.conversation,
      ownerPaths.messageQueue,
      ownerPaths.messageQueueOwner,
      queueInternalPaths.admission,
      queueInternalPaths.drain,
      queueInternalPaths.projection,
      queueInternalPaths.announcement,
      ownerPaths.branchSwitchGuard,
      ownerPaths.sideChat,
      ownerPaths.session,
      ownerPaths.sessionDetails,
      ownerPaths.sessionAgentConfiguration
    ]) {
      expect(rawLineCount(readSource(ownerPath)), basename(ownerPath)).toBeLessThanOrEqual(700)
    }
  })

  it('keeps private controller consumers explicit and bounded', () => {
    expect(importersOf(ownerPaths.composer)).toEqual([
      'pages/workspace/ConversationPanel.tsx',
      'pages/workspace/WorkspacePage.tsx',
      'pages/workspace/workspace-conversation-controller.ts',
      'pages/workspace/workspace-message-queue-owner.ts'
    ])
    expect(importersOf(ownerPaths.messageQueue)).toEqual([
      'ApplicationPresentationHost.tsx',
      'pages/workspace/ComposerMessageQueue.tsx',
      'pages/workspace/workspace-conversation-controller.ts'
    ])
    expect(importersOf(ownerPaths.messageQueueOwner)).toEqual([
      'pages/workspace/workspace-message-queue-admission.ts',
      'pages/workspace/workspace-message-queue-controller.ts',
      'pages/workspace/workspace-message-queue-drain.ts',
      'pages/workspace/workspace-message-queue-projection.ts'
    ])
    expect(importersOf(queueInternalPaths.admission)).toEqual([
      'pages/workspace/workspace-message-queue-controller.ts',
      'pages/workspace/workspace-message-queue-drain.ts',
      'pages/workspace/workspace-message-queue-projection.ts'
    ])
    expect(importersOf(queueInternalPaths.drain)).toEqual([
      'pages/workspace/workspace-message-queue-controller.ts'
    ])
    expect(importersOf(queueInternalPaths.projection)).toEqual([
      'pages/workspace/workspace-message-queue-controller.ts'
    ])
    expect(importersOf(queueInternalPaths.announcement)).toEqual([
      'pages/workspace/ComposerMessageQueue.tsx',
      'pages/workspace/workspace-message-queue-admission.ts',
      'pages/workspace/workspace-message-queue-drain.ts',
      'pages/workspace/workspace-message-queue-projection.ts'
    ])
    expect(importersOf(ownerPaths.branchSwitchGuard)).toEqual(['pages/workspace/WorkspacePage.tsx'])
    expect(importersOf(ownerPaths.session)).toEqual([
      'pages/workspace/ConversationPanel.tsx',
      'pages/workspace/WorkspacePage.tsx',
      'pages/workspace/workspace-conversation-controller.ts'
    ])
    expect(importersOf(ownerPaths.sessionAgentConfiguration)).toEqual([
      'pages/workspace/WorkspacePage.tsx'
    ])
    expect(importersOf(ownerPaths.conversation)).toEqual([
      'pages/workspace/ConversationPanel.tsx',
      'pages/workspace/WorkspacePage.tsx'
    ])
    expect(importersOf(ownerPaths.sideChat)).toEqual([
      'App.tsx',
      'hooks/useApplicationEventBindings.ts',
      'pages/workspace/ConversationPanel.tsx',
      'pages/workspace/SideChatPanel.tsx',
      'pages/workspace/WorkspacePage.tsx',
      'pages/workspace/previews/PreviewToolContent.tsx',
      'pages/workspace/workspace-conversation-controller.ts',
      'pages/workspace/workspace-message-queue-controller.ts'
    ])
  })

  it('keeps the conversation panel interface scenario-based instead of feature-shaped', () => {
    const propNames = conversationPanelPropNames()

    expect(propNames).toEqual([
      'view',
      'composer',
      'conversation',
      'sideChat',
      'specialist',
      'layout',
      'permissions',
      'elicitation',
      'agentControls',
      'contextWindow',
      'workflows',
      'sessionTools',
      'subagents'
    ])
    expect(propNames).toHaveLength(13)
    expect(propNames.some((name) => name.startsWith('on'))).toBe(false)
  })

  it('keeps conversation command calls out of the page and behind injected ports', () => {
    const pageSource = readSource(ownerPaths.page)
    const conversationSource = readSource(ownerPaths.conversation)
    const panelSource = readSource(conversationPanelPath)

    expect(conversationCommandCalls(ownerPaths.page)).toEqual([])
    expect(pageSource).toContain('conversation={conversation}')
    expect(pageSource).toContain('conversation.actions.submit.restoredPlan')
    expect(pageSource).toContain('conversation.actions.delete')
    expect(pageSource).not.toContain('conversation.actions.submit.draft')
    expect(pageSource).not.toContain('conversation.actions.revise')
    expect(pageSource).not.toContain('conversation.actions.resume')
    expect(pageSource).not.toContain('conversation.actions.cancel')
    expect(panelSource).toContain('draft: submitDraft')
    expect(panelSource).toContain('revise: onSendEditedMessage')
    expect(panelSource).toContain('resume: onResumeSession')
    expect(panelSource).toContain('cancel: onCancelRun')
    for (const directOwner of [
      'window.api',
      'useSessionStore',
      'useReviewStore',
      'useSettingsStore',
      'useSpecialistStore'
    ]) {
      expect(conversationSource).not.toContain(directOwner)
    }
    for (const intent of ['submit:', 'revise:', 'resume:', 'cancel:', 'delete:']) {
      expect(conversationSource).toContain(intent)
    }
  })

  it('routes desktop and mobile Session deletion through one controller and dialog', () => {
    const pageSource = readSource(ownerPaths.page)

    expect(pageSource.match(/sessionController\.actions\.openDelete/g)).toHaveLength(2)
    expect(pageSource.match(/<DeleteSessionDialog/g)).toHaveLength(1)
    expect(pageSource).toContain(
      'error={sessionController.view.dialogs.delete?.error ?? undefined}'
    )
    expect(pageSource).toContain('onConfirmDelete={conversation.actions.delete}')
  })

  it('forwards archived Session deletion progress to the shared dialog', () => {
    const archivedPanelSource = readSource(
      resolve(rendererRoot, 'pages/settings/ArchivedPanel.tsx')
    )

    expect(archivedPanelSource).toContain(
      'isDeleting={busyKey === `session:${sessionToDelete?.id}`}'
    )
  })

  it('keeps Workspace runtime internals behind the public renderer facade', () => {
    const workspaceSources = productionSourcePaths
      .filter((path) => !relative(workspaceDirectory, path).startsWith('..'))
      .map(readSource)
      .join('\n')
    const pageSource = readSource(ownerPaths.page)
    const conversationSource = readSource(ownerPaths.conversation)

    expect(pageSource).toContain("from '@/lib/acp/useWorkspaceAgentRuntime'")
    expect(pageSource).toContain('const runtime = useWorkspaceAgentRuntime()')
    expect(conversationSource).toContain(
      "import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'"
    )
    expect(workspaceSources).not.toMatch(
      /from ['"][^'"]*workspace-runtime-(?:event|prompt|command|session)/
    )
  })

  it('registers the complete owner boundary and this certification test', () => {
    const manifest = JSON.parse(readSource(manifestPath)) as {
      modules: { workspace_page: { ownerPaths: string[]; testFiles: { owner: string[] } } }
    }
    const workspacePage = manifest.modules.workspace_page

    for (const ownerPath of Object.values(ownerPaths)) {
      expect(workspacePage.ownerPaths).toContain(
        relative(repositoryRoot, ownerPath).replaceAll('\\', '/')
      )
    }
    expect(workspacePage.testFiles.owner).toContain(architectureTestPath)
  })
})

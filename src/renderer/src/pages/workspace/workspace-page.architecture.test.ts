import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isPropertyAccessExpression,
  isStringLiteralLike,
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
const ownerPaths = {
  page: resolve(workspaceDirectory, 'WorkspacePage.tsx'),
  layout: resolve(workspaceDirectory, 'workspace-panel-layout.tsx'),
  composer: resolve(workspaceDirectory, 'workspace-composer-controller.ts'),
  conversation: resolve(workspaceDirectory, 'workspace-conversation-controller.ts'),
  sideChat: resolve(workspaceDirectory, 'use-side-chat-controller.ts'),
  session: resolve(workspaceDirectory, 'workspace-session-controller.ts')
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
    'deleteRuntimeSession'
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

describe('workspace page architecture', () => {
  it('keeps the page and extracted owners within their completion gates', () => {
    expect(rawLineCount(readSource(ownerPaths.page))).toBeLessThanOrEqual(1_200)
    for (const ownerPath of [
      ownerPaths.layout,
      ownerPaths.composer,
      ownerPaths.conversation,
      ownerPaths.sideChat,
      ownerPaths.session
    ]) {
      expect(rawLineCount(readSource(ownerPath)), basename(ownerPath)).toBeLessThanOrEqual(660)
    }
  })

  it('keeps private controller consumers explicit and bounded', () => {
    expect(importersOf(ownerPaths.composer)).toEqual([
      'pages/workspace/WorkspacePage.tsx',
      'pages/workspace/workspace-conversation-controller.ts'
    ])
    expect(importersOf(ownerPaths.session)).toEqual([
      'pages/workspace/WorkspacePage.tsx',
      'pages/workspace/workspace-conversation-controller.ts'
    ])
    expect(importersOf(ownerPaths.conversation)).toEqual(['pages/workspace/WorkspacePage.tsx'])
    expect(importersOf(ownerPaths.sideChat)).toEqual([
      'App.tsx',
      'pages/workspace/ConversationPanel.tsx',
      'pages/workspace/SideChatPanel.tsx',
      'pages/workspace/WorkspacePage.tsx',
      'pages/workspace/previews/PreviewToolContent.tsx',
      'pages/workspace/workspace-conversation-controller.ts'
    ])
  })

  it('keeps conversation command calls out of the page and behind injected ports', () => {
    const pageSource = readSource(ownerPaths.page)
    const conversationSource = readSource(ownerPaths.conversation)

    expect(conversationCommandCalls(ownerPaths.page)).toEqual([])
    expect(pageSource).toContain('conversation.actions.submit.draft')
    expect(pageSource).toContain('conversation.actions.submit.restoredPlan')
    expect(pageSource).toContain('conversation.actions.revise')
    expect(pageSource).toContain('conversation.actions.resume')
    expect(pageSource).toContain('conversation.actions.cancel')
    expect(pageSource).toContain('conversation.actions.delete')
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

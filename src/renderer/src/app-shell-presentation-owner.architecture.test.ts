import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import {
  createSourceFile,
  forEachChild,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  type Node
} from 'typescript'
import { describe, expect, it } from 'vitest'

const rendererRoot = __dirname
const appPath = resolve(rendererRoot, 'App.tsx')
const ownerPath = resolve(rendererRoot, 'app-shell-presentation-owner.ts')
const readSource = (path: string): string => readFileSync(path, 'utf8')
const modulePath = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, '')

const productionSources = (): readonly string[] => {
  const paths: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.[cm]?tsx?$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)) {
        paths.push(path)
      }
    }
  }
  visit(rendererRoot)
  return paths.sort()
}

const importsTarget = (sourcePath: string, targetPath: string): boolean => {
  let importsOwner = false
  const sourceFile = createSourceFile(
    sourcePath,
    readSource(sourcePath),
    ScriptTarget.Latest,
    true,
    extname(sourcePath) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const resolved = specifier.startsWith('@/')
        ? resolve(rendererRoot, specifier.slice(2))
        : specifier.startsWith('.')
          ? resolve(dirname(sourcePath), specifier)
          : undefined
      if (resolved && modulePath(resolved) === modulePath(targetPath)) importsOwner = true
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return importsOwner
}

const rootGateIdentifiers = new Set([
  'hasComputeApproval',
  'hasConnectorApproval',
  'hasSkillImportApproval',
  'isCloseConfirmOpen',
  'isGlobalSearchOpen',
  'isPreviewModalOpen',
  'isSettingsOpen',
  'isUpdateDialogOpen',
  'legacyMove',
  'missingDataRoot'
])

const repeatedRootGateLists = (source: string): readonly string[] => {
  const sourceFile = createSourceFile(appPath, source, ScriptTarget.Latest, true, ScriptKind.TSX)
  const violations = new Set<string>()
  const insideOwnerProjection = (node: Node): boolean => {
    for (let current: Node | undefined = node; current; current = current.parent) {
      if (
        isCallExpression(current) &&
        isIdentifier(current.expression) &&
        current.expression.text === 'resolveAppShellPresentation'
      ) {
        return true
      }
    }
    return false
  }
  const identifiersWithin = (node: Node): readonly string[] => {
    const identifiers = new Set<string>()
    const collect = (candidate: Node): void => {
      if (isIdentifier(candidate) && rootGateIdentifiers.has(candidate.text)) {
        identifiers.add(candidate.text)
      }
      forEachChild(candidate, collect)
    }
    collect(node)
    return [...identifiers].sort()
  }
  const visit = (node: Node): void => {
    if (isBinaryExpression(node) && !insideOwnerProjection(node)) {
      const identifiers = identifiersWithin(node)
      if (identifiers.length > 1) violations.add(identifiers.join(','))
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return [...violations].sort()
}

describe('App Shell presentation owner architecture', () => {
  it('keeps the root App as the only production composition consumer', () => {
    const importers = productionSources()
      .filter((path) => importsTarget(path, ownerPath))
      .map((path) => relative(rendererRoot, path).replaceAll('\\', '/'))

    expect(importers).toEqual(['App.tsx'])
  })

  it('routes visibility, root shortcuts, and close commands through the owner projection', () => {
    const appSource = readSource(appPath)

    expect(appSource.match(/resolveAppShellPresentation\(/g)).toHaveLength(1)
    expect(appSource).toContain(
      'isSessionContentVisible: appShellPresentation.isSessionContentVisible'
    )
    expect(appSource).toContain("!appShellPresentation.allowsShortcut('settings')")
    expect(appSource).toContain("!appShellPresentation.allowsShortcut('globalSearch')")
    expect(appSource).toContain("appShellPresentation.allowsShortcut('archiveUndo')")
    expect(appSource).toContain('const action = appShellPresentation.resolveCloseAction()')
    expect(appSource).not.toContain('STREAMDOWN_FULLSCREEN_SELECTOR')
    expect(appSource).not.toContain('document.querySelector')
    expect(repeatedRootGateLists(appSource)).toEqual([])
  })

  it('rejects a recreated multi-store gate list outside the owner projection', () => {
    expect(
      repeatedRootGateLists('const eligible = !isSettingsOpen && !hasComputeApproval')
    ).toEqual(['hasComputeApproval,isSettingsOpen'])
  })
})

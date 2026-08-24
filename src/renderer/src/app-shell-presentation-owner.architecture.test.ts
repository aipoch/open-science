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
const hostPath = resolve(rendererRoot, 'ApplicationPresentationHost.tsx')
const eventBindingsPath = resolve(rendererRoot, 'hooks/useApplicationEventBindings.ts')
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
  'hasLegacyDataMove',
  'hasDataRootRecovery'
])

const repeatedRootGateLists = (sourcePath: string, source: string): readonly string[] => {
  const sourceFile = createSourceFile(
    sourcePath,
    source,
    ScriptTarget.Latest,
    true,
    extname(sourcePath) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
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
  it('keeps application event bindings as the only production composition consumer', () => {
    const importers = productionSources()
      .filter((path) => importsTarget(path, ownerPath))
      .map((path) => relative(rendererRoot, path).replaceAll('\\', '/'))

    expect(importers).toEqual(['hooks/useApplicationEventBindings.ts'])
  })

  it('keeps application orchestration out of the App facade and presentation host', () => {
    const appSource = readSource(appPath)
    const hostSource = readSource(hostPath)

    expect(appSource).toContain('<ApplicationPresentationHost />')
    expect(appSource).not.toContain('useEffect')
    expect(appSource).not.toContain('@/stores/')
    expect(hostSource).toContain('useApplicationStartup()')
    expect(hostSource).toContain('useApplicationEventBindings({')
    expect(hostSource).not.toContain('useEffect')
    expect(hostSource).not.toContain('@/stores/')
  })

  it('routes visibility, root shortcuts, and close commands through the owner projection', () => {
    const bindingsSource = readSource(eventBindingsPath)

    expect(bindingsSource.match(/resolveAppShellPresentation\(/g)).toHaveLength(1)
    expect(bindingsSource).toContain(
      'isSessionContentVisible: presentation.isSessionContentVisible'
    )
    expect(bindingsSource).toContain("!presentation.allowsShortcut('settings')")
    expect(bindingsSource).toContain("!presentation.allowsShortcut('globalSearch')")
    expect(bindingsSource).toContain("presentation.allowsShortcut('archiveUndo')")
    expect(bindingsSource).toContain('const action = presentation.resolveCloseAction()')
    expect(bindingsSource).not.toContain('STREAMDOWN_FULLSCREEN_SELECTOR')
    expect(bindingsSource).not.toContain('document.querySelector')
    expect(repeatedRootGateLists(eventBindingsPath, bindingsSource)).toEqual([])
  })

  it('rejects a recreated multi-store gate list outside the owner projection', () => {
    expect(
      repeatedRootGateLists(
        eventBindingsPath,
        'const eligible = !isSettingsOpen && !hasComputeApproval'
      )
    ).toEqual(['hasComputeApproval,isSettingsOpen'])
  })
})

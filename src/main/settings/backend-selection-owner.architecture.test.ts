import { extname, relative, resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  getModifiers,
  isClassDeclaration,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedExports,
  isPropertyDeclaration,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  listProductionSources,
  readProductionSource
} from '../../../test/architecture-source-index'

const projectRoot = resolve(__dirname, '../../..')
const ownerPath = resolve(__dirname, 'backend-selection-owner.ts')
const manifestPath = resolve(projectRoot, 'scripts/ci/module-impact.json')
const readSource = (path: string): string => readProductionSource(path, projectRoot)
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(
    path,
    readSource(path),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
const portablePath = (path: string): string => relative(projectRoot, path).replaceAll('\\', '/')

const productionSources = (): readonly string[] => listProductionSources(projectRoot)

const importsOwner = (path: string): boolean => {
  let imports = false
  const sourceFile = sourceFileFor(path)
  const visit = (node: Node): void => {
    if (
      isImportDeclaration(node) &&
      node.moduleSpecifier.getText(sourceFile).includes('backend-selection-owner')
    ) {
      imports = true
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return imports
}

const publicOperations = (): string[] => {
  const declaration = sourceFileFor(ownerPath).statements.find(
    (statement) => isClassDeclaration(statement) && statement.name?.text === 'BackendSelectionOwner'
  )
  if (!declaration || !isClassDeclaration(declaration)) throw new Error('owner class not found')
  return declaration.members
    .flatMap((member) => {
      const hidden =
        canHaveModifiers(member) &&
        getModifiers(member)?.some((modifier) => modifier.kind === SyntaxKind.PrivateKeyword)
      return !hidden &&
        (isMethodDeclaration(member) || isPropertyDeclaration(member)) &&
        isIdentifier(member.name)
        ? [member.name.text]
        : []
    })
    .sort()
}

describe('Backend selection ownership', () => {
  it('keeps pure selection policy below the production hard limit', () => {
    const source = readSource(ownerPath)
    expect(source.split(/\r?\n/).length - Number(source.endsWith('\n'))).toBeLessThanOrEqual(660)
    expect(source).not.toMatch(
      /ResponsesBridge|NativeResponses|create.*Bridge|start\(|close\(|keyRef|credential|lease|generation|orchestration/i
    )
  })

  it('locks the owner interface and compatibility exports', () => {
    expect(publicOperations()).toEqual([
      'captureConfiguredSelection',
      'captureExplicitTarget',
      'resolveActiveModelChangeSelection',
      'resolveActiveReasoningEffort',
      'resolveActiveSelection',
      'resolveExplicitTarget',
      'resolveSelection'
    ])

    const exportDeclaration = sourceFileFor(ownerPath).statements.filter(isExportDeclaration)
    expect(
      exportDeclaration.flatMap((statement) =>
        statement.exportClause && isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.map(
              (element) =>
                `${statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${element.name.text}`
            )
          : []
      )
    ).toEqual([
      'value:BackendSelectionOwner',
      'type:AgentBackendSelection',
      'type:BackendSelectionResolution',
      'type:BackendSelectionOwnerOptions',
      'type:ExplicitAgentBackendTarget'
    ])
  })

  it('keeps the owner internal to the resolver and inside dependency-aware impact routing', () => {
    expect(productionSources().filter(importsOwner).map(portablePath)).toEqual([
      'src/main/settings/backend-resolver.ts'
    ])
    const manifest = JSON.parse(readSource(manifestPath)) as {
      modules: Record<string, { ownerPaths: string[]; testFiles: { owner: string[] } }>
    }
    expect(manifest.modules.settings_backend_resolution.ownerPaths).toContain(
      'src/main/settings/backend-selection-owner.ts'
    )
    expect(manifest.modules.settings_backend_resolution.testFiles.owner).toEqual(
      expect.arrayContaining([
        'src/main/settings/backend-selection-owner.test.ts',
        'src/main/settings/backend-selection-owner.architecture.test.ts'
      ])
    )
  })
})

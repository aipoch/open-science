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
const plannerPath = resolve(__dirname, 'backend-route-planner.ts')
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

const importsPlanner = (path: string): boolean => {
  let imports = false
  const sourceFile = sourceFileFor(path)
  const visit = (node: Node): void => {
    if (
      isImportDeclaration(node) &&
      node.moduleSpecifier.getText(sourceFile).includes('backend-route-planner')
    ) {
      imports = true
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return imports
}

const publicOperations = (): string[] => {
  const declaration = sourceFileFor(plannerPath).statements.find(
    (statement) => isClassDeclaration(statement) && statement.name?.text === 'BackendRoutePlanner'
  )
  if (!declaration || !isClassDeclaration(declaration)) throw new Error('planner class not found')
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

describe('Backend route planning ownership', () => {
  it('keeps the pure planner within forecast and free of live resource ownership', () => {
    const source = readSource(plannerPath)
    const lines = source.split(/\r?\n/).length - Number(source.endsWith('\n'))
    expect(lines).toBeLessThanOrEqual(500)
    expect(lines).toBeLessThanOrEqual(660)
    expect(source).not.toMatch(
      /new\s+(?:ResponsesBridge|NativeResponsesCompatibilityProxy|AnthropicProviderBridge|OpenAiProviderBridge)|\.start\(|\.close\(|\blease\b|nextGenerationId|randomUUID|new\s+Map|responsesBridges|nativeResponsesCompatibilityProxies/
    )
    expect(source).not.toMatch(/console\.|JSON\.stringify\([^\n]*(?:key|token|credential)/i)
  })

  it('locks the planner to two deep operations and an internal export inventory', () => {
    expect(publicOperations()).toEqual(['planBackend', 'projectModelChange'])
    const exports = sourceFileFor(plannerPath).statements.filter(isExportDeclaration)
    expect(
      exports.flatMap((statement) =>
        statement.exportClause && isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.map(
              (element) =>
                `${statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${element.name.text}`
            )
          : []
      )
    ).toEqual([
      'value:BackendRoutePlanner',
      'type:BackendRoutePlan',
      'type:BackendRouteProviderPort',
      'type:BackendTransportPlan'
    ])
  })

  it('keeps the planner behind the resolver and inside dependency-aware impact routing', () => {
    expect(productionSources().filter(importsPlanner).map(portablePath)).toEqual([
      'src/main/settings/backend-resolver.ts',
      'src/main/settings/provider-transport-owner.ts'
    ])
    const manifest = JSON.parse(readSource(manifestPath)) as {
      modules: Record<string, { ownerPaths: string[]; testFiles: { owner: string[] } }>
    }
    const module = manifest.modules.settings_backend_resolution
    expect(module.ownerPaths).toContain('src/main/settings/backend-route-planner.ts')
    expect(module.testFiles.owner).toEqual(
      expect.arrayContaining([
        'src/main/settings/backend-route-planner.test.ts',
        'src/main/settings/backend-route-planner.architecture.test.ts'
      ])
    )
  })
})

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
const ownerPath = resolve(__dirname, 'provider-transport-owner.ts')
const resolverPath = resolve(__dirname, 'backend-resolver.ts')
const readSource = (path: string): string => readProductionSource(path, projectRoot)
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(
    path,
    readSource(path),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )

const productionSources = (): readonly string[] => listProductionSources(projectRoot)

const importsOwner = (path: string): boolean => {
  let imports = false
  const sourceFile = sourceFileFor(path)
  const visit = (node: Node): void => {
    if (
      isImportDeclaration(node) &&
      node.moduleSpecifier.getText(sourceFile).includes('provider-transport-owner')
    ) {
      imports = true
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return imports
}

describe('Provider transport ownership', () => {
  it('keeps one deep acquire seam behind the transport owner', () => {
    const source = readSource(ownerPath)
    expect(source).not.toMatch(/console\.|JSON\.stringify\([^\n]*(?:key|token|credential)/i)

    const declaration = sourceFileFor(ownerPath).statements.find(
      (statement) =>
        isClassDeclaration(statement) && statement.name?.text === 'ProviderTransportOwner'
    )
    if (!declaration || !isClassDeclaration(declaration)) throw new Error('owner class not found')
    const operations = declaration.members.flatMap((member) => {
      const hidden =
        canHaveModifiers(member) &&
        getModifiers(member)?.some((modifier) => modifier.kind === SyntaxKind.PrivateKeyword)
      return !hidden &&
        (isMethodDeclaration(member) || isPropertyDeclaration(member)) &&
        isIdentifier(member.name)
        ? [member.name.text]
        : []
    })
    expect(operations).toEqual(['acquire'])

    const exports = sourceFileFor(ownerPath).statements.filter(isExportDeclaration)
    expect(
      exports.flatMap((statement) =>
        statement.exportClause && isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.map(
              (element) =>
                `${statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${element.name.text}`
            )
          : []
      )
    ).toEqual(['value:ProviderTransportOwner', 'type:ProviderTransportOwnerOptions'])
  })

  it('keeps live generations behind the stable resolver facade', () => {
    expect(
      productionSources()
        .filter(importsOwner)
        .map((path) => relative(projectRoot, path).replaceAll('\\', '/'))
    ).toEqual(['src/main/settings/backend-resolver.ts'])

    const resolver = readSource(resolverPath)
    expect(resolver).not.toMatch(
      /responsesBridges|nativeResponsesCompatibilityProxies|nextGenerationId|createResponsesBridge|createNativeResponsesProxy|createAnthropicProviderBridge|createOpenAiProviderBridge/
    )
    expect(resolver).not.toMatch(/new\s+(?:ResponsesBridge|NativeResponsesCompatibilityProxy)/)
  })
})

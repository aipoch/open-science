import { basename, dirname, extname, relative, resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isNamedExports,
  isStringLiteralLike,
  isTypeAliasDeclaration,
  isVariableStatement,
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
const adapterPath = resolve(__dirname, 'responses-response-adapter.ts')
const bridgePath = resolve(__dirname, 'responses-bridge.ts')
const hostPath = resolve(__dirname, 'provider-loopback-http-host.ts')
const readSource = (path: string): string => readProductionSource(path, projectRoot)
const modulePath = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, '')
const portableProjectPath = (path: string): string =>
  relative(projectRoot, path).replaceAll('\\', '/')
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(
    path,
    readSource(path),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )

const productionSources = (): readonly string[] => listProductionSources(projectRoot)

const importSpecifiersFrom = (sourcePath: string): string[] => {
  const specifiers: string[] = []
  const visit = (node: Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (isImportTypeNode(node)) {
      if (isLiteralTypeNode(node.argument) && isStringLiteralLike(node.argument.literal)) {
        specifiers.push(node.argument.literal.text)
      }
    } else if (isCallExpression(node)) {
      const [argument] = node.arguments
      const requireCall = isIdentifier(node.expression) && node.expression.text === 'require'
      const dynamicImport = node.expression.kind === SyntaxKind.ImportKeyword
      if ((requireCall || dynamicImport) && argument && isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(sourcePath))
  return specifiers
}

const importersOf = (targetPath: string): string[] =>
  productionSources()
    .filter((sourcePath) => readSource(sourcePath).includes(basename(modulePath(targetPath))))
    .filter((sourcePath) =>
      importSpecifiersFrom(sourcePath).some(
        (specifier) =>
          specifier.startsWith('.') &&
          modulePath(resolve(dirname(sourcePath), specifier)) === modulePath(targetPath)
      )
    )
    .map(portableProjectPath)

const exportInventoryFrom = (path: string): string[] => {
  const names: string[] = []
  for (const statement of sourceFileFor(path).statements) {
    if (isExportDeclaration(statement) && statement.exportClause) {
      if (isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.push(
            `${statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${element.name.text}`
          )
        }
      }
      continue
    }
    const exported =
      canHaveModifiers(statement) &&
      getModifiers(statement)?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) {
      names.push(`type:${statement.name.text}`)
    } else if (
      isClassDeclaration(statement) ||
      isEnumDeclaration(statement) ||
      isFunctionDeclaration(statement)
    ) {
      names.push(`value:${statement.name?.text ?? '<anonymous>'}`)
    } else if (isVariableStatement(statement)) {
      names.push(
        ...statement.declarationList.declarations.flatMap((declaration) =>
          isIdentifier(declaration.name) ? [`value:${declaration.name.text}`] : []
        )
      )
    }
  }
  return names.sort()
}

describe('Responses result adapter ownership', () => {
  it('keeps exact adapter and facade interfaces', () => {
    expect(exportInventoryFrom(adapterPath)).toEqual([
      'type:ResponsesStreamWriter',
      'value:ResponsesProtocolError',
      'value:completionToResponse',
      'value:streamChatToResponses',
      'value:upstreamErrorMessage'
    ])
    expect(importersOf(adapterPath)).toEqual(['src/main/settings/responses-bridge.ts'])
  })

  it('keeps result/SSE projection out of HTTP and trusted-session lifecycle', () => {
    const adapter = readSource(adapterPath)
    const bridge = readSource(bridgePath)
    const host = readSource(hostPath)

    expect(adapter).not.toMatch(/from ['"]node:(?:http|net)['"]/)
    expect(adapter).not.toContain('createServer(')
    expect(adapter).not.toContain('authorization')
    expect(adapter).not.toMatch(/reviewerSessionKeys|toolLessSessionKeys|selectSkills\(/)
    expect(adapter).toContain('terminalFinishReason')
    expect(adapter).toContain('response.function_call_arguments.delta')
    expect(bridge).not.toMatch(/const (?:responseEnvelope|writeEvent|chatUsageToResponsesUsage)/)
    expect(bridge).not.toContain('createServer(')
    expect(bridge).toContain('new ProviderLoopbackHttpHost')
    expect(host).toContain('createServer(')
    expect(bridge).toContain('reviewerSessionKeys')
    expect(bridge).toContain('selectSkills(')
  })
})

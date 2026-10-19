import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  getModifiers,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isNamedExports,
  isTypeAliasDeclaration,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

const adapterPath = resolve(__dirname, 'request.ts')
const readSource = (path: string): string => readFileSync(path, 'utf8')
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(path, readSource(path), ScriptTarget.Latest, true, ScriptKind.TS)
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

describe('Responses request adapter ownership', () => {
  it('keeps a small, exact conversion interface', () => {
    expect(exportInventoryFrom(adapterPath)).toEqual([
      'type:ResponsesRequestAdapterOptions',
      'value:inputToMessages',
      'value:responsesToChatCompletionsRequest',
      'value:toolsToChat'
    ])
  })

  it('excludes response projection and HTTP/session lifecycle', () => {
    const adapter = readSource(adapterPath)

    expect(adapter).not.toMatch(/from ['"]node:(?:crypto|http|net)['"]/)
    expect(adapter).not.toContain('fetch(')
    expect(adapter).not.toMatch(/completionToResponse|streamChatToResponses|responseEnvelope/)
  })
})

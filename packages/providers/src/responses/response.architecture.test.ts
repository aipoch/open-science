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

const adapterPath = resolve(__dirname, 'adapter.ts')
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

describe('Responses result adapter ownership', () => {
  it('keeps exact adapter and facade interfaces', () => {
    expect(exportInventoryFrom(adapterPath)).toEqual([
      'type:ResponsesAdapter',
      'type:ResponsesAdapterOptions',
      'type:ResponsesTurn',
      'type:ResponsesTurnInput',
      'value:convertResponsesRequest',
      'value:createResponsesAdapter'
    ])
    expect(exportInventoryFrom(resolve(__dirname, '../protocol.ts'))).not.toContain(
      'type:ResponsesStreamWriter'
    )
  })

  it('keeps result/SSE projection out of HTTP and trusted-session lifecycle', () => {
    const adapter = ['response.ts', 'stream-state.ts', 'stream.ts']
      .map((file) => readSource(resolve(__dirname, file)))
      .join('\n')

    expect(adapter).not.toMatch(/from ['"]node:(?:http|net)['"]/)
    expect(adapter).not.toContain('createServer(')
    expect(adapter).not.toContain('authorization')
    expect(adapter).not.toMatch(/reviewerSessionKeys|toolLessSessionKeys|selectSkills\(/)
    expect(adapter).toContain('terminalFinishReason')
    expect(adapter).toContain('response.function_call_arguments.delta')
  })
})

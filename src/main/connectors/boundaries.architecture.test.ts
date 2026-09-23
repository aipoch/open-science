import { dirname, relative, resolve, sep } from 'node:path'
import {
  createSourceFile,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
  ScriptTarget
} from 'typescript'
import { expect, it } from 'vitest'
import {
  listProductionSources,
  readProductionSource
} from '../../../test/architecture-source-index'

it('keeps Custom MCP implementation imports behind its facade and pure URL admission entry', () => {
  const root = resolve(__dirname, '../../..')
  const moduleRoot = resolve(__dirname, 'custom-mcp')
  const violations: string[] = []
  for (const file of listProductionSources(root)) {
    if (file.startsWith(moduleRoot + sep)) continue
    const source = readProductionSource(file, root)
    if (!source.includes('custom-mcp/')) continue
    const parsed = createSourceFile(file, source, ScriptTarget.Latest)
    for (const statement of parsed.statements) {
      if (!(isImportDeclaration(statement) || isExportDeclaration(statement))) continue
      const specifier = statement.moduleSpecifier
      if (!specifier || !isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue
      const target = resolve(dirname(file), specifier.text)
      if (
        target.startsWith(moduleRoot + sep) &&
        !/^(?:index|url)(?:\.ts)?$/.test(relative(moduleRoot, target))
      ) {
        violations.push(`${relative(root, file)} -> ${specifier.text}`)
      }
    }
  }
  expect(violations).toEqual([])
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('injects host network policy into the package text client at the composition root', () => {
  const file = resolve(__dirname, 'document-reading.ts')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const constructions: ts.NewExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === 'ProviderTextGenerationService'
    )
      constructions.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(constructions).toHaveLength(1)
  expect(constructions[0].arguments?.map((argument) => argument.getText(source))).toEqual([
    'netFetchStandard'
  ])
  const imports = source.statements.filter(ts.isImportDeclaration)
  expect(
    imports.some(
      (statement) =>
        statement.moduleSpecifier.getText(source) === "'../network-fetch'" &&
        statement.importClause?.getText(source).includes('netFetchStandard')
    )
  ).toBe(true)
  expect(
    imports.some(
      (statement) =>
        statement.moduleSpecifier.getText(source) ===
          "'../literature/pdf-translation/text-generation'" &&
        statement.importClause?.getText(source).includes('ProviderTextGenerationService')
    )
  ).toBe(true)
})

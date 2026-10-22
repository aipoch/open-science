import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isStringLiteralLike,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node
} from 'typescript'
import { expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../../..')
const sourceRoots = ['src', 'packages'].map((root) => resolve(projectRoot, root))
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts'] as const

const productionSources = (): string[] => {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        sourceExtensions.includes(extname(path) as (typeof sourceExtensions)[number]) &&
        !/\.(?:test|spec)(?:-support|-harness)?\.[cm]?tsx?$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(path)
      }
    }
  }
  for (const root of sourceRoots) if (existsSync(root)) visit(root)
  return files.sort()
}

// Mirrors the runtime-binding check in runtime-import-cycle.architecture.test.ts: a type-only
// import or export cannot execute the referenced module, so it is not a dependency edge here.
const runtimeImportSpecifiers = (path: string): string[] => {
  const specifiers: string[] = []
  const sourceFile = createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )
  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause
      const hasRuntimeBinding =
        clause === undefined ||
        (!clause.isTypeOnly &&
          (clause.name !== undefined ||
            clause.namedBindings === undefined ||
            !('elements' in clause.namedBindings) ||
            clause.namedBindings.elements.some((element) => !element.isTypeOnly)))
      if (hasRuntimeBinding) specifiers.push(node.moduleSpecifier.text)
    } else if (
      isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier) &&
      !node.isTypeOnly &&
      (!node.exportClause ||
        !('elements' in node.exportClause) ||
        node.exportClause.elements.some((element) => !element.isTypeOnly))
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (isCallExpression(node)) {
      const [argument] = node.arguments
      const isRequire = isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword
      if ((isRequire || isDynamicImport) && argument && isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

const resolveRelativeImport = (source: string, specifier: string): string | undefined => {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(source), specifier.replace(/\.[cm]?js$/, ''))
  const candidates = [
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => resolve(base, `index${extension}`))
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

it('keeps annotation storage and native parsing behind the supported entries', () => {
  const sources = productionSources()
  const privateFiles = new Set(
    ['document-store.ts', 'sharing.ts'].map((name) =>
      resolve(projectRoot, 'src/main/pdf-annotations', name)
    )
  )
  const pdfAnnotationsDirectory = resolve(projectRoot, 'src/main/pdf-annotations')
  const nativeParserCore = resolve(pdfAnnotationsDirectory, 'native-import-core.ts')
  const nativeParserConsumers = new Set(
    ['native-import.ts', 'native-import-worker-entry.ts'].map((name) =>
      resolve(pdfAnnotationsDirectory, name)
    )
  )
  const violations: string[] = []
  for (const source of sources) {
    for (const specifier of runtimeImportSpecifiers(source)) {
      const target = resolveRelativeImport(source, specifier)
      if (target === undefined) continue
      if (
        (privateFiles.has(target) && !source.startsWith(pdfAnnotationsDirectory)) ||
        (target === nativeParserCore && !nativeParserConsumers.has(source))
      ) {
        violations.push(`${relative(projectRoot, source)} -> ${relative(projectRoot, target)}`)
      }
    }
  }
  expect(violations.sort()).toEqual([])
})

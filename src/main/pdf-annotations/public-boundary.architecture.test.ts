import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'

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
const pdfAnnotationsDirectory = resolve(projectRoot, 'src/main/pdf-annotations')
const privateFiles = new Set(
  ['document-store.ts', 'sharing.ts'].map((name) => resolve(pdfAnnotationsDirectory, name))
)
const nativeParserCore = resolve(pdfAnnotationsDirectory, 'native-import-core.ts')
const protectedModuleNames = [...privateFiles, nativeParserCore].map((path) =>
  basename(path, '.ts')
)
const nativeParserConsumers = new Set(
  ['native-import.ts', 'native-import-worker-entry.ts'].map((name) =>
    resolve(pdfAnnotationsDirectory, name)
  )
)

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
const runtimeImportSpecifiers = (path: string, source: string): string[] => {
  const specifiers: string[] = []
  const sourceFile = createSourceFile(
    path,
    source,
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

const boundaryViolations = (source: string, text: string): string[] => {
  // Each protected target is a named .ts file, so resolving a relative specifier to it
  // requires its basename in the source path or text. Escapes can hide that text: keep the AST path
  // for every file containing a backslash. This deliberately admits false positives.
  // preProcessFile alone misses namespace exports and require() in template expressions.
  if (
    !text.includes('\\') &&
    !protectedModuleNames.some((name) => source.includes(name) || text.includes(name))
  )
    return []
  const violations: string[] = []
  for (const specifier of runtimeImportSpecifiers(source, text)) {
    const target = resolveRelativeImport(source, specifier)
    if (target === undefined) continue
    if (
      (privateFiles.has(target) && !source.startsWith(pdfAnnotationsDirectory)) ||
      (target === nativeParserCore && !nativeParserConsumers.has(source))
    ) {
      violations.push(`${relative(projectRoot, source)} -> ${relative(projectRoot, target)}`)
    }
  }
  return violations
}

it('keeps annotation storage and native parsing behind the supported entries', () => {
  const violations = productionSources().flatMap((source) =>
    boundaryViolations(source, readFileSync(source, 'utf8'))
  )
  expect(violations.sort()).toEqual([])
})

it.each([
  ['side-effect import', "import './pdf-annotations/document-store'"],
  ['default import', "import store from './pdf-annotations/document-store'"],
  ['namespace import', "import * as store from './pdf-annotations/document-store'"],
  ['mixed import', "import { type Stored, store } from './pdf-annotations/document-store'"],
  [
    'default with type-only bindings',
    "import store, { type Stored } from './pdf-annotations/document-store'"
  ],
  ['named export', "export { store } from './pdf-annotations/document-store'"],
  ['mixed export', "export { type Stored, store } from './pdf-annotations/document-store'"],
  ['wildcard export', "export * from './pdf-annotations/document-store'"],
  ['namespace export', "export * as store from './pdf-annotations/document-store'"],
  ['require', "const store = require('./pdf-annotations/document-store')"],
  [
    'escaped require identifier',
    String.raw`const store = requ\u0069re('./pdf-annotations/docu\u006dent-store')`
  ],
  ['typed require', "const store = require<unknown>('./pdf-annotations/document-store')"],
  ['template require', 'const store = require(`./pdf-annotations/document-store`)'],
  ['dynamic import', "const store = import('./pdf-annotations/document-store')"],
  ['template import', 'const store = import(`./pdf-annotations/document-store`)'],
  ['nested require', 'const store = `${require("./pdf-annotations/document-store")}`'],
  ['nested import', 'const store = `${import("./pdf-annotations/document-store")}`'],
  ['escaped path', String.raw`import './pdf-annotations/docu\u006dent-store'`],
  ['hex escape', String.raw`require('./pdf-annotations/docu\x6dent-store')`],
  ['identity escape', String.raw`require('./pdf-annotations/docu\ment-store')`],
  ['line continuation', "require('./pdf-annotations/docu\\\nment-store')"],
  ['JavaScript extension', "import './pdf-annotations/document-store.js'"],
  ['normalized path', "import './pdf-annotations/../pdf-annotations/document-store'"]
])('rejects a private storage dependency through %s', (_name, text) => {
  expect(boundaryViolations(resolve(projectRoot, 'src/main/boundary-fixture.ts'), text)).toEqual([
    'src/main/boundary-fixture.ts -> src/main/pdf-annotations/document-store.ts'.replaceAll(
      '/',
      sep
    )
  ])
})

it.each([
  "import type { Stored } from './pdf-annotations/document-store'",
  "import { type Stored } from './pdf-annotations/document-store'",
  "export type { Stored } from './pdf-annotations/document-store'",
  "export { type Stored } from './pdf-annotations/document-store'",
  "export type * from './pdf-annotations/document-store'",
  "export type * as store from './pdf-annotations/document-store'",
  "// import './pdf-annotations/document-store'",
  'const text = "document-store"',
  "import './pdf-annotations/repository'",
  "import './unrelated-module'"
])('allows erased imports and non-dependencies: %s', (text) => {
  expect(boundaryViolations(resolve(projectRoot, 'src/main/boundary-fixture.ts'), text)).toEqual([])
})

it('checks package sources and TSX expressions with the same boundary rules', () => {
  expect(
    boundaryViolations(
      resolve(projectRoot, 'packages/fixture/src/index.ts'),
      "import '../../../src/main/pdf-annotations/sharing'"
    )
  ).toEqual([
    'packages/fixture/src/index.ts -> src/main/pdf-annotations/sharing.ts'.replaceAll('/', sep)
  ])
  expect(
    boundaryViolations(
      resolve(projectRoot, 'src/main/boundary-fixture.tsx'),
      'const view = <div>{require("./pdf-annotations/document-store")}</div>'
    )
  ).toEqual([
    'src/main/boundary-fixture.tsx -> src/main/pdf-annotations/document-store.ts'.replaceAll(
      '/',
      sep
    )
  ])
})

it('retains the internal storage allowance and exact native parser consumer allowlist', () => {
  expect(
    boundaryViolations(
      resolve(pdfAnnotationsDirectory, 'repository.ts'),
      "import './document-store'"
    )
  ).toEqual([])
  for (const consumer of nativeParserConsumers) {
    expect(boundaryViolations(consumer, "import './native-import-core'")).toEqual([])
  }
  expect(
    boundaryViolations(
      resolve(pdfAnnotationsDirectory, 'repository.ts'),
      "import './native-import-core'"
    )
  ).toEqual([
    'src/main/pdf-annotations/repository.ts -> src/main/pdf-annotations/native-import-core.ts'.replaceAll(
      '/',
      sep
    )
  ])
})

it.each(['.', '..'])('checks directory-relative native parser imports: %s', (specifier) => {
  const source = resolve(
    pdfAnnotationsDirectory,
    'native-import-core',
    ...(specifier === '..' ? ['nested'] : []),
    'consumer.ts'
  )
  expect(boundaryViolations(source, `import '${specifier}'`)).toEqual([
    `${relative(projectRoot, source)} -> src/main/pdf-annotations/native-import-core.ts`.replaceAll(
      '/',
      sep
    )
  ])
})

it('preserves extension order, JavaScript suffix rewriting and file-before-index resolution', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'pdf-boundary-resolution-'))
  try {
    const source = resolve(directory, 'consumer.ts')
    const base = resolve(directory, 'module')
    mkdirSync(base)
    writeFileSync(resolve(base, 'index.ts'), '')
    for (const extension of [...sourceExtensions].reverse()) {
      writeFileSync(`${base}${extension}`, '')
      for (const suffix of ['', '.js', '.mjs', '.cjs']) {
        expect(resolveRelativeImport(source, `./module${suffix}`)).toBe(`${base}${extension}`)
      }
    }
    for (const extension of sourceExtensions) rmSync(`${base}${extension}`)
    expect(resolveRelativeImport(source, './module')).toBe(resolve(base, 'index.ts'))
    expect(resolveRelativeImport(source, 'module')).toBeUndefined()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'prettier'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const catalogPath = resolve(root, 'src/shared/renderer-contract-catalog.ts')
const outputPath = resolve(root, 'src/shared/web-api-map.generated.ts')

const stringLiteral = (node, label) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isIdentifier(node)) return node.text
  throw new Error(`Renderer contract ${label} must be a string literal.`)
}

// prettier-ignore
const invokeProfiles = new Set(['WEB', 'LOCAL', 'MAPPED_ELECTRON', 'MAPPED_NATIVE', 'DELEGATED_NATIVE'])
const eventProfiles = new Set(['EVENT'])
// prettier-ignore
const unprojectedProfiles = new Set(['ELECTRON', 'SEND', 'WINDOW_FIND_READY', 'ELECTRON_EVENT', 'CLOSE_PANE_EVENT', 'NATIVE'])

const projectionFor = (node) => {
  if (!node) return 'invoke'
  if (!ts.isIdentifier(node)) throw new Error('Renderer contract profile must be an identifier.')
  if (invokeProfiles.has(node.text)) return 'invoke'
  if (eventProfiles.has(node.text)) return 'event'
  if (unprojectedProfiles.has(node.text)) return 'none'
  throw new Error(`Unknown renderer contract profile: ${node.text}`)
}

// Follow explicit contract constants only; never execute catalog code or scan directories.
async function readContractEntries(catalogPath) {
  const sources = new Map()
  const visiting = new Set()
  async function load(path) {
    if (sources.has(path)) return sources.get(path)
    const source = ts.createSourceFile(
      path,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const definitions = new Map()
    const imports = new Map()
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name))
            definitions.set(declaration.name.text, declaration.initializer)
        }
      }
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.namedBindings &&
        ts.isNamespaceImport(statement.importClause.namedBindings)
      ) {
        imports.set(statement.importClause.namedBindings.name.text, statement.moduleSpecifier.text)
      }
    }
    const result = { path, definitions, imports }
    sources.set(path, result)
    return result
  }
  async function definition(source, name) {
    const key = `${source.path}:${name}`
    if (visiting.has(key)) throw new Error(`Circular renderer contract definition: ${name}`)
    const node = source.definitions.get(name)
    if (!node) throw new Error(`Renderer contract definition not found: ${name}`)
    visiting.add(key)
    try {
      return await entries(source, node)
    } finally {
      visiting.delete(key)
    }
  }
  async function entries(source, node) {
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
      return entries(source, node.expression)
    if (ts.isIdentifier(node)) return definition(source, node.text)
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const specifier = source.imports.get(node.expression.text)
      if (!specifier?.startsWith('./'))
        throw new Error('Renderer contract imports must be explicit local modules.')
      return definition(
        await load(resolve(dirname(source.path), `${specifier}.ts`)),
        node.name.text
      )
    }
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'composeRendererApiContract'
      ) {
        const result = []
        for (const argument of node.arguments) result.push(...(await entries(source, argument)))
        return result
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Object' &&
        node.expression.name.text === 'freeze' &&
        node.arguments.length === 1
      ) {
        return entries(source, node.arguments[0])
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result = []
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property))
          result.push(...(await entries(source, property.expression)))
        else if (ts.isPropertyAssignment(property)) result.push(property)
        else
          throw new Error(
            'Renderer contract may only contain property assignments or explicit spreads.'
          )
      }
      return result
    }
    throw new Error('Unsupported renderer contract definition.')
  }
  return definition(await load(catalogPath), 'RENDERER_API_CONTRACT')
}

export async function generateRendererApiMap(catalogPath) {
  const invoke = {}
  const events = {}
  const publicPaths = new Set()
  for (const property of await readContractEntries(catalogPath)) {
    const path = stringLiteral(property.name, 'public path')
    if (publicPaths.has(path)) throw new Error(`Duplicate renderer contract path: ${path}`)
    publicPaths.add(path)
    const initializer = property.initializer
    if (
      !ts.isCallExpression(initializer) ||
      !ts.isCallExpression(initializer.expression) ||
      !ts.isIdentifier(initializer.expression.expression)
    ) {
      throw new Error(`Renderer contract entry must use a typed builder: ${path}`)
    }
    const builder = initializer.expression.expression.text
    if (builder === 'value') continue
    if (builder !== 'callable') throw new Error(`Unknown renderer contract builder: ${builder}`)
    const metadata = initializer.arguments[1]
    if (!metadata || !ts.isArrayLiteralExpression(metadata)) {
      throw new Error(`Renderer contract metadata must be a tuple: ${path}`)
    }
    const projection = projectionFor(metadata.elements[1])
    if (projection === 'none') continue
    const channel = stringLiteral(metadata.elements[0], 'channel')
    const target = projection === 'invoke' ? invoke : events
    if (Object.hasOwn(target, path)) throw new Error(`Duplicate projected renderer path: ${path}`)
    target[path] = channel
  }

  const sorted = (value) =>
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  return format(
    `// Generated by scripts/generate-web-api-map.mjs. Do not edit by hand.
export const WEB_INVOKE_CHANNELS = ${JSON.stringify(sorted(invoke), null, 2)} as const

export const WEB_EVENT_CHANNELS = ${JSON.stringify(sorted(events), null, 2)} as const
`,
    {
      parser: 'typescript',
      singleQuote: true,
      semi: false,
      printWidth: 100,
      trailingComma: 'none'
    }
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await generateRendererApiMap(catalogPath)
  if (process.argv.includes('--check')) {
    const current = await readFile(outputPath, 'utf8').catch(() => '')
    if (current !== output) {
      console.error('Web API map is stale. Run npm run gen:web-api-map.')
      process.exitCode = 1
    }
  } else {
    await writeFile(outputPath, output, 'utf8')
    console.log(`Generated ${outputPath}`)
  }
}

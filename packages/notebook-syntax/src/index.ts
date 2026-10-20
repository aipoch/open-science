/// <reference types="emscripten" preserve="true" />
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Language, Node, Tree } from 'web-tree-sitter'

const here = __dirname

type NotebookParserLanguage = 'python' | 'r' | 'bash' | 'javascript'

// Grammar wasm: web-tree-sitter 0.26.12, tree-sitter-python 0.25.0, @davisvaughan/tree-sitter-r 1.3.0.
// Bash 0.25.1 provenance and license are bundled beside its grammar in this package’s assets directory.
const wasmFile = (language: NotebookParserLanguage | 'runtime'): string =>
  language === 'runtime' ? 'web-tree-sitter.wasm' : `tree-sitter-${language}.wasm`

const resolveTreeSitterDir = (): string | undefined => {
  const directory = join(here, '../assets')
  return existsSync(join(directory, wasmFile('runtime'))) ? directory : undefined
}

let initPromise: Promise<string | undefined> | undefined
let parserRuntime: typeof import('web-tree-sitter') | undefined
const languages = new Map<NotebookParserLanguage, Language>()

const ensureParserRuntime = (): Promise<string | undefined> => {
  initPromise ??= (async () => {
    const dir = resolveTreeSitterDir()
    if (!dir) return undefined
    const runtime = await import('web-tree-sitter').catch(() => undefined)
    if (!runtime) return undefined
    await runtime.Parser.init({
      locateFile: (scriptName: string) => join(dir, scriptName)
    })
    parserRuntime = runtime
    return dir
  })()
  return initPromise
}

const loadLanguage = async (language: NotebookParserLanguage): Promise<Language | undefined> => {
  const cached = languages.get(language)
  if (cached) return cached
  const dir = await ensureParserRuntime()
  if (!dir || !parserRuntime) return undefined
  const loaded = await parserRuntime.Language.load(join(dir, wasmFile(language)))
  languages.set(language, loaded)
  return loaded
}

type ParsedNotebookSource<T> =
  { state: 'ok'; value: T } | { state: 'error'; reason: 'parse-error' | 'parser-unavailable' }

const withParsedNotebookSource = async <T>(
  language: NotebookParserLanguage,
  source: string,
  analyze: (root: Node) => T
): Promise<ParsedNotebookSource<T>> => {
  const grammar = await loadLanguage(language)
  const runtime = parserRuntime
  if (!grammar || !runtime) return { state: 'error', reason: 'parser-unavailable' }
  const parser = new runtime.Parser()
  let tree: Tree | null = null
  try {
    parser.setLanguage(grammar)
    tree = parser.parse(source)
    if (!tree || tree.rootNode.hasError) return { state: 'error', reason: 'parse-error' }
    return { state: 'ok', value: analyze(tree.rootNode) }
  } finally {
    tree?.delete()
    parser.delete()
  }
}

const fieldChild = (node: Node | null | undefined, field: string): Node | null =>
  node?.childForFieldName(field) ?? null

const fieldChildren = (node: Node, field: string): Node[] => {
  const children: Node[] = []
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.fieldNameForChild(index) !== field) continue
    const child = node.child(index)
    if (child) children.push(child)
  }
  return children
}

export { fieldChild, fieldChildren, withParsedNotebookSource }
export type { Node, ParsedNotebookSource, Tree }

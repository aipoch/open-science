import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Language, Parser, type Node, type Tree } from 'web-tree-sitter'

const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))

type NotebookParserLanguage = 'python' | 'r'

// Grammar wasm: web-tree-sitter 0.26.12, tree-sitter-python 0.25.0, @davisvaughan/tree-sitter-r 1.3.0.
const wasmFile = (language: NotebookParserLanguage | 'runtime'): string =>
  language === 'runtime'
    ? 'web-tree-sitter.wasm'
    : language === 'python'
      ? 'tree-sitter-python.wasm'
      : 'tree-sitter-r.wasm'

const resolveTreeSitterDir = (): string | undefined => {
  const resourcesPath = process.resourcesPath
  const candidates = [
    join(here, '../../../resources/tree-sitter'),
    join(here, '../../resources/tree-sitter'),
    join(here, '../resources/tree-sitter'),
    join(process.cwd(), 'resources/tree-sitter'),
    resourcesPath
      ? join(resourcesPath, 'app.asar.unpacked', 'resources', 'tree-sitter')
      : undefined,
    resourcesPath ? join(resourcesPath, 'resources', 'tree-sitter') : undefined
  ]
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(join(candidate, wasmFile('runtime'))))
  )
}

let initPromise: Promise<string | undefined> | undefined
const languages = new Map<NotebookParserLanguage, Language>()

const ensureParserRuntime = (): Promise<string | undefined> => {
  initPromise ??= (async () => {
    const dir = resolveTreeSitterDir()
    if (!dir) return undefined
    await Parser.init({
      locateFile: (scriptName: string) => join(dir, scriptName)
    })
    return dir
  })()
  return initPromise
}

const loadLanguage = async (language: NotebookParserLanguage): Promise<Language | undefined> => {
  const cached = languages.get(language)
  if (cached) return cached
  const dir = await ensureParserRuntime()
  if (!dir) return undefined
  const loaded = await Language.load(join(dir, wasmFile(language)))
  languages.set(language, loaded)
  return loaded
}

type ParsedNotebookSource =
  | { state: 'parsed'; tree: Tree; source: string }
  | { state: 'error'; reason: 'parse-error' | 'parser-unavailable' }

const parseNotebookSource = async (
  language: NotebookParserLanguage,
  source: string
): Promise<ParsedNotebookSource> => {
  const grammar = await loadLanguage(language)
  if (!grammar) return { state: 'error', reason: 'parser-unavailable' }
  const parser = new Parser()
  parser.setLanguage(grammar)
  const tree = parser.parse(source)
  if (!tree || tree.rootNode.hasError) return { state: 'error', reason: 'parse-error' }
  return { state: 'parsed', tree, source }
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

export { fieldChild, fieldChildren, parseNotebookSource }
export type { Node, ParsedNotebookSource, Tree }

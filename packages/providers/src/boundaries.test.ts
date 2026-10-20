import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { expect, it } from 'vitest'
import {
  createSourceFile,
  ScriptTarget,
  isImportDeclaration,
  isExportDeclaration,
  isStringLiteral
} from 'typescript'
const root = __dirname
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]
    )
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
const allowed: Record<string, string[]> = {
  providers: ['providers', 'protocols', 'models', 'discovery'],
  protocols: ['protocols'],
  transport: ['transport'],
  responses: ['responses', 'protocols', 'transport'],
  discovery: ['discovery', 'transport.ts'],
  models: ['models', 'protocols', 'transport', 'errors.ts']
}
it('keeps internal responsibilities acyclic and independent of host source and facades', () => {
  const edges = new Map<string, string[]>()
  for (const file of files(root)) {
    const local = relative(root, file),
      owner = local.split('/')[0]
    const source = createSourceFile(file, readFileSync(file, 'utf8'), ScriptTarget.Latest, true)
    const imports: string[] = []
    for (const node of source.statements) {
      if (!isImportDeclaration(node) && !isExportDeclaration(node)) continue
      if (!node.moduleSpecifier || !isStringLiteral(node.moduleSpecifier)) continue
      const spec = node.moduleSpecifier.text
      if (!spec.startsWith('.')) {
        expect(spec).toMatch(/^(?:node:|js-tiktoken\/|zod$|@aipoch\/diagnostics(?:\/node)?$)/)
        continue
      }
      const target = resolve(dirname(file), spec + '.ts'),
        destination = relative(root, target)
      expect(destination, local).not.toMatch(/^\.\./)
      if (allowed[owner])
        expect(allowed[owner], `${local} -> ${destination}`).toContain(destination.split('/')[0])
      if (
        owner === 'providers' &&
        local !== 'providers/create.ts' &&
        (destination.startsWith('models/') || destination.startsWith('discovery/'))
      )
        expect(
          isImportDeclaration(node) && node.importClause?.isTypeOnly,
          `${local} must not load model runtimes`
        ).toBe(true)
      imports.push(target)
    }
    edges.set(file, imports)
  }
  const visit = (file: string, stack: string[]): void => {
    expect(stack, relative(root, file)).not.toContain(file)
    for (const child of edges.get(file) ?? []) visit(child, [...stack, file])
  }
  for (const file of edges.keys()) visit(file, [])
})

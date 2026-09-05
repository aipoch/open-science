import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isIdentifier,
  ScriptKind,
  ScriptTarget,
  type Node
} from 'typescript'
import { describe, expect, it } from 'vitest'

import { listProductionSources } from '../../test/architecture-source-index'

const projectRoot = resolve(__dirname, '../..')
const source = (path: string): string => readFileSync(resolve(projectRoot, path), 'utf8')

const referencesIdentifier = (path: string, name: string): boolean => {
  const file = createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ScriptKind.TSX : ScriptKind.TS
  )
  let found = false
  const visit = (node: Node): void => {
    if (isIdentifier(node) && node.text === name) found = true
    if (!found) forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('storage root routing architecture', () => {
  it('uses configRoot as the canonical fixed-root resolver name', () => {
    const rootSource = source('src/main/storage-root.ts')

    expect(rootSource).toContain('const resolveConfigRoot = (): string =>')
    expect(rootSource).toContain('const resolveStorageRoot = resolveConfigRoot')

    const legacyConsumers = listProductionSources(projectRoot)
      .filter((path) => path !== resolve(projectRoot, 'src/main/storage-root.ts'))
      .filter((path) => referencesIdentifier(path, 'resolveStorageRoot'))
      .map((path) => relative(projectRoot, path).replaceAll('\\', '/'))

    expect(legacyConsumers).toEqual([])
  })

  it('names configuration-owned public seams configRoot', () => {
    const database = source('src/main/projects/prisma-client.ts')
    expect(database).toContain('const projectDatabasePath = (configRoot: string)')
    expect(database).toContain('const createProjectDbClient = (configRoot: string)')
    expect(database).toMatch(/const getProjectDbClient = \(\s+configRoot: string,/)

    const settings = source('src/main/settings/service.ts')
    expect(settings).toContain('  configRoot?: string')
    expect(settings).toContain('private readonly configRoot: string')
    expect(settings).toContain('new DeviceCredentialStore(this.configRoot)')
    expect(settings).toContain('configRoot: this.configRoot')

    expect(source('src/main/settings/device-credentials.ts')).toContain(
      'constructor(configRoot: string)'
    )

    const runtime = source('src/main/settings/agent-runtime-manager.ts')
    expect(runtime).toContain('  configRoot: string')
    expect(runtime).toContain('private readonly configRoot: string')
  })

  it('routes Upload, Notebook, and Workspace through dataRoot', () => {
    const uploads = source('src/main/uploads/ipc.ts')
    expect(uploads).toContain('new UploadRepository(resolveDataRoot(), {')
    expect(uploads).toContain('getProjectDbClient(resolveConfigRoot())')
    expect(source('src/main/uploads/repository.ts')).toContain(
      'constructor(dataRoot: string, options: UploadRepositoryOptions = {})'
    )

    const notebookComposition = source('src/main/ipc.ts')
    expect(notebookComposition).toMatch(
      /configRoot: resolveConfigRoot\(\),\s+dataRoot: resolveDataRoot\(\)/
    )

    expect(source('src/main/acp/managed-session-workspace.ts')).toContain(
      'resolveRoot: resolveDataRoot'
    )
  })
})

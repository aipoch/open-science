import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactRepository } from './repository'
import {
  createArtifactMcpEnvironmentFromProcess,
  createArtifactMcpServerConfig,
  writeArtifactFileForCurrentRun,
  type ArtifactMcpEnvironment
} from './mcp-server'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-mcp-'))
  return storageRoot
}

const createEnvironment = async (root: string): Promise<ArtifactMcpEnvironment> => {
  const currentRunFile = join(root, 'current-run.json')

  await writeFile(currentRunFile, JSON.stringify({ runId: 'run-1' }), 'utf8')

  return {
    storageRoot: root,
    projectName: 'default-project',
    sessionId: 'session-1',
    currentRunFile,
    allowedImportRoots: []
  }
}

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('artifact MCP server', () => {
  it('keeps legacy content and encoding input working for the current run', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)
    const environment = await createEnvironment(root)

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'plot.svg',
      mimeType: 'image/svg+xml',
      content: '<svg />',
      encoding: 'utf8'
    })

    expect(artifact).toMatchObject({
      id: 'session-1:run-1:plot.svg',
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      name: 'plot.svg',
      mimeType: 'image/svg+xml'
    })
    expect(artifact.path).toBe(
      join(root, 'artifacts', 'default-project', 'session-1', '.pending', 'run-1', 'plot.svg')
    )
    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('<svg />')
  })

  it('writes localPath artifact sources for the current run', async () => {
    const root = await createStorageRoot()
    const allowedRoot = join(root, 'notebook-session')
    const sourcePath = join(allowedRoot, 'plot.svg')
    await mkdir(allowedRoot, { recursive: true })
    await writeFile(sourcePath, '<svg />', 'utf8')
    const repository = new ArtifactRepository(root)
    const environment = {
      ...(await createEnvironment(root)),
      allowedImportRoots: [allowedRoot]
    }

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'plot.svg',
      mimeType: 'image/svg+xml',
      source: { kind: 'localPath', path: sourcePath }
    })

    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('<svg />')
  })

  it('rejects writes when no active run context is available', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)
    const environment = await createEnvironment(root)

    await writeFile(environment.currentRunFile, JSON.stringify({}), 'utf8')

    await expect(
      writeArtifactFileForCurrentRun(repository, environment, {
        filename: 'plot.svg',
        content: '<svg />',
        encoding: 'utf8'
      })
    ).rejects.toThrow(/active artifact run/)
  })

  it('builds an ACP stdio MCP server config for the artifact tool process', () => {
    const config = createArtifactMcpServerConfig({
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      entryPath: '/app/out/main/index.js',
      storageRoot: '/Users/example/.open-science',
      projectName: 'default-project',
      sessionId: 'session-1',
      currentRunFile:
        '/Users/example/.open-science/artifacts/default-project/session-1/.pending/current-run.json',
      allowedImportRoots: ['/Users/example/workspace', '/Users/example/.open-science/notebooks']
    })

    expect(config).toEqual({
      name: 'open-science-artifacts',
      command: '/Applications/Open Science.app/Contents/MacOS/Open Science',
      args: ['/app/out/main/index.js', '--open-science-artifact-mcp'],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'OPEN_SCIENCE_ARTIFACT_STORAGE_ROOT', value: '/Users/example/.open-science' },
        { name: 'OPEN_SCIENCE_ARTIFACT_PROJECT_NAME', value: 'default-project' },
        { name: 'OPEN_SCIENCE_ARTIFACT_SESSION_ID', value: 'session-1' },
        {
          name: 'OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE',
          value:
            '/Users/example/.open-science/artifacts/default-project/session-1/.pending/current-run.json'
        },
        {
          name: 'OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS',
          value: JSON.stringify([
            '/Users/example/workspace',
            '/Users/example/.open-science/notebooks'
          ])
        }
      ]
    })
  })

  it('parses allowed import roots from the MCP process environment', () => {
    expect(
      createArtifactMcpEnvironmentFromProcess({
        OPEN_SCIENCE_ARTIFACT_STORAGE_ROOT: '/Users/example/.open-science',
        OPEN_SCIENCE_ARTIFACT_PROJECT_NAME: 'default-project',
        OPEN_SCIENCE_ARTIFACT_SESSION_ID: 'session-1',
        OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE: '/tmp/current-run.json',
        OPEN_SCIENCE_ARTIFACT_ALLOWED_IMPORT_ROOTS: JSON.stringify([
          '/Users/example/workspace',
          '/Users/example/.open-science/notebooks'
        ])
      })
    ).toEqual({
      storageRoot: '/Users/example/.open-science',
      projectName: 'default-project',
      sessionId: 'session-1',
      currentRunFile: '/tmp/current-run.json',
      allowedImportRoots: ['/Users/example/workspace', '/Users/example/.open-science/notebooks']
    })
  })
})

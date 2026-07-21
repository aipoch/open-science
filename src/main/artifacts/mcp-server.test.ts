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

const createEnvironment = async (
  root: string,
  runContext: Record<string, unknown> = { runId: 'run-1' }
): Promise<ArtifactMcpEnvironment> => {
  const currentRunFile = join(root, 'current-run.json')

  await writeFile(currentRunFile, JSON.stringify(runContext), 'utf8')

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

  it('treats a bare filename with no source as a localPath under the handoff notebook data dir', async () => {
    // The common flow: plt.savefig("plot.svg") in the kernel cwd, then write_artifact_file with just
    // the filename. No source/content and no rebuilt path — it must resolve against the notebook data
    // dir carried by the per-turn handoff (current-run.json), and the session root authorizes it.
    const root = await createStorageRoot()
    const sessionRoot = join(root, 'notebook-session')
    const dataDir = join(sessionRoot, 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'plot.svg'), '<svg />', 'utf8')
    const repository = new ArtifactRepository(root)
    // allowedImportRoots is intentionally empty here: authorization must come from the handoff's
    // notebookSessionRoot, proving relative writes work even when the static env root is stale.
    const environment = await createEnvironment(root, {
      runId: 'run-1',
      notebookDataDir: dataDir,
      notebookSessionRoot: sessionRoot
    })

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'plot.svg',
      mimeType: 'image/svg+xml'
    })

    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('<svg />')
  })

  it('resolves a relative localPath against the handoff notebook data dir', async () => {
    const root = await createStorageRoot()
    const sessionRoot = join(root, 'notebook-session')
    const dataDir = join(sessionRoot, 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'plot.svg'), '<svg />', 'utf8')
    const repository = new ArtifactRepository(root)
    const environment = await createEnvironment(root, {
      runId: 'run-1',
      notebookDataDir: dataDir,
      notebookSessionRoot: sessionRoot
    })

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'plot.svg',
      source: { kind: 'localPath', path: 'plot.svg' }
    })

    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('<svg />')
  })

  it('rejects an absolute path under the stale pre-start notebook alias root', async () => {
    // Regression for the P1 follow-up: the handoff's final session root is the ONLY authoritative
    // notebook import root. A file living under the old pre-start alias dir must NOT pass the
    // allow-root check just because the session was once created under that alias.
    const root = await createStorageRoot()
    const finalSessionRoot = join(root, 'notebooks', 'default-project', 'final-session')
    const finalDataDir = join(finalSessionRoot, 'data')
    await mkdir(finalDataDir, { recursive: true })

    // A file the agent saved under the stale alias dir (not the final session dir).
    const aliasDataDir = join(
      root,
      'notebooks',
      'default-project',
      'notebook-session-123-1',
      'data'
    )
    await mkdir(aliasDataDir, { recursive: true })
    const aliasFile = join(aliasDataDir, 'stale.png')
    await writeFile(aliasFile, 'PNG', 'utf8')

    const repository = new ArtifactRepository(root)
    // Static roots exclude any notebook alias (only sessionCwd would be present in production).
    const environment = await createEnvironment(root, {
      runId: 'run-1',
      notebookDataDir: finalDataDir,
      notebookSessionRoot: finalSessionRoot
    })

    await expect(
      writeArtifactFileForCurrentRun(repository, environment, {
        filename: 'stale.png',
        source: { kind: 'localPath', path: aliasFile }
      })
    ).rejects.toThrow(/outside allowed artifact import roots/i)
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

  it('rejects a bare filename with no source/content outside a notebook turn', async () => {
    // Without a notebook data dir in the handoff there is no base to resolve a bare filename against,
    // so the convenience default must NOT silently fall back to the MCP process cwd — keep the clear
    // contract error (an artifacts-enabled, notebook-disabled session hits this path).
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)
    const environment = await createEnvironment(root, { runId: 'run-1' })

    await expect(
      writeArtifactFileForCurrentRun(repository, environment, { filename: 'plot.svg' })
    ).rejects.toThrow(/requires source or content/i)
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

  it('reads the notebook data dir and session root from the per-turn handoff', async () => {
    // The notebook context is carried in current-run.json (written per turn with the final session
    // id), not in the process env — so a stale session-creation alias can never poison the base dir.
    const root = await createStorageRoot()
    const sessionRoot = join(root, 'notebook-session')
    const dataDir = join(sessionRoot, 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'out.csv'), 'a,b\n1,2\n', 'utf8')
    const repository = new ArtifactRepository(root)
    const environment = await createEnvironment(root, {
      runId: 'run-1',
      notebookDataDir: dataDir,
      notebookSessionRoot: sessionRoot
    })

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'out.csv'
    })

    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('a,b\n1,2\n')
  })
})

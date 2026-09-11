import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const { log } = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => log
}))

import { createPngBytes } from './artifact-test-fixtures'
import { ArtifactRepository } from './repository'
import {
  createArtifactMcpEnvironmentFromProcess,
  createArtifactMcpServerConfig,
  toWriteArtifactToolResult,
  writeArtifactFileToolDefinition,
  writeArtifactFileForCurrentRun as saveThroughMcp,
  type ArtifactMcpEnvironment
} from './mcp-server'

import { createArtifactSaveFixture } from './save-test-fixtures'

let activeFixture: Awaited<ReturnType<typeof createArtifactSaveFixture>> | undefined
let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  activeFixture = await createArtifactSaveFixture()
  storageRoot = activeFixture.storageRoot
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
    projectId: 'default-project',
    sessionId: 'session-1',
    currentRunFile,
    allowedImportRoots: []
  }
}

const writeArtifactFileForCurrentRun: typeof saveThroughMcp = async (
  repository,
  env,
  input,
  invocation
) => {
  const context = JSON.parse(await readFile(env.currentRunFile, 'utf8'))
  const run = context.artifactRunId ?? context.runId
  if (!run) return saveThroughMcp(repository, env, input, invocation)
  const binding = {
    ...activeFixture!.binding,
    projectId: env.projectId!,
    artifactRunId: run,
    artifactStorageSessionId: context.artifactStorageSessionId ?? env.sessionId,
    sourceScope: {
      allowedImportRoots: [
        ...env.allowedImportRoots,
        ...(context.notebookSessionRoot ? [context.notebookSessionRoot] : [])
      ],
      workspaceCwd: env.allowedImportRoots[0],
      notebookDataDir: context.notebookDataDir,
      notebookSessionRoot: context.notebookSessionRoot
    }
  }
  const token = activeFixture!.server.issueArtifactRunCapability(binding)
  await writeFile(
    env.currentRunFile,
    JSON.stringify({ ...context, ...binding, rpcCapabilityToken: token })
  )
  return saveThroughMcp(
    repository,
    { ...env, rpcEndpoint: activeFixture!.connection.endpoint },
    input,
    invocation
  )
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await activeFixture?.dispose()
  activeFixture = undefined
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('artifact MCP server', () => {
  it('directs small text artifacts to inline publication without a prior disk write', () => {
    expect(writeArtifactFileToolDefinition.description).toContain(
      'For small generated text such as Markdown or plain text, pass inline content directly'
    )
    expect(writeArtifactFileToolDefinition.description).not.toContain(
      'The file must ALREADY EXIST on disk before you call this.'
    )
  })

  it('publishes filename as a required write_artifact_file argument', () => {
    const schema = z.object(writeArtifactFileToolDefinition.inputSchema)

    expect(schema.safeParse({}).error?.issues).toEqual([
      expect.objectContaining({ path: ['filename'] })
    ])
    expect(
      schema.parse({
        filename: 'plot.png',
        source: { kind: 'localPath', path: 'plot.png' },
        producerRunId: 'notebook-run-1'
      })
    ).toMatchObject({ filename: 'plot.png', producerRunId: 'notebook-run-1' })
  })

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
      versionId: expect.any(String),
      projectId: 'default-project',
      sessionId: 'session-1',
      runId: 'run-1',
      name: 'plot.svg',
      mimeType: 'image/svg+xml'
    })
    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('<svg />')
    expect(log.warn).not.toHaveBeenCalled()
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

  it('treats a bare filename with no source as a localPath under the session workspace', async () => {
    // The same convenience default outside a notebook turn: the agent saved into the session
    // workspace (its cwd) with plain tools, then called write_artifact_file with just the filename.
    // The static import roots double as the resolution base, so the bare name resolves.
    const root = await createStorageRoot()
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'plot.svg'), '<svg />', 'utf8')
    const repository = new ArtifactRepository(root)
    const environment = {
      ...(await createEnvironment(root, { runId: 'run-1' })),
      allowedImportRoots: [workspace]
    }

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

  it('accepts the session-relative data path returned by Notebook workingFiles', async () => {
    const root = await createStorageRoot()
    const sessionRoot = join(root, 'notebook-session')
    const dataDir = join(sessionRoot, 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'sin.png'), createPngBytes('workingFiles bytes'))
    const repository = new ArtifactRepository(root)
    const environment = await createEnvironment(root, {
      runId: 'run-1',
      notebookDataDir: dataDir,
      notebookSessionRoot: sessionRoot
    })

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'sin.png',
      mimeType: 'image/png',
      source: { kind: 'localPath', path: 'data/sin.png' }
    })

    await expect(readFile(artifact.path)).resolves.toEqual(createPngBytes('workingFiles bytes'))
  })

  it('prefers the exact kernel-relative data path before the workingFiles interpretation', async () => {
    const root = await createStorageRoot()
    const sessionRoot = join(root, 'notebook-session')
    const dataDir = join(sessionRoot, 'data')
    await mkdir(join(dataDir, 'data'), { recursive: true })
    await writeFile(join(dataDir, 'sin.png'), createPngBytes('workingFiles bytes'))
    await writeFile(join(dataDir, 'data', 'sin.png'), createPngBytes('explicit nested bytes'))
    const repository = new ArtifactRepository(root)
    const environment = await createEnvironment(root, {
      runId: 'run-1',
      notebookDataDir: dataDir,
      notebookSessionRoot: sessionRoot
    })

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'sin.png',
      mimeType: 'image/png',
      source: { kind: 'localPath', path: 'data/sin.png' }
    })

    await expect(readFile(artifact.path)).resolves.toEqual(createPngBytes('explicit nested bytes'))
  })

  it('resolves an explicit relative localPath against the session workspace outside a notebook turn', async () => {
    // Regression for the P2 follow-up: with no notebook data dir in the handoff, the static import
    // roots (in production exactly the session workspace) serve as the resolution base, so a bare
    // filename the agent saved into the workspace resolves instead of reporting "does not exist".
    const root = await createStorageRoot()
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'plot.svg'), '<svg />', 'utf8')
    const repository = new ArtifactRepository(root)
    const environment = {
      ...(await createEnvironment(root, { runId: 'run-1' })),
      allowedImportRoots: [workspace]
    }

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'plot.svg',
      source: { kind: 'localPath', path: 'plot.svg' }
    })

    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('<svg />')
  })

  it('falls back to the session workspace for a relative localPath during a notebook turn', async () => {
    // Native Agent file tools write into the session workspace even when Notebook is available in
    // the same turn. A relative artifact path must therefore fall back there when the file is not in
    // the Notebook data dir; requiring the Agent to rediscover and resend the absolute path wastes a
    // tool call and can lead it to duplicate the whole file as inline content.
    const root = await createStorageRoot()
    const sessionRoot = join(root, 'notebook-session')
    const dataDir = join(sessionRoot, 'data')
    const workspace = join(root, 'workspace')
    await mkdir(dataDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'review.md'), '# Review', 'utf8')
    const repository = new ArtifactRepository(root)
    const environment = {
      ...(await createEnvironment(root, {
        runId: 'run-1',
        notebookDataDir: dataDir,
        notebookSessionRoot: sessionRoot
      })),
      allowedImportRoots: [workspace]
    }

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'review.md',
      mimeType: 'text/markdown',
      source: { kind: 'localPath', path: 'review.md' }
    })

    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('# Review')
  })

  it('prefers the notebook data dir over a same-named session workspace file', async () => {
    // The workspace fallback must not override a same-named file produced in the active Notebook.
    const root = await createStorageRoot()
    const sessionRoot = join(root, 'notebook-session')
    const dataDir = join(sessionRoot, 'data')
    const workspace = join(root, 'workspace')
    await mkdir(dataDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(dataDir, 'plot.svg'), '<svg>notebook</svg>', 'utf8')
    await writeFile(join(workspace, 'plot.svg'), '<svg>workspace</svg>', 'utf8')
    const repository = new ArtifactRepository(root)
    const environment = {
      ...(await createEnvironment(root, {
        runId: 'run-1',
        notebookDataDir: dataDir,
        notebookSessionRoot: sessionRoot
      })),
      allowedImportRoots: [workspace]
    }

    const artifact = await writeArtifactFileForCurrentRun(repository, environment, {
      filename: 'plot.svg',
      source: { kind: 'localPath', path: 'plot.svg' }
    })

    await expect(readFile(artifact.path, 'utf8')).resolves.toBe('<svg>notebook</svg>')
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
      projectId: 'default-project',
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
        { name: 'OPEN_SCIENCE_ARTIFACT_PROJECT_ID', value: 'default-project' },
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

  it('passes the Windows named-pipe path to the artifact MCP process', () => {
    const config = createArtifactMcpServerConfig({
      command: 'C:\\Open Science.exe',
      entryPath: 'C:\\app\\main.js',
      storageRoot: 'C:\\OpenScience',
      projectId: 'default-project',
      sessionId: 'session-1',
      currentRunFile: 'C:\\OpenScience\\current-run.json',
      allowedImportRoots: ['C:\\workspace'],
      rpcEndpoint: 'http://localhost',
      rpcSocketPath: '\\\\.\\pipe\\open-science-notebook'
    })

    expect(config.env).toContainEqual({
      name: 'OPEN_SCIENCE_ARTIFACT_RPC_SOCKET_PATH',
      value: '\\\\.\\pipe\\open-science-notebook'
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
      projectId: 'default-project',
      sessionId: 'session-1',
      currentRunFile: '/tmp/current-run.json',
      allowedImportRoots: ['/Users/example/workspace', '/Users/example/.open-science/notebooks']
    })
  })

  it('prefers projectId and rejects a conflicting legacy projectName environment value', () => {
    const base = {
      OPEN_SCIENCE_ARTIFACT_STORAGE_ROOT: '/Users/example/.open-science',
      OPEN_SCIENCE_ARTIFACT_SESSION_ID: 'session-1',
      OPEN_SCIENCE_ARTIFACT_CURRENT_RUN_FILE: '/tmp/current-run.json'
    }
    expect(
      createArtifactMcpEnvironmentFromProcess({
        ...base,
        OPEN_SCIENCE_ARTIFACT_PROJECT_ID: 'project-1'
      }).projectId
    ).toBe('project-1')
    expect(() =>
      createArtifactMcpEnvironmentFromProcess({
        ...base,
        OPEN_SCIENCE_ARTIFACT_PROJECT_ID: 'project-1',
        OPEN_SCIENCE_ARTIFACT_PROJECT_NAME: 'renamed-project'
      })
    ).toThrow('Conflicting projectId and legacy projectName values.')
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

  it('returns a compact legacy artifact receipt without echoing local paths', () => {
    const result = toWriteArtifactToolResult({
      id: 'legacy-artifact-1',
      projectId: 'default-project',
      sessionId: 'session-1',
      runId: 'artifact-run-1',
      name: 'table.csv',
      path: '/private/session/artifacts/table.csv',
      fileUrl: 'file:///private/session/artifacts/table.csv',
      mimeType: 'text/csv',
      size: 42,
      mtimeMs: 1,
      producerRunId: 'notebook-run-1'
    })

    expect(result).toEqual({
      artifact: {
        artifact_id: 'legacy-artifact-1',
        filename: 'table.csv',
        size_bytes: 42,
        producer_run_id: 'notebook-run-1'
      }
    })
    expect(JSON.stringify(result)).not.toContain('/private/session')
  })
})

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPngBytes, createPngInlineSource } from './artifact-test-fixtures'
import { ArtifactRepository } from './repository'
import {
  createArtifactMcpEnvironmentFromProcess,
  createArtifactMcpServerConfig,
  toWriteArtifactToolResult,
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
  vi.unstubAllGlobals()
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

  it('does not probe the session workspace when a notebook data dir is authoritative', async () => {
    // A relative source has one resolution base. Falling through to another allowed root can import
    // a stale same-named file that the Agent did not produce in the active Notebook workspace.
    const root = await createStorageRoot()
    const sessionRoot = join(root, 'notebook-session')
    const dataDir = join(sessionRoot, 'data')
    const workspace = join(root, 'workspace')
    await mkdir(dataDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'plot.svg'), '<svg />', 'utf8')
    const repository = new ArtifactRepository(root)
    const environment = {
      ...(await createEnvironment(root, {
        runId: 'run-1',
        notebookDataDir: dataDir,
        notebookSessionRoot: sessionRoot
      })),
      allowedImportRoots: [workspace]
    }

    await expect(
      writeArtifactFileForCurrentRun(repository, environment, {
        filename: 'plot.svg',
        source: { kind: 'localPath', path: 'plot.svg' }
      })
    ).rejects.toThrow(/does not exist/i)
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

  it('publishes a stable Version receipt through the main-process Provenance RPC', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)
    const environment = {
      ...(await createEnvironment(root, {
        artifactRunId: 'artifact-run-1',
        appSessionId: 'session-1',
        rootFrameId: 'root-frame-1',
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        messageBranchAncestry: ['branch-parent', 'branch-1'],
        messageAncestry: ['message-user-parent', 'message-user-1'],
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'message-user-1',
        agentName: 'Codex',
        notebookSessionId: 'session-1',
        rpcCapabilityToken: 'run-capability'
      })),
      rpcEndpoint: 'http://127.0.0.1:9000'
    }
    const persisted = {
      id: 'version-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      createdAt: '2026-07-27T00:00:00.000Z',
      producerRunId: 'notebook-run-17',
      environment: 'analysis-python',
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'artifact-run-1',
      name: 'sin.png',
      path: join(root, 'immutable-content'),
      fileUrl: 'file:///immutable-content',
      mimeType: 'image/png',
      size: 4,
      mtimeMs: 1
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ result: persisted }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )

    const result = await writeArtifactFileForCurrentRun(
      repository,
      environment,
      {
        filename: 'sin.png',
        mimeType: 'image/png',
        source: createPngInlineSource('plot'),
        producerRunId: 'notebook-run-17'
      },
      { requestId: 'rpc-request-42' }
    )
    await writeArtifactFileForCurrentRun(
      repository,
      environment,
      {
        filename: 'sin.png',
        mimeType: 'image/png',
        source: createPngInlineSource('plot'),
        producerRunId: 'notebook-run-17'
      },
      { requestId: 'rpc-request-42' }
    )

    expect(result).toEqual(persisted)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe(environment.rpcEndpoint)
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer run-capability' })
    const body = JSON.parse(String(calls[0].init.body)) as {
      method: string
      params: Record<string, unknown>
    }
    expect(body.method).toBe('artifactCreateVersion')
    expect(body.params).toMatchObject({
      projectId: 'default-project',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: expect.stringMatching(/^artifact-write-[a-f0-9]{64}$/u),
      agentName: 'Codex',
      messageBranchAncestry: ['branch-parent', 'branch-1'],
      messageAncestry: ['message-user-parent', 'message-user-1'],
      producerRunId: 'notebook-run-17',
      notebookSessionId: 'session-1',
      sourceKind: 'inline',
      filename: 'sin.png',
      contentType: 'image/png'
    })
    const retryBody = JSON.parse(String(calls[1].init.body)) as {
      params: Record<string, unknown>
    }
    expect(retryBody.params.writeOperationId).toBe(body.params.writeOperationId)
    expect(body.params.writeRequestChecksum).toMatch(/^[a-f0-9]{64}$/)
    expect(toWriteArtifactToolResult(result)).toEqual({
      artifact: {
        artifact_id: 'artifact-1',
        version_id: 'version-1',
        version_number: 1,
        filename: 'sin.png',
        content_type: 'image/png',
        size_bytes: 4,
        checksum: 'a'.repeat(64),
        producer_run_id: 'notebook-run-17',
        environment: 'analysis-python'
      }
    })
    expect(JSON.stringify(toWriteArtifactToolResult(result))).not.toContain(root)
  })

  it('restores the previous pending file when a durable Version RPC rejects the write', async () => {
    const root = await createStorageRoot()
    const repository = new ArtifactRepository(root)
    const environment = {
      ...(await createEnvironment(root, {
        artifactRunId: 'artifact-run-1',
        appSessionId: 'session-1',
        rootFrameId: 'root-frame-1',
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'message-user-1',
        rpcCapabilityToken: 'run-capability'
      })),
      rpcEndpoint: 'http://127.0.0.1:9000'
    }
    const pendingPath = join(
      root,
      'artifacts',
      'default-project',
      'session-1',
      '.pending',
      'artifact-run-1',
      'sin.png'
    )
    let callCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount += 1
        if (callCount === 2) {
          return new Response(JSON.stringify({ error: 'idempotency conflict' }), { status: 409 })
        }
        return new Response(
          JSON.stringify({
            result: {
              id: 'version-1',
              artifactId: 'artifact-1',
              versionId: 'version-1',
              versionNumber: 1,
              checksum: 'a'.repeat(64),
              createdAt: '2026-07-27T00:00:00.000Z',
              projectName: 'default-project',
              sessionId: 'session-1',
              runId: 'artifact-run-1',
              name: 'sin.png',
              path: join(root, 'immutable-content'),
              fileUrl: 'file:///immutable-content',
              size: 8,
              mtimeMs: 1
            }
          }),
          { status: 200 }
        )
      })
    )

    await writeArtifactFileForCurrentRun(
      repository,
      environment,
      { filename: 'sin.png', source: createPngInlineSource('original') },
      { requestId: 'same-operation' }
    )
    await expect(
      writeArtifactFileForCurrentRun(
        repository,
        environment,
        { filename: 'sin.png', source: createPngInlineSource('conflicting replacement') },
        { requestId: 'same-operation' }
      )
    ).rejects.toThrow('idempotency conflict')

    await expect(readFile(pendingPath)).resolves.toEqual(createPngBytes('original'))
  })

  it('replays a localPath Version before reading a source file that no longer exists', async () => {
    const root = await createStorageRoot()
    const sourceRoot = join(root, 'notebook-session')
    const sourcePath = join(sourceRoot, 'sin.png')
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(sourcePath, createPngBytes('plot'))
    const sourceStat = await stat(sourcePath)
    const resolvedSourcePath = await realpath(sourcePath)
    const repository = new ArtifactRepository(root)
    const environment = {
      ...(await createEnvironment(root, {
        artifactRunId: 'artifact-run-1',
        appSessionId: 'session-1',
        rootFrameId: 'root-frame-1',
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'message-user-1',
        notebookSessionId: 'session-1',
        notebookSessionRoot: sourceRoot,
        rpcCapabilityToken: 'run-capability'
      })),
      allowedImportRoots: [sourceRoot],
      rpcEndpoint: 'http://127.0.0.1:9000'
    }
    const persisted = {
      id: 'version-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      versionNumber: 1,
      checksum: 'a'.repeat(64),
      createdAt: '2026-07-27T00:00:00.000Z',
      producerRunId: 'notebook-run-17',
      environment: 'analysis-python',
      projectName: 'default-project',
      sessionId: 'session-1',
      runId: 'artifact-run-1',
      name: 'sin.png',
      path: join(root, 'immutable-content'),
      fileUrl: 'file:///immutable-content',
      mimeType: 'image/png',
      size: 4,
      mtimeMs: 1
    }
    const methods: string[] = []
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          method: string
          params: Record<string, unknown>
        }
        requests.push(body)
        methods.push(body.method)
        const result =
          body.method === 'artifactReplayVersion' && methods.length === 1 ? null : persisted
        return new Response(JSON.stringify({ result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )
    const input = {
      filename: 'sin.png',
      mimeType: 'image/png',
      source: { kind: 'localPath' as const, path: sourcePath },
      producerRunId: 'notebook-run-17'
    }

    await expect(
      writeArtifactFileForCurrentRun(repository, environment, input, {
        requestId: 'same-local-operation'
      })
    ).resolves.toEqual(persisted)
    await rm(sourcePath)
    await expect(
      writeArtifactFileForCurrentRun(repository, environment, input, {
        requestId: 'same-local-operation'
      })
    ).resolves.toEqual(persisted)

    expect(methods).toEqual([
      'artifactReplayVersion',
      'artifactCreateVersion',
      'artifactReplayVersion'
    ])
    expect(requests[1]?.params.sourceFileObservation).toEqual({
      path: resolvedSourcePath,
      sizeBytes: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs
    })
    expect(requests[1]?.params.sourceKind).toBe('localPath')
  })
})

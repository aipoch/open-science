import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ArtifactWriteSource } from '../../shared/artifacts'
import { ArtifactRepository } from './repository'

let storageRoot: string | undefined

const createRepository = async (): Promise<{ repository: ArtifactRepository; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-artifact-contract-'))
  storageRoot = root
  return { repository: new ArtifactRepository(root), root }
}

const inlineSource = (content: string): ArtifactWriteSource => ({
  kind: 'inline',
  content,
  encoding: 'utf8'
})

const provenanceContext = {
  rootFrameId: 'root-frame-1',
  agentFrameId: 'agent-frame-1',
  messageBranchId: 'branch-1',
  runtimeSegmentId: 'runtime-segment-1',
  promptMessageId: 'prompt-1'
}

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('ArtifactRepository storage compatibility contract', () => {
  it('keeps pending paths, publication markers, and finalized paths stable', async () => {
    const { repository, root } = await createRepository()
    const pending = await repository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'storage-session-1',
      runId: 'run-1',
      filename: 'report.txt',
      mimeType: 'text/plain',
      source: inlineSource('publication bytes')
    })
    const pendingDirectory = dirname(pending.path)
    const pendingMetadataPath = join(pendingDirectory, '.metadata', 'report.txt.json')

    expect(relative(root, pending.path).split(sep)).toEqual([
      'artifacts',
      'project-1',
      'storage-session-1',
      '.pending',
      'run-1',
      'report.txt'
    ])
    expect(pending).toMatchObject({
      id: 'storage-session-1:run-1:report.txt',
      sessionId: 'storage-session-1',
      runId: 'run-1',
      mimeType: 'text/plain'
    })
    await expect(readFile(pendingMetadataPath, 'utf8').then(JSON.parse)).resolves.toEqual({
      mimeType: 'text/plain'
    })

    await repository.prepareRunFinalization({
      projectId: 'project-1',
      sourceSessionId: 'storage-session-1',
      sessionId: 'app-session-1',
      runId: 'run-1',
      artifactVersionIds: ['version-2', 'version-1'],
      provenanceContext
    })

    const preparedMarker = {
      sessionId: 'app-session-1',
      artifactVersionIds: ['version-1', 'version-2'],
      provenanceContext
    }
    await expect(repository.listPendingRunPublications('project-1')).resolves.toEqual([
      {
        sourceSessionId: 'storage-session-1',
        runId: 'run-1',
        marker: preparedMarker
      }
    ])
    await expect(
      readFile(
        join(root, 'artifacts', 'project-1', 'storage-session-1', '.runs', 'run-1.json'),
        'utf8'
      ).then(JSON.parse)
    ).resolves.toEqual(preparedMarker)

    const [finalized] = await repository.finalizeRunArtifacts({
      projectId: 'project-1',
      sourceSessionId: 'storage-session-1',
      sessionId: 'app-session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    expect(relative(root, finalized.path).split(sep)).toEqual([
      'artifacts',
      'project-1',
      'app-session-1',
      'message-1',
      'report.txt'
    ])
    expect(finalized).toMatchObject({
      id: 'app-session-1:message-1:report.txt',
      sessionId: 'app-session-1',
      messageId: 'message-1',
      mimeType: 'text/plain'
    })
    await expect(readFile(finalized.path, 'utf8')).resolves.toBe('publication bytes')
    await expect(
      readFile(join(dirname(finalized.path), '.metadata', 'report.txt.json'), 'utf8').then(
        JSON.parse
      )
    ).resolves.toEqual({ mimeType: 'text/plain' })
    await expect(readdir(pendingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(repository.listPendingRunPublications('project-1')).resolves.toEqual([])
    await expect(repository.findRunFinalizationMarker('project-1', 'run-1')).resolves.toEqual({
      sourceSessionId: 'storage-session-1',
      sessionId: 'app-session-1',
      messageId: 'message-1',
      artifactVersionIds: ['version-1', 'version-2'],
      provenanceContext
    })
  })

  it('restores pending bytes and metadata when publication fails before routing is durable', async () => {
    const { repository } = await createRepository()
    const request = {
      projectId: 'project-1',
      sessionId: 'storage-session-1',
      runId: 'run-1',
      filename: 'result.txt'
    }
    const original = await repository.writePendingFile({
      ...request,
      mimeType: 'text/plain',
      source: inlineSource('original bytes')
    })

    await expect(
      repository.withPendingFileTransaction(
        { ...request, source: inlineSource('replacement bytes') },
        {},
        async () => {
          throw new Error('publication rejected')
        }
      )
    ).rejects.toThrow('publication rejected')

    await expect(readFile(original.path, 'utf8')).resolves.toBe('original bytes')
    await expect(repository.listPendingRunFiles(request)).resolves.toMatchObject([
      {
        id: 'storage-session-1:run-1:result.txt',
        path: original.path,
        mimeType: 'text/plain'
      }
    ])
    expect((await readdir(dirname(original.path))).sort()).toEqual(['.metadata', 'result.txt'])
    expect((await readdir(join(dirname(original.path), '.metadata'))).sort()).toEqual([
      'result.txt.json'
    ])
  })

  it('recovers a managed preview only after a prepared marker is bound to a message', async () => {
    const { repository, root } = await createRepository()
    const pending = await repository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'storage-session-1',
      runId: 'run-1',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      source: inlineSource('0123456789')
    })
    await repository.prepareRunFinalization({
      projectId: 'project-1',
      sourceSessionId: 'storage-session-1',
      sessionId: 'app-session-1',
      runId: 'run-1',
      provenanceContext
    })

    const finalPath = join(
      root,
      'artifacts',
      'project-1',
      'app-session-1',
      'message-1',
      'notes.txt'
    )
    await mkdir(dirname(finalPath), { recursive: true })
    await rename(pending.path, finalPath)

    await expect(repository.resolveManagedFilePath({ path: pending.path })).rejects.toMatchObject({
      code: 'ENOENT'
    })

    await repository.finalizeRunArtifacts({
      projectId: 'project-1',
      sourceSessionId: 'storage-session-1',
      sessionId: 'app-session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    const recoveredPath = await repository.resolveManagedFilePath({ path: pending.path })
    await expect(readFile(recoveredPath, 'utf8')).resolves.toBe('0123456789')
    await expect(
      readFile(join(dirname(finalPath), '.metadata', 'notes.txt.json'), 'utf8').then(JSON.parse)
    ).resolves.toEqual({ mimeType: 'text/plain' })
  })

  it('keeps finalized legacy files readable without metadata or publication markers', async () => {
    const { repository, root } = await createRepository()
    const legacyPath = join(
      root,
      'artifacts',
      'default-project',
      'legacy-session',
      'legacy-message',
      'legacy.txt'
    )
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(legacyPath, 'legacy content', 'utf8')

    const [legacy] = await repository.listMessageFiles({
      projectId: 'default-project',
      sessionId: 'legacy-session',
      messageId: 'legacy-message'
    })

    expect(legacy).toMatchObject({
      id: 'legacy-session:legacy-message:legacy.txt',
      path: legacyPath,
      sessionId: 'legacy-session',
      messageId: 'legacy-message'
    })
    expect(legacy.mimeType).toBeUndefined()
    expect(legacy.artifactId).toBeUndefined()
    expect(legacy.versionId).toBeUndefined()
    expect(legacy.versionNumber).toBeUndefined()
    await expect(
      repository.resolveSessionArtifactFilePath('default-project', 'legacy-session', legacyPath)
    ).resolves.toBe(await realpath(legacyPath))
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('legacy content')
    await expect(
      repository.findRunFinalizationMarker('default-project', 'legacy-run')
    ).resolves.toBeUndefined()
  })
})

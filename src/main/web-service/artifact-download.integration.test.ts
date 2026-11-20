import { configureTestElectronHost } from '../../../test/runtime-host'
import { initDataRoot } from '../storage-root'
// @ts-expect-error The published ESM entry uses a sibling index.d.ts.
import { OpenScienceClient } from '../../../packages/open-science/index.mjs'
// @ts-expect-error The public CLI entry is JavaScript.
import { parseCliArgs, runTaskCommand } from '../../../packages/open-science/cli.mjs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  protocol: {},
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: true, getPath: () => '/unused-artifact-download-config' }
}))

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ResolveArtifactVersionDescriptorsRequest } from '../../shared/artifacts'
import type {
  AcquireManagedPreviewRequest,
  ReleaseManagedPreviewRequest
} from '../../shared/preview-resources'
import { ApplicationEventHub } from '../application-events'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { createManagedPreviewOwnerRegistry } from '../managed-preview-ipc'
import { createManagedPreviewProtocolHandler } from '../managed-preview-protocol'
import { ManagedPreviewResources } from '../managed-preview-resources'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { SessionRepository } from '../session-persistence/repository'
import { startWebHttpServer } from './http-server'
import { HeadlessTaskApi } from './task-api'
import { createApplicationCommandRouter } from '../application-command-router'
import {
  dataContentApplicationCommands,
  registerDataContentApplicationCommands
} from '../data-content-application-commands'
import { createManagedFileVersionHandlers } from '../managed-file-versions/ipc'

it.each(['historical', 'native'] as const)(
  'downloads a %s Task artifact by its listed Version id through HTTP',
  async (identity) => {
    const fixture = await createProvenanceTestFixture()
    initDataRoot(fixture.storageRoot)
    const sessions = new SessionRepository(fixture.storageRoot)
    const messages: PersistedChatSession['messages'] = [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Save a report',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'answer-1',
        role: 'agent',
        content: 'Saved',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ]
    const conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages,
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 2
    })
    let session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Download fixture',
      cwd: fixture.storageRoot,
      status: 'idle',
      messages,
      conversationGraph,
      createdAt: 1,
      updatedAt: 2
    }
    const provenance = new ArtifactProvenanceRepository({
      ...fixture.repositoryOptions,
      loadSession: (projectId, sessionId) => sessions.loadSession(projectId, sessionId)
    })
    const versions = new ManagedFileVersionService({
      storageRoot: fixture.storageRoot,
      getClient: () => Promise.resolve(fixture.client)
    })
    const resources = new ManagedPreviewResources({
      resolvePath: async () => {
        throw new Error('Artifact downloads must use managed identities.')
      },
      openLatestManagedFile: (source, request) => versions.openLatest({ source, ...request }),
      openManagedFileVersion: (source, request) =>
        versions.openVersion({ source, ...request }, request.versionId)
    })
    const owners = createManagedPreviewOwnerRegistry(resources)
    const acquiredIds: string[] = []
    const router = createApplicationCommandRouter()
    const installation = registerDataContentApplicationCommands(router.registrar, {
      managedFileVersions: createManagedFileVersionHandlers(versions, {
        withDataRootWrite: (operation) => operation()
      })
    } as never)
    const tasks = new HeadlessTaskApi({
      commands: {
        commandNames: () => [],
        invoke: async (name, invocation) => {
          const { args, callerLease } = invocation
          if (name === 'sessions:load-all') return sessions.loadAll()
          if (name === 'artifacts:resolve-version-descriptors') {
            return provenance.resolveVersionDescriptors(
              args[0] as ResolveArtifactVersionDescriptorsRequest
            )
          }
          if (name === 'managed-file-versions:inspect') {
            // Preserve the production identity guard between HTTP and the managed service.
            return router.dispatcher.invoke(dataContentApplicationCommands.managedFileInspect, {
              ...invocation,
              args: [args[0] as Parameters<typeof versions.inspect>[0]]
            })
          }
          if (name === 'preview-resources:acquire') {
            const resource = await owners.acquire(
              callerLease,
              args[0] as AcquireManagedPreviewRequest
            )
            acquiredIds.push(resource.id)
            return resource
          }
          if (name === 'preview-resources:release') {
            return owners.release(callerLease, args[0] as ReleaseManagedPreviewRequest)
          }
          throw new Error(`Unexpected download command: ${name}`)
        }
      },
      agent: {} as never
    })
    // Capability resolution, verified file handles,
    // protocol streaming, HTTP and the public client execute their production implementations.
    const protocol = createManagedPreviewProtocolHandler(resources)
    let server: Awaited<ReturnType<typeof startWebHttpServer>> | undefined
    try {
      await fixture.client.project.create({ data: { id: 'project-1', name: 'Download fixture' } })
      await sessions.saveSession(session)
      const content = '# Synthetic report\n\nExact immutable bytes.\n'
      const context = {
        rootFrameId: conversationGraph.rootFrameId,
        agentFrameId: conversationGraph.activeFrameId,
        messageBranchId: conversationGraph.branches[0].id,
        runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
        promptMessageId: 'prompt-1'
      }
      await fixture.compatibilityRepository.writePendingFile({
        projectId: session.projectId,
        sessionId: session.id,
        runId: 'run-1',
        filename: 'report.html',
        source: { kind: 'inline', content, encoding: 'utf8' }
      })
      const version = await provenance.createVersion({
        projectId: session.projectId,
        appSessionId: session.id,
        artifactStorageSessionId: session.id,
        artifactRunId: 'run-1',
        writeOperationId: 'write-1',
        writeRequestChecksum: 'a'.repeat(64),
        ...context,
        filename: 'report.html',
        contentType: 'text/html'
      })
      const finalization = {
        projectId: session.projectId,
        appSessionId: session.id,
        artifactRunId: 'run-1',
        artifactVersionIds: [version.versionId],
        ...context,
        messageId: 'answer-1'
      }
      await provenance.finalizeRun(finalization)
      await provenance.activateFinalizedRun(finalization)
      // Reproduce the old Task projection: the row id is a Version id, but native identity
      // fields were omitted. Persist and reload it rather than supplying an acquisition stub.
      session = await sessions.saveSession({
        ...session,
        artifacts: [
          {
            id: version.id,
            ...(identity === 'native'
              ? { artifactId: version.artifactId, versionId: version.versionId }
              : {}),
            kind: 'managed-file',
            path: version.path,
            name: version.name,
            fileUrl: version.fileUrl,
            size: version.size,
            mimeType: version.mimeType
          }
        ]
      })
      // Publish another save under the same Lineage. The listed older Version must still
      // download its own bytes, rather than silently substituting the current head.
      await fixture.compatibilityRepository.writePendingFile({
        projectId: session.projectId,
        sessionId: session.id,
        runId: 'run-2',
        filename: 'report.html',
        source: { kind: 'inline', content: 'newer content', encoding: 'utf8' }
      })
      const newer = await provenance.createVersion({
        projectId: session.projectId,
        appSessionId: session.id,
        artifactStorageSessionId: session.id,
        artifactRunId: 'run-2',
        writeOperationId: 'write-2',
        writeRequestChecksum: 'b'.repeat(64),
        ...context,
        filename: 'report.html',
        contentType: 'text/html'
      })
      const newerFinalization = {
        ...finalization,
        artifactRunId: 'run-2',
        artifactVersionIds: [newer.versionId]
      }
      await provenance.finalizeRun(newerFinalization)
      await provenance.activateFinalizedRun(newerFinalization)
      expect(newer.artifactId).toBe(version.artifactId)
      expect(await readFile(version.path, 'utf8')).toBe(content)
      const emptyCommands = { commandNames: () => [], invoke: async () => undefined }
      let pairedCurrent = true
      let revokeOnOpen = false
      server = await startWebHttpServer({
        fetchPreview: async (request) => {
          const upstream = await protocol(request)
          if (revokeOnOpen) pairedCurrent = false
          return upstream
        },
        host: '127.0.0.1',
        port: 0,
        token: 'synthetic-download-token',
        staticRoot: fixture.storageRoot,
        applicationCommands: {
          localWeb: emptyCommands,
          remoteWeb: { ...emptyCommands, rejectedCommandNames: () => [] }
        },
        externalAccess: {
          authorizeHttp: async (request) =>
            request.headers.authorization === 'Bearer paired-fixture'
              ? {
                  kind: 'authorized',
                  principalId: 'paired-fixture',
                  isCurrent: () => pairedCurrent
                }
              : 'denied',
          authorizeWebSocket: async () => undefined
        },
        applicationEvents: new ApplicationEventHub(),
        tasks,
        bootstrap: {
          appName: 'Open-Science',
          appVersion: 'test',
          configRoot: fixture.storageRoot,
          platform: process.platform,
          versions: { electron: 'test', chrome: 'test', node: process.versions.node }
        }
      })
      const baseUrl = `http://127.0.0.1:${server.port}`
      expect((await fetch(`${baseUrl}/api/v1/artifacts/${version.id}/content`)).status).toBe(401)
      expect(acquiredIds).toEqual([])
      const client = new OpenScienceClient({ baseUrl, token: 'synthetic-download-token' })
      await expect(client.downloadArtifact('missing-version')).rejects.toMatchObject({
        status: 404,
        code: 'artifact_not_found'
      })
      await expect(client.downloadArtifact(version.artifactId)).rejects.toMatchObject({
        status: 404,
        code: 'artifact_not_found'
      })
      const listed = await client.listArtifacts(session.id)
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        id: version.versionId,
        artifactId: version.artifactId,
        versionId: version.versionId,
        artifactRunId: 'run-1',
        size: Buffer.byteLength(content),
        sha256: version.checksum
      })
      const httpResponse = await fetch(`${baseUrl}/api/v1/artifacts/${listed[0].id}/content`, {
        headers: { authorization: 'Bearer paired-fixture' }
      })
      const httpBody = await httpResponse.text()
      expect({ status: httpResponse.status, body: httpBody }).toEqual({
        status: 200,
        body: content
      })
      const response = await client.downloadArtifact(listed[0].id)
      const bytes = Buffer.from(await response.arrayBuffer())
      expect(bytes.toString()).toBe(content)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(version.checksum)
      expect(response.headers.get('content-disposition')).toContain('report.html')
      const output = join(fixture.storageRoot, 'downloaded-report.md')
      const log = vi.fn()
      await runTaskCommand(parseCliArgs(['tools', 'call', 'download_artifact', '--json']), {
        connect: async () => client,
        stdinIsTTY: false,
        readStdin: async () =>
          JSON.stringify({
            sessionId: session.id,
            downloadId: listed[0].id,
            outputPath: output
          }),
        log
      })
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
        result: { path: output, bytes: bytes.length, sha256: version.checksum, verified: true }
      })
      expect(await readFile(output)).toEqual(bytes)
      expect(acquiredIds).toHaveLength(3)
      for (const resourceId of acquiredIds) {
        await expect(resources.resolveProtocolResource(resourceId)).rejects.toThrow()
      }
      // The head is absent from the Task list, but browser previews resolve its exact managed identity.
      const inlineUrl = (versionNumber?: number, fileId = version.artifactId): string =>
        `${baseUrl}/api/v1/artifacts/${fileId}/content?disposition=inline${versionNumber === undefined ? '' : `&version=${versionNumber}`}&token=synthetic-download-token`
      for (const [versionNumber, expected] of [
        [version.versionNumber, content],
        [newer.versionNumber, 'newer content']
      ] as Array<[number, string]>) {
        const inline = await fetch(inlineUrl(versionNumber))
        expect(inline.status).toBe(200)
        expect(await inline.text()).toBe(expected)
        expect(inline.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(inline.headers.get('content-disposition')).toBe('inline')
        expect(inline.headers.get('referrer-policy')).toBe('no-referrer')
        const head = await fetch(inlineUrl(versionNumber), { method: 'HEAD' })
        expect(head.status).toBe(200)
        for (const header of [
          'content-type',
          'content-disposition',
          'content-length',
          'referrer-policy'
        ]) {
          expect(head.headers.get(header)).toBe(inline.headers.get(header))
        }
      }
      const latestInline = await fetch(inlineUrl())
      expect(latestInline.status).toBe(200)
      expect(await latestInline.text()).toBe('newer content')
      const latestHead = await fetch(inlineUrl(), { method: 'HEAD' })
      expect(latestHead.status).toBe(200)
      for (const header of [
        'content-type',
        'content-disposition',
        'content-length',
        'referrer-policy'
      ]) {
        expect(latestHead.headers.get(header)).toBe(latestInline.headers.get(header))
      }
      // Web tabs use the existing login cookie, without copying credentials into the new URL.
      const login = await fetch(`${baseUrl}/?token=synthetic-download-token`, {
        redirect: 'manual'
      })
      expect(login.status).toBe(302)
      const cookie = login.headers.get('set-cookie')!.split(';')[0]
      for (const [versionNumber, expected] of [
        [undefined, 'newer content'],
        [version.versionNumber, content]
      ] as const) {
        const webUrl = new URL(inlineUrl(versionNumber))
        webUrl.searchParams.delete('token')
        for (const method of ['HEAD', 'GET']) {
          const webPreview = await fetch(webUrl, { method, headers: { cookie } })
          expect(webPreview.status).toBe(200)
          expect(webPreview.headers.get('content-type')).toBe('text/html; charset=utf-8')
          expect(webPreview.headers.get('content-disposition')).toBe('inline')
          expect(await webPreview.text()).toBe(method === 'GET' ? expected : '')
        }
      }
      for (const url of [inlineUrl(newer.versionNumber, 'missing-file'), inlineUrl(99)]) {
        expect((await fetch(url)).ok).toBe(false)
      }
      for (const method of ['GET', 'HEAD']) {
        for (const value of ['0', 'not-a-number']) {
          const malformed = new URL(inlineUrl())
          malformed.searchParams.set('version', value)
          expect((await fetch(malformed, { method })).status).toBe(400)
        }
      }
      const downloadWithScope = await fetch(
        inlineUrl(newer.versionNumber).replace('disposition=inline', 'disposition=attachment')
      )
      expect(downloadWithScope.status).toBe(404)
      for (const resourceId of acquiredIds) {
        await expect(resources.resolveProtocolResource(resourceId)).rejects.toThrow()
      }
      // Losing authorization after opening the file must still retire its remote owner's resource.
      for (const endpoint of [
        `${baseUrl}/api/v1/artifacts/${listed[0].id}/content`,
        `${baseUrl}/api/v1/artifacts/${version.artifactId}/content?disposition=inline`,
        `${baseUrl}/api/v1/artifacts/${version.artifactId}/content?disposition=inline&version=${version.versionNumber}`
      ]) {
        const beforeRevocation = acquiredIds.length
        pairedCurrent = true
        revokeOnOpen = true
        const revoked = await fetch(endpoint, {
          headers: { authorization: 'Bearer paired-fixture' }
        })
        expect(revoked.status).toBe(401)
        expect(acquiredIds).toHaveLength(beforeRevocation + 1)
        await expect(
          resources.resolveProtocolResource(acquiredIds[beforeRevocation])
        ).rejects.toThrow()
      }
      revokeOnOpen = false
      const successfulAcquisitions = acquiredIds.length
      // The same Session record must not make finalized-but-unpublished bytes downloadable.
      await fixture.client.artifactVersion.update({
        where: { id: version.versionId },
        data: { managedVisibleAt: null }
      })
      await expect(client.downloadArtifact(listed[0].id)).rejects.toMatchObject({ status: 500 })
      expect((await fetch(inlineUrl(version.versionNumber))).ok).toBe(false)
      expect(acquiredIds).toHaveLength(successfulAcquisitions)
      await fixture.client.artifactVersion.update({
        where: { id: version.versionId },
        data: { managedVisibleAt: new Date() }
      })
      await fixture.client.project.create({ data: { id: 'other-project', name: 'Other project' } })
      await fixture.client.fileOriginSession.create({
        data: { projectId: 'other-project', sessionId: session.id }
      })
      await fixture.client.artifactLineage.update({
        where: { id: version.artifactId },
        data: { projectId: 'other-project' }
      })
      // A listed id and a known path cannot grant access across the Session's Project boundary.
      await expect(client.downloadArtifact(listed[0].id)).rejects.toMatchObject({ status: 500 })
      expect(acquiredIds).toHaveLength(successfulAcquisitions)
      // Browser URLs resolve the globally unique artifactId without exposing project identity.
      const movedInline = await fetch(inlineUrl(version.versionNumber))
      expect(movedInline.status).toBe(200)
      expect(await movedInline.text()).toBe(content)
      // Download must not repair historical records by writing back to Session storage.
      expect((await sessions.loadSession(session.projectId, session.id))?.artifacts).toEqual(
        session.artifacts
      )
    } finally {
      await server?.close()
      await tasks.dispose()
      installation.uninstall()
      router.dispose()
      await fixture.dispose()
    }
  },
  // Exercise the real publication retry window as well as SQLite setup on slower CI hosts.
  30_000
)

await configureTestElectronHost(await import('electron'))

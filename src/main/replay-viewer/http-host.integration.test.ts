import { request, type IncomingHttpHeaders } from 'node:http'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createCallerContext, type CallerContext } from '../caller-context'
import { RunObservationOwner, type RunObservationSource } from '../run-observation/owner'
import { ObservationViewers } from '../run-observation/viewers'
import {
  recordedFixture,
  projectRecordedFixture
} from '../run-observation/recorded-viewer.test-support'
import { recordedFileSelectionForPayload } from '../../shared/run-observation-recorded'
import { browserRecordedFixture } from '../run-observation/browser-recorded.test-support'
import type { RuntimeViewAccess } from '../../shared/runtime-view'
import type { RunObservationSnapshot } from '../../shared/run-observation'
import {
  desktopObservationFrameRegistry,
  type DesktopObservationFrame
} from './desktop-frame-registry'
import {
  ReplayViewerHttpHost,
  type ReplayViewerHttpAccess,
  type ReplayViewerHttpDependencies,
  type ReplayViewerHttpOpenOptions
} from './http-host'

const scope = { projectId: 'project-a', sessionId: 'session-a', operationId: 'operation-a' }
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const caller = (current: () => boolean): CallerContext =>
  createCallerContext({
    clientId: 'client-a',
    lifecycleClientId: 'lifecycle-a',
    leaseId: 'lease-a',
    surface: 'task',
    location: 'local',
    principalKind: 'automation',
    actionOrigin: 'automation',
    isAuthorizationCurrent: current
  })
type Harness = {
  host: ReplayViewerHttpHost
  viewers: ObservationViewers
  owner: CallerContext
  source: RunObservationSource
  projectOpen: Mock<ReplayViewerHttpDependencies['projectViews']['open']>
  projectClose: Mock<ReplayViewerHttpDependencies['projectViews']['closeViewer']>
  readAsset: Mock<ReplayViewerHttpDependencies['readAsset']>
  readArtifact: Mock<NonNullable<ReplayViewerHttpDependencies['readArtifact']>>
  cancel: Mock<NonNullable<ReplayViewerHttpDependencies['cancelRun']>>
  setAuthorized(value: boolean): void
}
function harness(
  options: {
    readAsset?: ReplayViewerHttpDependencies['readAsset']
    cancel?: boolean
    lifetimeMs?: number
    recorded?: boolean | 'project' | 'browser'
    browserRecording?: ReplayViewerHttpDependencies['browserRecording']
    capture?: ReplayViewerHttpDependencies['capture']
    listCaptures?: ReplayViewerHttpDependencies['listCaptures']
    readCapture?: ReplayViewerHttpDependencies['readCapture']
    recordingStatus?: ReplayViewerHttpDependencies['recordingStatus']
    desktopLocale?: ReplayViewerHttpDependencies['desktopLocale']
    desktopFrames?: ReplayViewerHttpDependencies['desktopFrames']
  } = {}
): Harness {
  let authorized = true
  const source: RunObservationSource = {
    identity: { ...scope, runId: 'run-a', executionInvocationId: 'invocation-a' },
    phase: 'running',
    artifacts: [
      { versionId: 'version-a', name: 'result.html', mimeType: 'text/html', producerRunId: 'run-a' }
    ],
    run: {
      runId: 'run-a',
      executionInvocationId: 'invocation-a',
      cellId: 'cell-a',
      source: 'agent',
      kernelKind: 'bash',
      script: 'private source',
      status: 'running',
      startedAt: 100,
      text: { stdout: 'first', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }
  }
  const observer: RunObservationOwner = new RunObservationOwner({
    authorize: (target, view) => viewers.assertViewer(target, view),
    read: async () => source
  })
  const viewers: ObservationViewers = new ObservationViewers({
    observer,
    ...(options.recorded
      ? {
          recorded: {
            authorizeScope: async () => undefined,
            read: async (target) => ({ ...recordedFixture().payload, receiving: target }),
            readProject: async (target) => ({
              ...projectRecordedFixture().payload,
              receiving: target
            }),
            readBrowser: async (target) => ({
              ...browserRecordedFixture().payload,
              receiving: target
            }),
            selectBrowserMoment: async (target, offsetMs) => ({
              ...browserRecordedFixture().moment,
              receiving: target,
              offsetMs,
              segmentOffsetMs: offsetMs
            }),
            selectFile: async (target, mediaKey, format) =>
              recordedFileSelectionForPayload(
                {
                  ...(format === 'project-recording'
                    ? projectRecordedFixture().payload
                    : recordedFixture().payload),
                  receiving: target
                },
                mediaKey
              )
          }
        }
      : {}),
    authorizeScope: async () => undefined,
    onRevoked: (viewerId) => host.closeViewer(viewerId),
    limits: { lifetimeMs: options.lifetimeMs }
  })
  cleanup.push(() => viewers.close())
  const projectOpen = vi.fn<ReplayViewerHttpDependencies['projectViews']['open']>(
    async (runScope) =>
      ({
        view: {
          viewId: 'view-a',
          scope: { ...runScope, environmentId: 'env-a', generationId: 'generation-a' },
          title: 'Project',
          state: 'ready',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1000).toISOString(),
          embeddingAdapted: true
        },
        url: 'http://rv-view-a.localhost:5001/private-test-grant'
      }) satisfies RuntimeViewAccess
  )
  const projectClose = vi.fn<ReplayViewerHttpDependencies['projectViews']['closeViewer']>()
  const readArtifact = vi.fn<NonNullable<ReplayViewerHttpDependencies['readArtifact']>>(
    async () => ({ body: Buffer.from('<script>unsafe()</script>'), mimeType: 'text/html' })
  )
  const cancel = vi.fn<NonNullable<ReplayViewerHttpDependencies['cancelRun']>>(
    async () => undefined
  )
  const readAsset = vi.fn<ReplayViewerHttpDependencies['readAsset']>(
    options.readAsset ??
      (async (path) =>
        path === 'index.html'
          ? { body: Buffer.from('<h1>Viewer</h1>'), mimeType: 'text/html; charset=utf-8' }
          : path === 'assets/main.js'
            ? { body: Buffer.from('console.log("viewer")'), mimeType: 'application/javascript' }
            : undefined)
  )
  const host: ReplayViewerHttpHost = new ReplayViewerHttpHost({
    desktopFrames: options.desktopFrames ?? desktopObservationFrameRegistry,
    desktopLocale: options.desktopLocale,
    browserRecording: options.browserRecording,
    ...(options.capture
      ? {
          capture: options.capture,
          captureOptions: async () => ({ hostView: false, projectExports: ['frame.png'] })
        }
      : {}),
    listCaptures: options.listCaptures,
    readCapture: options.readCapture,
    recordingStatus: options.recordingStatus,
    viewers,
    projectViews: { open: projectOpen, closeViewer: projectClose },
    readAsset,
    readArtifact,
    ...(options.recorded
      ? {
          readRecordingMedia: async (_target, _key, _signal, format) =>
            format === 'web-recording'
              ? { body: browserRecordedFixture().bytes, mimeType: 'video/webm' }
              : { body: recordedFixture().bytes, mimeType: 'text/html' }
        }
      : {}),
    ...(options.cancel ? { cancelRun: cancel } : {})
  })
  cleanup.push(() => host.close())
  const owner = caller(() => authorized)
  return {
    host,
    viewers,
    owner,
    source,
    projectOpen,
    projectClose,
    readAsset,
    readArtifact,
    cancel,
    setAuthorized: (value: boolean): void => {
      authorized = value
    }
  }
}
type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string }
async function http(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; path?: string } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const pending = request(
      url,
      {
        family: 4,
        lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4),
        method: options.method ?? 'GET',
        headers: options.headers,
        ...(options.path ? { path: options.path } : {})
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks).toString()
          })
        )
      }
    )
    pending.on('error', reject)
    pending.end(options.body)
  })
}
async function open(
  h: ReturnType<typeof harness>,
  options: ReplayViewerHttpOpenOptions = {}
): Promise<{
  access: ReplayViewerHttpAccess
  origin: string
  cookie: string
  boot: HttpResult
  get(path: string): Promise<HttpResult>
  post(path: string, body: unknown): Promise<HttpResult>
}> {
  const access = await h.host.open(scope, h.owner, options)
  const boot = await http(access.url)
  expect(boot.status).toBe(303)
  const cookie = boot.headers['set-cookie']![0].split(';')[0]
  const origin = new URL(access.url).origin
  return {
    access,
    origin,
    cookie,
    boot,
    get: (path: string) => http(origin + path, { headers: { cookie } }),
    post: (path: string, body: unknown) =>
      http(origin + path, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
  }
}
describe('isolated Replay viewer HTTP host', () => {
  it('requires separate recording permission and explicitly binds a same-execution desktop source for SDK control', async () => {
    const control = vi.fn<NonNullable<ReplayViewerHttpDependencies['browserRecording']>>(
      async (method) =>
        method === 'inspect'
          ? { supported: false, reason: 'desktop-required' }
          : {
              state: 'recording',
              recordingId: 'recording-a',
              elapsedMs: 10,
              segments: 0,
              bytes: 0,
              droppedFrames: 0
            }
    )
    const h = harness({ browserRecording: control })
    const denied = await open(h)
    expect((await denied.get('/api/project-recordings/inspect')).status).toBe(403)
    const desktopCaller = createCallerContext({
      ...h.owner,
      clientId: 'desktop-client',
      leaseId: 'desktop-lease',
      surface: 'electron'
    })
    const desktop = await h.host.open(
      { ...scope, executionInvocationId: 'invocation-a', runId: 'run-a' },
      desktopCaller,
      {
        allowRecording: true,
        allowInteraction: true
      }
    )
    const boot = await http(desktop.url)
    const cookie = boot.headers['set-cookie']![0].split(';')[0]
    const origin = new URL(desktop.url).origin
    expect(
      (
        await http(origin + '/api/project-view', {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/json' },
          body: '{}'
        })
      ).status
    ).toBe(200)
    const sdk = await open(h, { allowRecording: true })
    expect(JSON.parse((await sdk.get('/api/project-recordings/inspect')).body)).toMatchObject({
      sources: [{ sourceViewId: desktop.viewerId, label: 'Desktop project page' }]
    })
    expect(
      (
        await sdk.post('/api/project-recordings/start', {
          requestId: 'start',
          sourceViewId: desktop.viewerId
        })
      ).status
    ).toBe(200)
    expect(control).toHaveBeenLastCalledWith(
      'start',
      expect.objectContaining({
        viewerId: sdk.access.viewerId,
        target: scope,
        host: expect.objectContaining({
          viewerOrigin: origin,
          caller: expect.objectContaining({ surface: 'electron' })
        })
      })
    )
    const foreign = await h.host.open({ ...scope, sessionId: 'foreign-session' }, desktopCaller, {
      allowRecording: true
    })
    expect(
      (
        await sdk.post('/api/project-recordings/start', {
          requestId: 'bad-source',
          sourceViewId: foreign.viewerId
        })
      ).status
    ).toBe(403)
    const anotherRun = await h.host.open({ ...scope, runId: 'run-b' }, desktopCaller, {
      allowRecording: true
    })
    expect(
      (
        await sdk.post('/api/project-recordings/start', {
          requestId: 'other-run',
          sourceViewId: anotherRun.viewerId
        })
      ).status
    ).not.toBe(200)
    control.mockImplementationOnce(async () => {
      Object.assign(h.source, { identity: { ...h.source.identity, runId: 'replacement-run' } })
      h.source.run!.runId = 'replacement-run'
      return {
        state: 'recording',
        recordingId: 'replacement-recording',
        elapsedMs: 0,
        segments: 0,
        bytes: 0,
        droppedFrames: 0
      }
    })
    expect(
      (
        await sdk.post('/api/project-recordings/start', {
          requestId: 'stale-start',
          sourceViewId: desktop.viewerId
        })
      ).status
    ).toBe(403)
    expect(control).toHaveBeenLastCalledWith(
      'stop',
      expect.objectContaining({
        viewerId: sdk.access.viewerId,
        request: expect.objectContaining({ recordingId: 'replacement-recording' })
      })
    )
    Object.assign(h.source, { identity: { ...h.source.identity, runId: 'run-a' } })
    h.source.run!.runId = 'run-a'
    h.host.closeViewer(desktop.viewerId)
    expect((await sdk.get('/api/project-recordings/status')).status).toBe(200)
    expect(control).toHaveBeenLastCalledWith(
      'status',
      expect.objectContaining({ viewerId: sdk.access.viewerId })
    )
    expect(
      (
        await sdk.post('/api/project-recordings/stop', {
          requestId: 'stop',
          recordingId: 'recording-a'
        })
      ).status
    ).toBe(200)
  })
  it('opens a published archive on a new browser viewer from the current bound receipt without opening any project service', async () => {
    const archive = {
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      artifactId: 'archive-artifact',
      versionId: 'archive-version'
    }
    const h = harness({
      recorded: true,
      recordingStatus: async () => ({ target: scope, state: 'saved', archive })
    })
    h.source.run!.status = 'completed'
    const v = await open(h)
    expect(JSON.parse((await v.get('/api/context')).body).presentation).toBe('browser')
    const response = await v.post('/api/open-archive', {})
    expect(response.status).toBe(200)
    const access = JSON.parse(response.body) as ReplayViewerHttpAccess
    expect(access).toMatchObject({ mode: 'recorded', target: archive })
    expect(access.viewerId).not.toBe(v.access.viewerId)
    const boot = await http(access.url)
    expect(boot.status).toBe(303)
    const cookie = boot.headers['set-cookie']![0].split(';')[0]
    const origin = new URL(access.url).origin
    const recorded = await http(origin + '/api/recording', { headers: { cookie } })
    expect(recorded.status).toBe(200)
    expect(JSON.parse(recorded.body).receiving).toEqual(archive)
    const selected = await http(origin + '/api/recording/select', {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ stepKey: 'observation-0' })
    })
    expect(selected.status).toBe(200)
    expect(JSON.parse(selected.body).receiving).toEqual(archive)
    expect((await v.post('/api/open-archive', { target: archive })).status).toBe(400)
    expect(h.projectOpen).not.toHaveBeenCalled()
    expect(h.cancel).not.toHaveBeenCalled()
  })

  it.each(['saving', 'failed', 'not-recorded', 'foreign-target', 'foreign-archive'] as const)(
    'rejects archive transition without this exact published receipt: %s',
    async (state) => {
      const archive = {
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        artifactId: 'archive-artifact',
        versionId: 'archive-version'
      }
      const h = harness({
        recorded: true,
        recordingStatus: async () =>
          state === 'foreign-target'
            ? { target: { ...scope, operationId: 'other-operation' }, state: 'saved', archive }
            : state === 'foreign-archive'
              ? {
                  target: scope,
                  state: 'saved',
                  archive: { ...archive, sessionId: 'other-session' }
                }
              : { target: scope, state }
      })
      const create = vi.spyOn(h.viewers, 'createRecorded')
      const v = await open(h)
      expect((await v.post('/api/open-archive', {})).status).toBe(409)
      expect(create).not.toHaveBeenCalled()
      expect(h.projectOpen).not.toHaveBeenCalled()
    }
  )

  it.each(['live', 'recorded'] as const)(
    'projects Main desktop language only to %s Electron viewers',
    async (mode) => {
      const h = harness({ recorded: true, desktopLocale: () => 'zh-Hans' })
      const owner = createCallerContext({ ...h.owner, surface: 'electron', clientId: '17' })
      const archive = {
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        artifactId: 'a',
        versionId: 'v'
      }
      const access =
        mode === 'recorded'
          ? await h.host.openRecorded(archive, owner, { desktopParent: 'file:' })
          : await h.host.open(scope, owner, { desktopParent: 'file:' })
      const boot = await http(access.url)
      const cookie = boot.headers['set-cookie']![0].split(';')[0]
      expect(
        JSON.parse(
          (await http(new URL(access.url).origin + '/api/context', { headers: { cookie } })).body
        )
      ).toMatchObject({ presentation: 'desktop', locale: 'zh-Hans' })
      const browser = await open(h)
      expect(JSON.parse((await browser.get('/api/context')).body)).not.toHaveProperty('locale')
    }
  )

  it('does not let an Electron iframe silently replace the outer selection owner', async () => {
    const archive = {
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      artifactId: 'a',
      versionId: 'v'
    }
    const h = harness({
      recorded: true,
      recordingStatus: async () => ({ target: scope, state: 'saved', archive })
    })
    const owner = createCallerContext({ ...h.owner, surface: 'electron', clientId: '17' })
    const access = await h.host.open(scope, owner, { desktopParent: 'file:' })
    const boot = await http(access.url)
    const cookie = boot.headers['set-cookie']![0].split(';')[0]
    const origin = new URL(access.url).origin
    expect(
      JSON.parse((await http(origin + '/api/context', { headers: { cookie } })).body).presentation
    ).toBe('desktop')
    expect(
      (
        await http(origin + '/api/open-archive', {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/json' },
          body: '{}'
        })
      ).status
    ).toBe(403)
    expect(h.projectOpen).not.toHaveBeenCalled()
  })

  it('rechecks original caller authorization after archive status is read', async () => {
    const archive = {
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      artifactId: 'a',
      versionId: 'v'
    }
    const h = harness({
      recorded: true,
      recordingStatus: async () => {
        h.setAuthorized(false)
        return { target: scope, state: 'saved', archive }
      }
    })
    const create = vi.spyOn(h.viewers, 'createRecorded')
    const v = await open(h)
    // Revocation can close the in-flight socket as well as rejecting the HTTP response.
    await expect(v.post('/api/open-archive', {}).then((response) => response.status)).resolves.toBe(
      401
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('closes viewer resources when asynchronous native grant admission fails', async () => {
    const close = vi.fn()
    const h = harness({
      desktopFrames: {
        registerViewer: async () => ({
          issueGrant: async () => {
            throw new Error('native document ended')
          },
          authenticateGrant: () => undefined,
          close
        }),
        registerRuntime: () => undefined
      }
    })
    const owner = createCallerContext({ ...h.owner, surface: 'electron', clientId: '17' })
    await expect(h.host.open(scope, owner, { desktopParent: 'file:' })).rejects.toThrow(
      'native document ended'
    )
    expect(close).toHaveBeenCalledOnce()
    expect(h.projectClose).toHaveBeenCalledOnce()
  })

  it('registers desktop navigation only for its actual Electron owner and HTTP-authenticated frame', async () => {
    const h = harness()
    const owner = createCallerContext({ ...h.owner, surface: 'electron', clientId: '17' })
    const access = await h.host.open(scope, owner, { desktopParent: 'file:' })
    const origin = new URL(access.url).origin
    const mainFrame: DesktopObservationFrame = {
      frameTreeNodeId: 100,
      url: 'file:///app/index.html',
      parent: null
    }
    const frame: DesktopObservationFrame = {
      frameTreeNodeId: 101,
      url: 'about:blank',
      parent: mainFrame
    }
    const allows = (url: string, webContentsId = 17): boolean =>
      desktopObservationFrameRegistry.allows({ url, webContentsId, frame, mainFrame })
    expect(allows(access.url, 18)).toBe(false)
    expect(allows(origin + '/')).toBe(false)
    expect(allows(access.url)).toBe(true)
    expect(allows(origin + '/')).toBe(false)
    expect((await http(access.url)).status).toBe(303)
    expect(allows(origin + '/')).toBe(true)
    expect(allows(access.url)).toBe(false)
    h.setAuthorized(false)
    expect(allows(origin + '/')).toBe(false)
    h.setAuthorized(true)
    await h.viewers.revoke(access.viewerId, { caller: owner })
    expect(allows(origin + '/')).toBe(false)
  })

  it('does not register an external SDK viewer as an Electron iframe capability', async () => {
    const h = harness()
    const access = await h.host.open(scope, h.owner, { desktopParent: 'file:' })
    const mainFrame: DesktopObservationFrame = {
      frameTreeNodeId: 100,
      url: 'file:///app/index.html',
      parent: null
    }
    expect(
      desktopObservationFrameRegistry.allows({
        url: access.url,
        webContentsId: 17,
        frame: { frameTreeNodeId: 101, url: 'about:blank', parent: mainFrame },
        mainFrame
      })
    ).toBe(false)
  })

  it('keeps capture permission separate and binds saved images to an actual viewer observation without guessing cursors', async () => {
    const image = Buffer.from('verified fixture bytes')
    let result:
      import('../../shared/run-observation-capture').ObservationMediaCaptureResult | undefined
    const capture = vi.fn<NonNullable<ReplayViewerHttpDependencies['capture']>>(async (input) => {
      input.assertAuthorized()
      const created = result === undefined
      result ??= {
        captureId: 'a'.repeat(64),
        recordingId: 'recording',
        stepKey: 'observation-99',
        artifactId: 'artifact',
        versionId: 'version',
        checksum: createHash('sha256').update(image).digest('hex'),
        sizeBytes: image.length,
        mimeType: 'image/png',
        publication: 'awaiting-publication',
        capture: {
          source: 'project-export',
          association: 'current-observation',
          startedAt: Date.now(),
          finishedAt: Date.now(),
          observedAt: 1,
          width: 1,
          height: 1
        }
      }
      return { result, created }
    })
    const h = harness({
      capture,
      listCaptures: async () => (result ? [result] : []),
      readCapture: async (_target, id) =>
        id === result?.captureId ? { body: image, mimeType: 'image/png' } : undefined,
      recordingStatus: async (target) => ({ target, state: 'recording' })
    })
    const readOnly = await open(h)
    const request = { source: 'project-export', exportKey: 'frame.png', idempotencyKey: 'first' }
    expect((await readOnly.post('/api/capture', request)).status).toBe(403)
    expect(capture).not.toHaveBeenCalled()
    const v = await open(h, { allowCapture: true })
    expect(JSON.parse((await v.get('/api/capture-options')).body)).toEqual({
      hostView: false,
      projectExports: ['frame.png']
    })
    expect(JSON.parse((await v.get('/api/recording-status')).body)).toMatchObject({
      target: scope,
      state: 'recording'
    })
    expect((await v.post('/api/capture', { ...request, stepKey: 'old-step' })).status).toBe(400)
    expect(
      (await v.post('/api/capture', { source: 'host-view', idempotencyKey: 'host' })).status
    ).toBe(403)
    const captured = await v.post('/api/capture', request)
    expect(captured.status).toBe(200)
    const frame = JSON.parse(captured.body)
    const snapshot = JSON.parse((await v.get('/api/snapshot')).body)
    expect(frame.viewerEvidence).toEqual({
      cursor: snapshot.cursor,
      observedAt: snapshot.observedAt,
      stepId: snapshot.stepId
    })
    expect(frame.stepKey).toBe('observation-99')
    expect(frame.viewerEvidence.cursor.sequence).not.toBe(99)
    expect(capture.mock.calls[0][0]).toMatchObject({ target: scope, request })
    expect(capture.mock.calls[0][0].host).toBeUndefined()
    h.source.run!.text!.stdout = 'changed after capture'
    expect(JSON.parse((await v.post('/api/capture', request)).body).viewerEvidence).toEqual(
      frame.viewerEvidence
    )
    expect(JSON.parse((await v.get('/api/captures')).body)).toEqual([frame])
    expect(await h.host.captures(v.access.viewerId, h.owner)).toEqual([frame])
    const firstChunk = await h.host.captureContent(
      v.access.viewerId,
      { captureId: frame.captureId, length: 5 },
      h.owner
    )
    expect(firstChunk).toMatchObject({
      captureId: frame.captureId,
      checksum: frame.checksum,
      offset: 0,
      dataBase64: image.subarray(0, 5).toString('base64'),
      nextOffset: 5
    })
    const lastChunk = await h.host.captureContent(
      v.access.viewerId,
      { captureId: frame.captureId, offset: firstChunk.nextOffset },
      h.owner
    )
    expect(lastChunk.nextOffset).toBeUndefined()
    expect(
      Buffer.concat([
        Buffer.from(firstChunk.dataBase64, 'base64'),
        Buffer.from(lastChunk.dataBase64, 'base64')
      ])
    ).toEqual(image)
    await expect(
      h.host.captureContent(
        v.access.viewerId,
        { captureId: frame.captureId, offset: image.length + 1 },
        h.owner
      )
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      h.host.captureContent(
        v.access.viewerId,
        { captureId: frame.captureId, length: 1048577 },
        h.owner
      )
    ).rejects.toThrow()
    const another = await open(h, { allowCapture: true })
    const retriedElsewhere = JSON.parse((await another.post('/api/capture', request)).body)
    expect(retriedElsewhere.captureId).toBe(frame.captureId)
    expect(retriedElsewhere.viewerEvidence).toBeUndefined()
    expect(
      (await h.host.captures(readOnly.access.viewerId, h.owner))[0].viewerEvidence
    ).toBeUndefined()
    const media = await v.get('/api/capture-media?captureId=' + frame.captureId)
    expect(media.status).toBe(200)
    expect(media.body).toBe(image.toString())
    expect(media.headers['content-security-policy']).toContain("default-src 'none'")
    expect((await v.get('/api/capture-media?captureId=' + 'f'.repeat(64))).status).toBe(404)
    expect((await http(v.origin + '/api/capture-media?captureId=' + frame.captureId)).status).toBe(
      401
    )
    await expect(
      h.host.capture(
        v.access.viewerId,
        request,
        createCallerContext({ ...h.owner, clientId: 'other' })
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      h.host.captureContent(
        v.access.viewerId,
        { captureId: frame.captureId },
        createCallerContext({ ...h.owner, clientId: 'other' })
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    h.setAuthorized(false)
    await expect(h.host.captures(v.access.viewerId, h.owner)).rejects.toMatchObject({
      code: 'unauthorized'
    })
  })
  it('exchanges a one-use grant for HttpOnly partitioned access and exposes only fixed viewer scope', async () => {
    const h = harness(),
      v = await open(h, { desktopParent: 'file:' })
    expect(v.origin).toMatch(/^http:\/\/viewer-[a-f0-9-]+\.localhost:\d+$/)
    expect(v.boot.headers['set-cookie']![0]).toContain(
      'HttpOnly; Secure; SameSite=None; Partitioned'
    )
    expect((await http(v.access.url)).status).toBe(401)
    expect((await http(v.origin + '/api/snapshot')).status).toBe(401)
    const context = JSON.parse((await v.get('/api/context')).body)
    expect(context).toMatchObject({
      viewerId: v.access.viewerId,
      target: scope,
      canInteract: false,
      canCancel: false,
      canReadArtifacts: true
    })
    expect(context.capability).toBeUndefined()
    const snapshot = JSON.parse((await v.get('/api/snapshot')).body) as RunObservationSnapshot
    expect(snapshot.run?.runId).toBe('run-a')
    expect(JSON.stringify(snapshot)).not.toContain('private source')
    expect((await v.get('/api/snapshot?sessionId=foreign')).status).toBe(400)
    expect(
      (await v.post('/api/changes', { cursor: snapshot.cursor, sessionId: 'foreign' })).status
    ).toBe(400)
    expect(
      (
        await http(v.origin + '/api/snapshot', {
          headers: { cookie: v.cookie, host: 'attacker.invalid' }
        })
      ).status
    ).toBe(403)
  })
  it('serves only declared packaged assets, revalidates cookies for assets and rejects traversal/global routes', async () => {
    const h = harness(),
      v = await open(h, { desktopParent: 'file:' })
    const entry = await v.get('/')
    expect(entry.status).toBe(200)
    expect(entry.headers['content-security-policy']).toContain('frame-ancestors file:')
    expect(entry.headers['content-security-policy']).toContain('frame-src http://*.localhost:*')
    expect((await v.get('/assets/main.js')).status).toBe(200)
    for (const path of [
      '/api/settings',
      '/api/execute',
      '/config.json',
      '/assets/main.js.map',
      '/assets/%2e%2e/private'
    ]) {
      expect(
        (await http(v.origin, { headers: { cookie: v.cookie }, path })).status
      ).toBeGreaterThanOrEqual(400)
    }
    expect(h.readAsset.mock.calls.map(([path]) => path)).toEqual(['index.html', 'assets/main.js'])
    expect((await http(v.origin + '/assets/main.js')).status).toBe(401)
  })
  it('returns actual history, updates and a frozen selected step without accepting a caller scope', async () => {
    const h = harness(),
      v = await open(h)
    const snapshot = JSON.parse((await v.get('/api/snapshot')).body) as RunObservationSnapshot
    h.source.run!.text.stdout = 'second'
    const changes = JSON.parse((await v.post('/api/changes', { cursor: snapshot.cursor })).body)
    expect(changes.kind).toBe('delta')
    expect(changes.changes[0].run.logs.stdout.text).toBe('second')
    const selected = await v.post('/api/select', {
      cursor: snapshot.cursor,
      stepId: snapshot.stepId
    })
    expect(selected.status).toBe(200)
    expect(JSON.parse(selected.body).snapshot.run.logs.stdout.text).toBe('first')
    expect(JSON.parse((await v.get('/api/selection')).body).cursor).toEqual(snapshot.cursor)
    expect(JSON.parse((await v.get('/api/history')).body).snapshots).toHaveLength(2)
    expect(
      (
        await http(v.origin + '/api/select', {
          method: 'POST',
          headers: {
            cookie: v.cookie,
            origin: 'https://foreign.invalid',
            'content-type': 'application/json'
          },
          body: '{}'
        })
      ).status
    ).toBe(403)
    expect(
      (
        await http(v.origin + '/api/select', {
          method: 'POST',
          headers: { cookie: v.cookie, 'content-type': 'application/json' },
          body: '{}'
        })
      ).status
    ).toBe(403)
  })
  it('requires explicit interaction grant and pins project opening to the observed running Run', async () => {
    const h = harness(),
      readonly = await open(h)
    expect((await readonly.post('/api/project-view', {})).status).toBe(403)
    expect(h.projectOpen).not.toHaveBeenCalled()
    const v = await open(h, { allowInteraction: true, desktopParent: 'file:' })
    expect((await v.post('/api/project-view', {})).status).toBe(200)
    expect(h.projectOpen).toHaveBeenCalledWith(
      { projectId: 'project-a', sessionId: 'session-a', runId: 'run-a' },
      v.access.viewerId,
      [v.origin, 'file:'],
      'partitioned',
      expect.any(Function)
    )
    h.source.run!.status = 'completed'
    expect((await v.post('/api/project-view', {})).status).toBe(409)
    expect(h.projectOpen).toHaveBeenCalledTimes(1)
  })
  it('closes a newly opened project page if the Run ends before access can be returned', async () => {
    const h = harness(),
      v = await open(h, { allowInteraction: true })
    const original = h.projectOpen.getMockImplementation()!
    h.projectOpen.mockImplementation(async (...args) => {
      const result = await original(...args)
      h.source.run!.status = 'completed'
      return result
    })
    expect((await v.post('/api/project-view', {})).status).toBe(409)
    expect(h.projectClose).toHaveBeenCalledWith(v.access.viewerId)
  })
  it('reads only advertised exact Versions and prevents artifact HTML from gaining viewer origin privileges', async () => {
    const h = harness(),
      v = await open(h)
    expect((await v.get('/api/artifact?versionId=foreign')).status).toBe(404)
    expect(h.readArtifact).not.toHaveBeenCalled()
    const artifact = await v.get('/api/artifact?versionId=version-a')
    expect(artifact.status).toBe(200)
    expect(artifact.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    expect(artifact.headers['content-disposition']).toContain('attachment')
    expect(h.readArtifact.mock.calls[0][0]).toMatchObject({
      target: scope,
      runId: 'run-a',
      artifact: { versionId: 'version-a' }
    })
  })
  it('requires separately enabled cancellation and explicit confirmation and never cancels on viewer close', async () => {
    const disabled = harness()
    await expect(disabled.host.open(scope, disabled.owner, { allowCancel: true })).rejects.toThrow()
    const h = harness({ cancel: true }),
      v = await open(h, { allowCancel: true })
    expect((await v.post('/api/cancel', {})).status).toBe(400)
    expect(h.cancel).not.toHaveBeenCalled()
    expect((await v.post('/api/cancel', { confirmed: true })).status).toBe(200)
    expect(h.cancel.mock.calls[0][0]).toMatchObject({
      target: scope,
      runId: 'run-a',
      caller: { ...h.owner, isAuthorizationCurrent: expect.any(Function) }
    })
    h.host.closeViewer(v.access.viewerId)
    expect(h.cancel).toHaveBeenCalledTimes(1)
  })
  it('rejects late reads after caller revocation and never exposes private errors', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const h = harness({
        readAsset: async () => {
          await gate
          return { body: Buffer.from('private bytes'), mimeType: 'text/plain' }
        }
      }),
      v = await open(h)
    const reading = v.get('/')
    const settled = reading.catch(() => ({ status: 410, body: '', headers: {} }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    h.setAuthorized(false)
    finish()
    const response = await settled
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.body).not.toContain('private bytes')
    const other = harness({
        readAsset: async () => {
          throw new Error('/Users/private/secret token=never-show')
        }
      }),
      w = await open(other)
    const failed = await w.get('/')
    expect(failed.status).toBe(503)
    expect(failed.body).not.toContain('/Users')
    expect(failed.body).not.toContain('never-show')
  })
  it('closes expired listeners and enforces JSON request and byte limits', async () => {
    const h = harness({ lifetimeMs: 80 }),
      v = await open(h)
    const oversized = await http(v.origin + '/api/select', {
      method: 'POST',
      headers: { cookie: v.cookie, origin: v.origin, 'content-type': 'application/json' },
      body: 'x'.repeat(9000)
    })
    expect(oversized.status).toBe(413)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await expect(v.get('/api/snapshot')).rejects.toThrow()
    expect(h.projectClose).toHaveBeenCalledWith(v.access.viewerId)
  })
})

describe('recorded Replay HTTP viewer', () => {
  it('serves bounded browser video ranges and moments with no recording or execution authority', async () => {
    const control = vi.fn(async () => ({}))
    const h = harness({ recorded: 'browser', cancel: true, browserRecording: control })
    const { payload, bytes } = browserRecordedFixture()
    const access = await h.host.openRecorded(payload.receiving, h.owner, {
      format: 'web-recording'
    })
    const boot = await http(access.url)
    const cookie = boot.headers['set-cookie']![0].split(';')[0]
    const origin = new URL(access.url).origin
    const get = (
      path: string,
      headers: Record<string, string> = {},
      method = 'GET'
    ): ReturnType<typeof http> => http(origin + path, { method, headers: { cookie, ...headers } })
    const post = (path: string, body: unknown): ReturnType<typeof http> =>
      http(origin + path, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    const mediaPath = '/api/recording/media?mediaKey=segment-a'
    expect(JSON.parse((await get('/api/context')).body)).toMatchObject({
      format: 'web-recording',
      canRecord: false,
      canCapture: false,
      canInteract: false
    })
    expect((await get('/')).headers['content-security-policy']).toContain("media-src 'self'")
    expect((await get(mediaPath)).body).toBe(bytes.toString())
    const range = await get(mediaPath, { range: 'bytes=5-8' })
    expect(range).toMatchObject({
      status: 206,
      body: bytes.subarray(5, 9).toString(),
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes 5-8/${bytes.length}`,
        'content-length': '4'
      }
    })
    expect((await get(mediaPath, { range: 'bytes=-5' })).body).toBe(bytes.subarray(-5).toString())
    expect((await get(mediaPath, { range: 'bytes=5-' })).body).toBe(bytes.subarray(5).toString())
    expect(await get(mediaPath, {}, 'HEAD')).toMatchObject({
      status: 200,
      body: '',
      headers: { 'content-length': String(bytes.length) }
    })
    for (const range of [
      'bytes=999-',
      'bytes=8-5',
      'bytes=0-1,3-4',
      'bytes=-0',
      'bytes=-',
      'bytes=9007199254740993-'
    ])
      expect(await get(mediaPath, { range })).toMatchObject({
        status: 416,
        body: '',
        headers: { 'content-range': `bytes */${bytes.length}` }
      })
    expect((await get('/api/recording/media?mediaKey=foreign')).status).toBe(404)
    expect(
      JSON.parse((await post('/api/recording/moment', { offsetMs: 1500 })).body)
    ).toMatchObject({
      kind: 'recorded-project-moment',
      offsetMs: 1500,
      receiving: payload.receiving
    })
    expect(JSON.parse((await get('/api/recording/moment')).body)).toMatchObject({ offsetMs: 1500 })
    expect((await post('/api/recording/moment', { offsetMs: 3000 })).status).not.toBe(200)
    expect((await post('/api/project-recordings/start', { requestId: 'forbidden' })).status).toBe(
      403
    )
    expect((await post('/api/recording/select', { stepKey: 'fake' })).status).not.toBe(200)
    expect(control).not.toHaveBeenCalled()
    expect(h.projectOpen).not.toHaveBeenCalled()
    expect(h.cancel).not.toHaveBeenCalled()
    h.setAuthorized(false)
    expect((await get(mediaPath, { range: 'bytes=0-1' })).status).not.toBe(206)
  })
  it('opens a project-only recording through the same bounded viewer with no Notebook or live service', async () => {
    const h = harness({ recorded: 'project', cancel: true })
    const { payload } = projectRecordedFixture()
    const access = await h.host.openRecorded(payload.receiving, h.owner, {
      format: 'project-recording'
    })
    const boot = await http(access.url)
    const cookie = boot.headers['set-cookie']![0].split(';')[0]
    const origin = new URL(access.url).origin
    const get = (path: string): ReturnType<typeof http> =>
      http(origin + path, { headers: { cookie } })
    const post = (path: string, body: unknown): ReturnType<typeof http> =>
      http(origin + path, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    expect(JSON.parse((await get('/api/context')).body)).toMatchObject({
      mode: 'recorded',
      format: 'project-recording',
      canInteract: false,
      canCancel: false,
      canCapture: false
    })
    expect(JSON.parse((await get('/api/recording')).body)).toEqual(payload)
    expect((await get('/api/recording/media?mediaKey=export-a')).status).toBe(200)
    expect(
      JSON.parse((await post('/api/recording/file-selection', { mediaKey: 'export-a' })).body)
    ).toMatchObject({ source: 'project-recording', stepKeys: [] })
    expect((await post('/api/recording/select', { stepKey: 'invented' })).status).not.toBe(200)
    expect((await get('/api/snapshot')).status).toBe(403)
    expect((await post('/api/project-view', {})).status).toBe(403)
    expect((await post('/api/cancel', { confirmed: true })).status).toBe(403)
    expect(
      (await get('/api/recording/media?mediaKey=export-a&format=run-observation')).status
    ).toBe(400)
    expect(h.projectOpen).not.toHaveBeenCalled()
    expect(h.cancel).not.toHaveBeenCalled()
  })
  it('serves receiver-scoped history/media and selection without live or execution permissions', async () => {
    const h = harness({ recorded: true, cancel: true })
    const { payload, bytes } = recordedFixture()
    const access = await h.host.openRecorded(payload.receiving, h.owner)
    const boot = await http(access.url)
    expect(boot.status).toBe(303)
    const cookie = boot.headers['set-cookie']![0].split(';')[0]
    const origin = new URL(access.url).origin
    const get = (path: string): ReturnType<typeof http> =>
      http(origin + path, { headers: { cookie } })
    const post = (path: string, body: unknown): ReturnType<typeof http> =>
      http(origin + path, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    expect(JSON.parse((await get('/api/context')).body)).toMatchObject({
      mode: 'recorded',
      target: payload.receiving,
      canInteract: false,
      canCancel: false,
      canReadArtifacts: true
    })
    expect(JSON.parse((await get('/api/recording')).body)).toEqual(payload)
    expect((await get('/api/recording/media?mediaKey=foreign')).status).toBe(404)
    const media = await get('/api/recording/media?mediaKey=export-a')
    expect(media.status).toBe(200)
    expect(media.body).toBe(bytes.toString())
    expect(media.headers['content-disposition']).toContain('attachment')
    expect(media.headers['content-security-policy']).toContain('sandbox')
    const selection = await post('/api/recording/select', { stepKey: 'observation-0' })
    expect(selection.status).toBe(200)
    expect(await h.viewers.recordingSelection(access.viewerId, { caller: h.owner })).toEqual(
      JSON.parse(selection.body)
    )
    const fileSelection = await post('/api/recording/file-selection', { mediaKey: 'export-a' })
    expect(fileSelection.status).toBe(200)
    expect(JSON.parse(fileSelection.body)).toMatchObject({
      kind: 'recorded-observation-file',
      resource: { projectId: payload.receiving.projectId, versionId: 'receiver-version' }
    })
    expect(JSON.parse((await get('/api/recording/file-selection')).body)).toEqual(
      JSON.parse(fileSelection.body)
    )
    expect(JSON.parse((await get('/api/recording/selection')).body)).toEqual(
      JSON.parse(selection.body)
    )
    expect(
      (await post('/api/recording/file-selection', { mediaKey: 'export-a', versionId: 'foreign' }))
        .status
    ).toBe(400)
    expect((await post('/api/recording/file-selection', { mediaKey: '../private' })).status).toBe(
      400
    )
    expect(
      (await post('/api/recording/select', { stepKey: 'observation-0', target: scope })).status
    ).toBe(400)
    for (const path of [
      '/api/snapshot',
      '/api/history',
      '/api/artifact?versionId=receiver-version'
    ])
      expect((await get(path)).status).toBe(403)
    for (const path of ['/api/project-view', '/api/cancel'])
      expect((await post(path, { confirmed: true })).status).toBe(403)
    expect(h.projectOpen).not.toHaveBeenCalled()
    expect(h.cancel).not.toHaveBeenCalled()
    expect(h.readArtifact).not.toHaveBeenCalled()
    expect((await http(access.url)).status).toBe(401)
    h.setAuthorized(false)
    await expect(get('/api/recording')).resolves.toMatchObject({ status: 401 })
    await expect(get('/api/recording/file-selection')).resolves.toMatchObject({ status: 401 })
  })
})

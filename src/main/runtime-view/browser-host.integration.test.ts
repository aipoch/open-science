import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, chmod, realpath, writeFile, rm, mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chromium,
  _electron,
  type Browser,
  type ElectronApplication,
  type FrameLocator
} from '@playwright/test'
import { afterEach, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { Socket } from 'node:net'
import { OwnedRuntimeViewService } from './owned-service'
import { RuntimeViewOwner } from './owner'
import { ManagedRuntimeViews } from '../managed-runtime-views'
import { RunObservationOwner, type RunObservationSource } from '../run-observation/owner'
import { ObservationViewers } from '../run-observation/viewers'
import { createCallerContext } from '../caller-context'
import { ReplayViewerHttpHost } from '../replay-viewer/http-host'
import { desktopObservationFrameRegistry } from '../replay-viewer/desktop-frame-registry'

const enabled = process.env.RUN_RUNTIME_VIEW_BROWSER === '1' && process.platform === 'darwin'
const evidence = '/tmp/open-science-runtime-view-browser-acceptance'
const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server, path?: string): Promise<string> {
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    if (path) server.listen(path, resolve)
    else server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') return ''
  return `http://127.0.0.1:${address.port}`
}

async function assertInteraction(frame: FrameLocator): Promise<void> {
  await frame.locator('#status').waitFor({ state: 'visible' })
  await expect.poll(() => frame.locator('#sse').textContent()).toBe('event: ready')
  await frame.locator('#increment').click()
  await expect.poll(() => frame.locator('#count').textContent()).toBe('1')
  await frame.locator('#send').click()
  await expect.poll(() => frame.locator('#ws').textContent()).toBe('echo: browser click')
  await frame.locator('#external').click()
  await expect.poll(() => frame.locator('#blocked').textContent()).toBe('both blocked')
}

it.skipIf(!enabled)(
  'uses real Chromium and Electron file ancestors with isolated project origins',
  async () => {
    await mkdir(evidence, { recursive: true })
    const root = await realpath(await mkdtemp(join(tmpdir(), 'os-service-browser-run-')))
    await chmod(root, 0o700)
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const scope = {
      projectId: 'browser-project',
      sessionId: 'browser-session',
      runId: 'browser-run',
      environmentId: 'browser-environment',
      generationId: randomUUID()
    }
    const proof = randomBytes(32).toString('hex'),
      proofPath = `/__open_science_proof_${randomBytes(16).toString('hex')}`
    let managementRequests = 0,
      postRequests = 0,
      streamRequests = 0,
      closedStreams = 0,
      closedWebSockets = 0,
      upgrades = 0,
      count = 0
    const management = await listen(
      createServer((_req, res) => {
        managementRequests++
        res.end('must never be reached')
      })
    )
    const allSockets = new Set<Socket>()
    const ws = new WebSocketServer({ noServer: true })
    cleanups.push(() => {
      for (const client of ws.clients) client.terminate()
      ws.close()
      for (const socket of allSockets) socket.destroy()
    })
    const script = `
    const text = (id, value) => document.getElementById(id).textContent = value;
    text('status', 'ready');
    fetch('/events', {headers:{'x-project-csrf':'project-token'}}).then(async r => {
      const reader = r.body.getReader(); const chunk = await reader.read();
      text('sse', new TextDecoder().decode(chunk.value).includes('ready') ? 'event: ready' : 'wrong event');
    });
    document.getElementById('increment').onclick = async () => {
      const r = await fetch('/increment', {method:'POST', headers:{'content-type':'application/json','x-project-csrf':'project-token'}, body:'{}'});
      const value = await r.json(); text('count', String(value.count));
    };
    const socket = new WebSocket('ws://' + location.host + '/socket', 'browser.v1');
    socket.onmessage = e => text('ws', 'echo: ' + e.data);
    document.getElementById('send').onclick = () => socket.send('browser click');
    document.getElementById('external').onclick = async () => {
      const results = await Promise.allSettled([fetch(${JSON.stringify(management + '/sensitive')}), fetch('https://example.invalid/exfil')]);
      text('blocked', results.every(r => r.status === 'rejected') ? 'both blocked' : 'unexpected access');
    };
  `
    const project = createServer((req, res) => {
      if (req.url === proofPath) {
        res.end(proof)
        return
      }
      if (req.url === '/events') {
        if (req.headers['x-project-csrf'] !== 'project-token') {
          res.writeHead(403)
          res.end()
          return
        }
        streamRequests++
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: ready\n\n')
        res.once('close', () => {
          closedStreams++
        })
        return
      }
      if (req.url === '/increment') {
        if (
          req.method !== 'POST' ||
          req.headers['x-project-csrf'] !== 'project-token' ||
          req.headers.host !== '127.0.0.1:4173' ||
          req.headers.origin !== 'http://127.0.0.1:4173'
        ) {
          res.writeHead(403)
          res.end()
          return
        }
        postRequests++
        count++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ count }))
        return
      }
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
      )
      if (req.url === '/app.js') {
        res.setHeader('content-type', 'application/javascript; charset=utf-8')
        res.end(script)
        return
      }
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(
        `<!doctype html><html><body style="font:18px system-ui;padding:24px"><h1>Open Science — managed project</h1><p id="status">loading</p><button id="increment">Increment</button><output id="count">0</output><p id="sse">waiting</p><button id="send">Send WebSocket message</button><p id="ws">waiting</p><button id="external">Check network isolation</button><p id="blocked"></p><script src="/app.js"></script></body></html>`
      )
    })
    project.on('connection', (socket) => {
      allSockets.add(socket)
      socket.once('close', () => allSockets.delete(socket))
    })
    project.on('upgrade', (req, socket, head) => {
      upgrades++
      ws.handleUpgrade(req, socket, head, (client) => {
        client.once('close', () => {
          closedWebSockets++
        })
        client.on('message', (data) => client.send(data.toString()))
      })
    })
    const socketPath = join(root, 'service.sock')
    await listen(project, socketPath)
    const abort = new AbortController()
    const service = await OwnedRuntimeViewService.open({
      scope,
      socketPath,
      expectedProof: proof,
      proofPath,
      upstreamOrigin: 'http://127.0.0.1:4173',
      signal: abort.signal,
      assertCurrent() {
        return undefined
      }
    })
    cleanups.push(() => service.close())
    const owner = new RuntimeViewOwner({}, desktopObservationFrameRegistry)
    cleanups.push(() => owner.close())
    let projectUrl = ''
    const viewerBase = await listen(
      createServer((_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(
          `<!doctype html><html><body style="margin:0;background:#edf3f7;font:16px system-ui"><h2 style="margin:16px">Replay — live project</h2><iframe id="project" sandbox="allow-scripts allow-same-origin allow-forms" src="${projectUrl}" style="display:block;width:100%;height:650px;border:0"></iframe></body></html>`
        )
      })
    )
    const viewerOrigin = viewerBase.replace('127.0.0.1', `viewer-${randomUUID()}.localhost`)
    const access = await owner.open({
      scope,
      service,
      title: 'Browser fixture',
      allowedParentOrigins: [viewerOrigin, 'file:'],
      allowedRequestHeaders: ['x-project-csrf'],
      webSocketProtocols: ['browser.v1'],
      adaptFrameAncestors: true,
      cookiePolicy: 'partitioned'
    })
    projectUrl = access.url
    let browser: Browser | undefined, electron: ElectronApplication | undefined
    const receipt: Record<string, unknown> = {
      schema: 'runtime-view-browser-acceptance-v1',
      startedAt: new Date().toISOString(),
      projectOrigin: new URL(access.url).origin,
      viewerOrigin,
      scope,
      checks: []
    }
    try {
      browser = await chromium.launch({ headless: true })
      cleanups.push(() => browser?.close())
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
      await page.goto(viewerOrigin)
      await assertInteraction(page.frameLocator('#project'))
      await page.screenshot({ path: join(evidence, 'chromium.png') })
      receipt.chromium = {
        passed: true,
        version: browser.version(),
        screenshot: join(evidence, 'chromium.png')
      }
      projectUrl = (await owner.issueAccess(access.view.viewId, scope)).url
      const foreignPage = await browser.newPage()
      const deniedAncestors: string[] = []
      foreignPage.on('console', (message) => {
        if (message.text().includes('frame-ancestors')) deniedAncestors.push(message.text())
      })
      await foreignPage.goto(viewerBase.replace('127.0.0.1', `foreign-${randomUUID()}.localhost`))
      await expect.poll(() => deniedAncestors.length).toBeGreaterThan(0)
      expect(await foreignPage.frameLocator('#project').locator('#status').count()).toBe(0)
      await foreignPage.close()
      count = 0
      projectUrl = (await owner.issueAccess(access.view.viewId, scope)).url
      const html = join(root, 'viewer.html'),
        main = join(root, 'main.cjs')
      await writeFile(
        html,
        `<!doctype html><html><meta charset="utf-8"><body style="margin:0"><iframe id="viewer" src="${viewerOrigin}" style="display:block;width:100%;height:100vh;border:0"></iframe></body></html>`
      )
      await writeFile(
        main,
        `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1120,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,webSecurity:true}});w.loadFile(${JSON.stringify(html)});});app.on('window-all-closed',()=>app.quit());`
      )
      electron = await _electron.launch({
        args: [main],
        cwd: fileURLToPath(new URL('../../../..', import.meta.url))
      })
      cleanups.push(() => electron?.close())
      const window = await electron.firstWindow()
      await window.waitForSelector('#viewer')
      await assertInteraction(window.frameLocator('#viewer').frameLocator('#project'))
      await window.screenshot({ path: join(evidence, 'electron.png') })
      receipt.electron = {
        passed: true,
        topUrl: window.url(),
        webSecurity: true,
        screenshot: join(evidence, 'electron.png')
      }
      expect(managementRequests).toBe(0)
      expect(postRequests).toBe(2)
      expect(streamRequests).toBe(2)
      expect(upgrades).toBe(2)

      // Exercise the production observation HTTP host as well: its credential must remain
      // HttpOnly while a second, separately scoped project cookie works below the file ancestor.
      const projectViews = new ManagedRuntimeViews(
        new RuntimeViewOwner({}, desktopObservationFrameRegistry)
      )
      cleanups.push(() => projectViews.close())
      projectViews.register({
        scope,
        declaration: {
          title: 'Browser project',
          allowedRequestHeaders: ['x-project-csrf'],
          webSocketProtocols: ['browser.v1'],
          adaptFrameAncestors: true
        },
        socketPath,
        proof: { path: proofPath, value: proof },
        logicalPort: 4173,
        signal: abort.signal
      })
      const target = { projectId: scope.projectId, sessionId: scope.sessionId, runId: scope.runId }
      const source: RunObservationSource = {
        identity: target,
        phase: 'running',
        artifacts: [],
        run: {
          runId: scope.runId,
          cellId: 'fixture-cell',
          source: 'agent',
          kernelKind: 'bash',
          script: '',
          status: 'running',
          startedAt: Date.now(),
          text: { stdout: 'project started', stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: []
        }
      }
      const observation: RunObservationOwner = new RunObservationOwner({
        authorize: (target, viewer) => viewers.assertViewer(target, viewer),
        read: async () => source
      })
      const viewers: ObservationViewers = new ObservationViewers({
        observer: observation,
        authorizeScope: async () => undefined,
        onRevoked: (viewerId) => httpHost.closeViewer(viewerId)
      })
      cleanups.push(() => viewers.close())
      const viewerJs = `fetch('/api/snapshot').then(r=>r.json()).then(s=>document.getElementById('viewer-state').textContent=s.phase);document.getElementById('open-project').onclick=async()=>{const r=await fetch('/api/project-view',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const a=await r.json();document.getElementById('project').src=a.url;};`
      const httpHost: ReplayViewerHttpHost = new ReplayViewerHttpHost({
        desktopFrames: desktopObservationFrameRegistry,
        viewers,
        projectViews,
        readAsset: async (path) =>
          path === 'index.html'
            ? {
                mimeType: 'text/html; charset=utf-8',
                body: Buffer.from(
                  '<!doctype html><html><meta charset="utf-8"><body><h2>Authenticated Replay viewer</h2><p id="viewer-state">loading</p><button id="open-project">Open project interface</button><iframe id="project" sandbox="allow-scripts allow-same-origin allow-forms" style="display:block;width:100%;height:600px;border:0"></iframe><script src="/assets/viewer.js"></script></body></html>'
                )
              }
            : path === 'assets/viewer.js'
              ? { mimeType: 'application/javascript', body: Buffer.from(viewerJs) }
              : undefined
      })
      cleanups.push(() => httpHost.close())
      let hostLeaseCurrent = true
      const hostCaller = createCallerContext({
        clientId: 'browser-fixture',
        lifecycleClientId: 'browser-fixture',
        leaseId: 'browser-fixture',
        surface: 'task',
        location: 'local',
        principalKind: 'automation',
        actionOrigin: 'automation',
        isAuthorizationCurrent: () => hostLeaseCurrent
      })
      const httpAccess = await httpHost.open(target, hostCaller, {
        allowInteraction: true,
        desktopParent: 'file:'
      })
      const hostPage = await browser.newPage({ viewport: { width: 1100, height: 800 } })
      count = 0
      await hostPage.goto(httpAccess.url)
      await expect.poll(() => hostPage.locator('#viewer-state').textContent()).toBe('running')
      await hostPage.locator('#open-project').click()
      await assertInteraction(hostPage.frameLocator('#project'))
      expect(await hostPage.evaluate(() => document.cookie)).toBe('')
      await hostPage.screenshot({ path: join(evidence, 'http-host-chromium.png') })
      const desktopAccess = await httpHost.issueAccess(httpAccess.viewerId, hostCaller)
      await writeFile(
        html,
        `<!doctype html><html><meta charset="utf-8"><body style="margin:0"><iframe id="viewer" src="${desktopAccess.url}" style="display:block;width:100%;height:100vh;border:0"></iframe></body></html>`
      )
      count = 0
      await window.reload()
      const desktopViewer = window.frameLocator('#viewer')
      await expect.poll(() => desktopViewer.locator('#viewer-state').textContent()).toBe('running')
      await desktopViewer.locator('#open-project').click()
      await assertInteraction(desktopViewer.frameLocator('#project'))
      await window.screenshot({ path: join(evidence, 'http-host-electron.png') })
      receipt.observationHttpHost = {
        passed: true,
        viewerOrigin: new URL(httpAccess.url).origin,
        chromiumScreenshot: join(evidence, 'http-host-chromium.png'),
        electronScreenshot: join(evidence, 'http-host-electron.png'),
        managementCredentialInJavaScript: false
      }
      expect(managementRequests).toBe(0)
      expect(postRequests).toBe(4)
      expect(streamRequests).toBe(4)
      expect(upgrades).toBe(4)
      // These fixture observers only fetch once at startup: no browser polling triggers this.
      // Silent SSE and WebSocket connections must close when Main revokes the original lease.
      const streamsBefore = closedStreams,
        socketsBefore = closedWebSockets
      const revokedAt = Date.now()
      hostLeaseCurrent = false
      await expect
        .poll(() => projectViews.describe(scope).every((view) => view.state === 'closed'), {
          timeout: 1000,
          interval: 20
        })
        .toBe(true)
      await expect
        .poll(() => closedStreams >= streamsBefore + 2 && closedWebSockets >= socketsBefore + 2, {
          timeout: 1000,
          interval: 20
        })
        .toBe(true)
      expect(Date.now() - revokedAt).toBeLessThan(1000)
      expect(abort.signal.aborted).toBe(false)
      receipt.viewerLeaseRevocation = {
        passed: true,
        observerPolling: false,
        closedWithinMs: Date.now() - revokedAt,
        owningRunContinues: true
      }
      abort.abort()
      expect(owner.list(scope)[0].state).toBe('closed')
      const reload = await page.goto(new URL(access.url).origin).then(
        () => false,
        () => true
      )
      expect(reload).toBe(true)
      receipt.checks = [
        'real-browser-localhost-resolution',
        'partitioned-cookie',
        'file-and-http-ancestor-chain',
        'foreign-ancestor-denied',
        'project-button-post',
        'custom-project-header',
        'live-sse',
        'bidirectional-websocket',
        'blocked-management-and-external-origin',
        'run-end-revocation',
        'old-link-unavailable',
        'observation-http-host-cookie-and-project-cookie-chain',
        'silent-project-streams-close-after-viewer-lease-revocation-without-observer-poll'
      ]
      receipt.counts = { managementRequests, postRequests, streamRequests, upgrades }
      receipt.status = 'passed'
    } catch (error) {
      receipt.status = 'failed'
      receipt.error = String(error).replace(/grant=[a-f0-9]+/g, 'grant=[redacted]')
      throw error
    } finally {
      receipt.finishedAt = new Date().toISOString()
      await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    }
  },
  60000
)

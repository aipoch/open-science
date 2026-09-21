import 'reflect-metadata'
import { webcrypto } from 'node:crypto'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { X509CertificateGenerator } from '@peculiar/x509'
import type { Page } from 'playwright'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

// A real HTTPS transport is required: Playwright routing disables the HTTP cache and cannot
// establish whether Chromium accepts Set-Cookie or persists its on-disk cache across restarts.
test('retains source cookies, cache and local storage while session storage ends on restart', async ({
  app
}) => {
  const keys = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: '01',
      name: 'CN=127.0.0.1',
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 86_400_000),
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      keys
    },
    webcrypto as unknown as Crypto
  )
  const pem = certificate.toString('pem')
  const key = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  let cacheRequests = 0
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${key
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END PRIVATE KEY-----\n`
  const server = createServer({ cert: pem, key: privateKey }, (request, response) => {
    if (request.url === '/cache') {
      cacheRequests++
      response
        .writeHead(200, { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'text/plain' })
        .end('cached evidence')
      return
    }
    if (request.url === '/echo') {
      response.writeHead(200, { 'Cache-Control': 'no-store' }).end(request.headers.cookie ?? '')
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store',
      'Set-Cookie': [
        'serverCookie=retained; Secure; SameSite=None; Max-Age=3600; Path=/',
        'defaultCookie=retained; Secure; Max-Age=3600; Path=/',
        'strictCookie=retained; Secure; SameSite=Strict; Max-Age=3600; Path=/'
      ]
    }).end(`<!doctype html><html><body><h1>Source storage fixture</h1>
      <button id="access">Allow storage</button><output id="result"></output>
      <script>document.getElementById('access').onclick = async () => {
        try { await document.requestStorageAccess(); document.getElementById('result').textContent = 'granted'; }
        catch (error) { document.getElementById('result').textContent = error.name; }
      };</script></body></html>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing HTTPS fixture port')
  const origin = `https://127.0.0.1:${address.port}`
  const mountSource = async (page: Page): Promise<void> => {
    const previousPage = page
      .context()
      .pages()
      .find((candidate) => candidate.url() === `${origin}/page`)
    const closed = previousPage?.waitForEvent('close')
    await page.evaluate((origin) => {
      const previous = document.querySelector<HTMLElement>('#storage-fixture')
      if (previous) window.api.sourcePreview!.release(`${origin}/page`, previous.dataset.instanceId)
      previous?.remove()
      const host = document.createElement('div')
      host.id = 'storage-fixture'
      host.dataset.instanceId = crypto.randomUUID()
      document.body.append(host)
      window.api.sourcePreview!.updateView({
        instanceId: host.dataset.instanceId,
        sourceUrl: `${origin}/page`,
        attempt: 0,
        bounds: { x: 20, y: 20, width: 600, height: 500 }
      })
    }, origin)
    await closed
    await expect
      .poll(() =>
        page
          .context()
          .pages()
          .some((candidate) => candidate.url() === `${origin}/page`)
      )
      .toBe(true)
    await expect(sourceFrame(page).getByRole('heading')).toHaveText('Source storage fixture')
  }
  const sourceFrame = (page: Page): Page => {
    const source = page
      .context()
      .pages()
      .find((candidate) => candidate.url() === `${origin}/page`)
    if (!source) throw new Error('Missing native source page')
    return source
  }
  try {
    let page = await app.completeOnboarding()
    await app.trustSourcePreviewCertificate(pem)
    await mountSource(page)
    const initial = await sourceFrame(page).evaluate(async () => {
      document.cookie = 'cookieCheck=accepted; Secure; Path=/'
      localStorage.setItem('source-persistent', 'retained')
      sessionStorage.setItem('source-session', 'current window')
      document.cookie = 'clientCookie=retained; Secure; SameSite=None; Max-Age=3600; Path=/'
      return {
        cookieCheck: document.cookie.includes('cookieCheck=accepted'),
        cookies: await (await fetch('/echo')).text(),
        cached: await (await fetch('/cache')).text(),
        privileged: typeof (globalThis as { api?: unknown }).api
      }
    })
    expect(initial.cookieCheck).toBe(true)
    expect(initial.cookies).toContain('defaultCookie=retained')
    expect(initial.cookies).toContain('strictCookie=retained')
    expect(initial.cookies).toContain('serverCookie=retained')
    expect(initial.cookies).toContain('clientCookie=retained')
    expect(initial.cached).toBe('cached evidence')
    expect(initial.privileged).toBe('undefined')
    // The app's trusted document cannot read the remote origin's localStorage.
    expect(await page.evaluate(() => localStorage.getItem('source-persistent'))).toBeNull()
    const reloadingFrame = sourceFrame(page)
    await Promise.all([
      reloadingFrame.waitForNavigation({ waitUntil: 'load' }),
      reloadingFrame.evaluate(() => location.reload())
    ])
    expect(await sourceFrame(page).evaluate(() => sessionStorage.getItem('source-session'))).toBe(
      'current window'
    )
    await mountSource(page)
    expect(await sourceFrame(page).evaluate(() => localStorage.getItem('source-persistent'))).toBe(
      'retained'
    )
    expect(await sourceFrame(page).evaluate(async () => (await fetch('/cache')).text())).toBe(
      'cached evidence'
    )
    expect(cacheRequests).toBe(1)

    page = await app.restart()
    await app.trustSourcePreviewCertificate(pem)
    await mountSource(page)
    const restored = await sourceFrame(page).evaluate(async () => ({
      local: localStorage.getItem('source-persistent'),
      session: sessionStorage.getItem('source-session'),
      cookies: await (await fetch('/echo')).text(),
      cached: await (await fetch('/cache')).text()
    }))
    expect(restored.local).toBe('retained')
    expect(restored.session).toBeNull()
    expect(restored.cookies).toContain('clientCookie=retained')
    expect(restored.cached).toBe('cached evidence')
    expect(cacheRequests).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

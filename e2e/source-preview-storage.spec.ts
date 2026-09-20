import 'reflect-metadata'
import { webcrypto } from 'node:crypto'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { X509CertificateGenerator } from '@peculiar/x509'
import type { Frame, Page } from 'playwright'
import { expect } from '@playwright/test'
import { SOURCE_PREVIEW_FRAME_NAME, SOURCE_PREVIEW_SANDBOX } from '../src/shared/source-preview'
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
      'Set-Cookie': 'serverCookie=retained; Secure; SameSite=None; Max-Age=3600; Path=/'
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
    // Use the production sandbox contract in a trusted renderer child. This drives the real
    // main-process admission and permission handlers without relying on external providers.
    await page.evaluate(
      ({ origin, name, sandbox }) => {
        document.querySelector('#storage-fixture')?.remove()
        const frame = document.createElement('iframe')
        frame.id = 'storage-fixture'
        frame.name = name
        frame.setAttribute('sandbox', sandbox)
        frame.style.cssText =
          'position:fixed;inset:0;width:90vw;height:80vh;z-index:9999;background:white'
        document.body.append(frame)
        frame.src = `${origin}/page`
      },
      { origin, name: SOURCE_PREVIEW_FRAME_NAME, sandbox: SOURCE_PREVIEW_SANDBOX }
    )
    await expect(page.frameLocator('#storage-fixture').getByRole('heading')).toHaveText(
      'Source storage fixture'
    )
  }
  const sourceFrame = (page: Page): Frame => {
    const frame = page.frames().find((frame) => frame.url() === `${origin}/page`)
    if (!frame) throw new Error('Missing source frame')
    return frame
  }
  try {
    let page = await app.completeOnboarding()
    await app.trustSourcePreviewCertificate(pem)
    await mountSource(page)
    await page
      .frameLocator('#storage-fixture')
      .getByRole('button', { name: 'Allow storage' })
      .click()
    await expect(page.frameLocator('#storage-fixture').locator('#result')).toHaveText('granted')
    const initial = await sourceFrame(page).evaluate(async () => {
      localStorage.setItem('source-persistent', 'retained')
      sessionStorage.setItem('source-session', 'current window')
      document.cookie = 'clientCookie=retained; Secure; SameSite=None; Max-Age=3600; Path=/'
      return {
        cookies: await (await fetch('/echo')).text(),
        cached: await (await fetch('/cache')).text(),
        privileged: typeof (globalThis as { api?: unknown }).api
      }
    })
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

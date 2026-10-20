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
      <iframe id="third-party" src="https://pmc.ncbi.nlm.nih.gov/articles/PMC12345"></iframe>
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
      previous?.remove()
      const host = document.createElement('webview')
      host.id = 'storage-fixture'
      host.style.cssText = 'position:fixed;left:20px;top:20px;width:600px;height:500px;z-index:10'
      host.setAttribute('partition', 'persist:open-science-source-preview-v1')
      host.setAttribute('src', `${origin}/page`)
      document.body.append(host)
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
    if (!source) throw new Error('Missing source guest')
    return source
  }
  try {
    let page = await app.completeOnboarding()
    await app.trustSourcePreviewCertificate(pem)
    await app.setDefaultSessionCookie(`${origin}/page`)
    await page.context().route('https://pmc.ncbi.nlm.nih.gov/articles/PMC12345', async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        headers: {
          'Set-Cookie': 'thirdParty=retained; Secure; SameSite=None; Max-Age=3600; Path=/'
        },
        body: `<!doctype html><html><body><button id="access">Allow third-party storage</button><output id="result"></output><script>
          document.getElementById('access').onclick = async () => {
            try { await document.requestStorageAccess(); document.getElementById('result').textContent = document.cookie.includes('thirdParty=retained') ? 'granted' : 'missing'; }
            catch (error) { document.getElementById('result').textContent = error.name; }
          };
        </script></body></html>`
      })
    })
    await mountSource(page)
    const thirdParty = sourceFrame(page).frameLocator('#third-party')
    await thirdParty.getByRole('button', { name: 'Allow third-party storage' }).click()
    await expect(thirdParty.locator('#result')).toHaveText('granted')
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
    expect(initial.cookies).not.toContain('hostOnlyCookie=host-session')
    expect(initial.cached).toBe('cached evidence')
    expect(initial.privileged).toBe('undefined')
    // The app's trusted document cannot read the remote origin's localStorage.
    expect(await page.evaluate(() => localStorage.getItem('source-persistent'))).toBeNull()
    const remote = sourceFrame(page)
    const siblingClosed = page.context().waitForEvent('page')
    await page.evaluate((origin) => {
      const sibling = document.createElement('webview')
      sibling.id = 'storage-fixture-sibling'
      sibling.style.cssText =
        'position:fixed;left:640px;top:20px;width:600px;height:500px;z-index:10'
      sibling.setAttribute('partition', 'persist:open-science-source-preview-v1')
      sibling.setAttribute('src', `${origin}/page`)
      document.body.append(sibling)
    }, origin)
    const sibling = await siblingClosed
    await expect(sibling.getByRole('heading')).toHaveText('Source storage fixture')
    expect(await sibling.evaluate(() => localStorage.getItem('source-persistent'))).toBe('retained')
    expect(await sibling.evaluate(async () => (await fetch('/echo')).text())).toContain(
      'clientCookie=retained'
    )
    const siblingClosedAfterRemoval = sibling.waitForEvent('close')
    await page.locator('#storage-fixture-sibling').evaluate((element) => element.remove())
    await siblingClosedAfterRemoval
    expect(
      await remote.evaluate(() => ({
        api: typeof (window as unknown as { api?: unknown }).api,
        require: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process
      }))
    ).toEqual({ api: 'undefined', require: 'undefined', process: 'undefined' })
    expect(
      await remote.evaluate(
        async () => (await navigator.permissions.query({ name: 'geolocation' })).state
      )
    ).toBe('denied')
    const pagesBeforePopup = page.context().pages().length
    expect(await remote.evaluate(() => window.open('https://example.com') === null)).toBe(true)
    expect(page.context().pages()).toHaveLength(pagesBeforePopup)
    await remote.evaluate(() => {
      location.href = 'http://127.0.0.1/blocked'
    })
    expect(remote.url()).toBe(`${origin}/page`)
    const guestId = await page
      .locator('#storage-fixture')
      .evaluate((element) => (element as Electron.WebviewTag).getWebContentsId())
    const attachmentDecisions = await app.auditSourceAttachments()
    let rejectedAttachments = 0
    for (const [name, value] of [
      ['preload', 'file:///app/preload.js'],
      ['partition', 'persist:untrusted'],
      ['webpreferences', 'sandbox=no,nodeIntegration=yes'],
      ['blinkfeatures', 'WebUSB'],
      ['allowpopups', 'true'],
      ['src', 'file:///private']
    ]) {
      await page.evaluate(
        ({ name, value, origin }) => {
          const guest = document.createElement('webview')
          guest.id = 'rejected-guest'
          guest.setAttribute('partition', 'persist:open-science-source-preview-v1')
          guest.setAttribute('src', `${origin}/page`)
          guest.setAttribute(name, value)
          document.body.append(guest)
        },
        { name, value, origin }
      )
      rejectedAttachments++
      await expect
        .poll(() => attachmentDecisions.jsonValue())
        .toEqual(Array(rejectedAttachments).fill(true))
      await page.locator('#rejected-guest').evaluate((element) => element.remove())
      expect(
        await page
          .locator('#storage-fixture')
          .evaluate((element) => (element as Electron.WebviewTag).getWebContentsId())
      ).toBe(guestId)
    }
    await attachmentDecisions.dispose()
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
    // A deliberate reload revalidates the resource; remounting the same host Session then serves
    // the fresh response from disk cache without another request.
    expect(cacheRequests).toBe(2)

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
    expect(cacheRequests).toBe(2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

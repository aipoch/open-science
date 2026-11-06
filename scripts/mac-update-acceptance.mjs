/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  FEED_URL,
  assertAutomaticUpdate,
  digest,
  startFeed
} from './mac-update-acceptance-core.mjs'
import { preflight, run } from './mac-update-preflight.mjs'
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const wait = async (label, fn, timeout = 180000) => {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await delay(500)
  }
  throw new Error(`Timed out: ${label}; ${last?.message || 'not observed'}`)
}
const processes = async () => {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,lstart=,comm='])
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/.exec(line)
    return match ? [{ pid: +match[1], startedAt: Date.parse(match[2]), executable: match[3] }] : []
  })
}
const identity = (p) => p && `${p.pid}:${p.startedAt}:${p.executable}`
const one = async (directory, predicate) => {
  const names = (await readdir(directory)).filter(predicate)
  if (names.length !== 1)
    throw new Error(`Expected exactly one matching file in ${directory}: ${names}`)
  return join(directory, names[0])
}
const main = async () => {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('Acceptance requires disposable native macOS GitHub runner')
  const arg = (name) => {
    const i = process.argv.indexOf(name)
    if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`)
    return resolve(process.argv[i + 1])
  }
  const previous = arg('--previous-dir')
  const current = arg('--current-dir')
  const output = arg('--output')
  const expectedSha = process.env.GITHUB_SHA
  await mkdir(output, { recursive: true })
  const report = {
    scenario: 'normal-update',
    status: 'failed',
    sourceSha: expectedSha,
    arch: process.arch,
    runId: process.env.GITHUB_RUN_ID,
    launchesByHarness: [],
    cleanup: {}
  }
  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'open-science-mac-update-'))
  const logs = []
  let feed
  let sourceBrowser
  let targetBrowser
  let sentinelBrowser
  let originalKeychains
  let fixtureKeychain
  let failure
  const children = []
  try {
    await preflight(output)
    const { load } = await import('js-yaml')
    const { chromium, expect } = await import('@playwright/test')
    const prepared = []
    for (const [label, directory] of [
      ['source', previous],
      ['target', current]
    ]) {
      const provenance = JSON.parse(
        await readFile(join(directory, 'diagnostic-build.json'), 'utf8')
      )
      if (!provenance.internalTestBuild || provenance.commit !== expectedSha)
        throw new Error('Both packages must be internal builds of the exact acceptance SHA')
      const zip = await one(directory, (name) => name.endsWith(`-mac-${process.arch}.zip`))
      const extracted = join(root, label)
      await mkdir(extracted)
      await run('/usr/bin/ditto', ['-x', '-k', zip, extracted])
      const app = await one(extracted, (name) => name.endsWith('.app'))
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
      const details = await run('/usr/bin/codesign', ['-d', '--verbose=4', app])
      if (
        !details.stderr.split('\n').includes('TeamIdentifier=87G9WFU9H3') ||
        !details.stderr.split('\n').includes('Identifier=com.aipoch.open-science')
      )
        throw new Error('Official signing identity is required; ad-hoc packages are not accepted')
      const version = (
        await run('/usr/libexec/PlistBuddy', [
          '-c',
          'Print :CFBundleShortVersionString',
          join(app, 'Contents/Info.plist')
        ])
      ).stdout.trim()
      if (version !== provenance.version)
        throw new Error('Signed bundle version does not match build provenance')
      const config = load(await readFile(join(app, 'Contents/Resources/app-update.yml'), 'utf8'))
      if (config.url !== FEED_URL || config.provider !== 'generic' || config.channel !== 'latest')
        throw new Error(
          'Isolated feed must be embedded before signing; signed bundle will never be modified'
        )
      prepared.push({
        label,
        zip,
        app,
        version,
        provenance,
        sha256: await digest(zip),
        signingTeam: '87G9WFU9H3'
      })
    }
    const [source, target] = prepared
    const { gt } = await import('semver')
    if (!gt(target.version, source.version)) throw new Error('Target version must be newer')
    report.packages = prepared.map(({ label, version, provenance, sha256, signingTeam }) => ({
      label,
      version,
      provenance,
      sha256,
      signingTeam
    }))
    const feedPath = await one(current, (name) => name === `${process.arch}-mac.yml`)
    const metadata = load(await readFile(feedPath, 'utf8'))
    const selected = metadata.files?.find((f) => f.url === basename(target.zip))
    if (
      metadata.version !== target.version ||
      !selected ||
      selected.sha512 !== (await digest(target.zip, 'sha512', 'base64')) ||
      selected.size !== (await stat(target.zip)).size
    )
      throw new Error('Target feed version, size or SHA-512 does not match package')
    report.feedSha256 = await digest(feedPath)
    feed = await startFeed(
      new Map([
        ['/latest-mac.yml', feedPath],
        [`/${basename(target.zip)}`, target.zip]
      ])
    )
    const profile = join(root, 'electron-profile')
    const configRoot = join(root, 'saved-data')
    const sentinelApp = join(root, 'another-installation', basename(source.app))
    await cp(source.app, sentinelApp, { recursive: true })
    const executable = join(source.app, 'Contents/MacOS/Open-Science')
    const sentinelExecutable = join(sentinelApp, 'Contents/MacOS/Open-Science')
    // Real packaged secret storage, restricted to the disposable runner and fixture keychain.
    originalKeychains = (
      (await run('/usr/bin/security', ['list-keychains', '-d', 'user'])).stdout.match(
        /"([^"]+)"/g
      ) || []
    ).map((v) => v.slice(1, -1))
    if (!originalKeychains.length) throw new Error('Cannot snapshot Keychain search list')
    fixtureKeychain = join(root, 'acceptance.keychain-db')
    const password = randomBytes(32).toString('hex')
    await run('/usr/bin/security', ['create-keychain', '-p', password, fixtureKeychain])
    await run('/usr/bin/security', ['unlock-keychain', '-p', password, fixtureKeychain])
    await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', fixtureKeychain])
    const helper = join(
      source.app,
      'Contents/Resources/backend/node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_secret'
    )
    const sentinelHelper = join(
      sentinelApp,
      'Contents/Resources/backend/node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_secret'
    )
    await run('/usr/bin/security', [
      'add-generic-password',
      '-a',
      'Open-Science Key',
      '-s',
      'Open-Science Safe Storage',
      '-w',
      randomBytes(32).toString('hex'),
      '-T',
      executable,
      '-T',
      helper,
      '-T',
      sentinelExecutable,
      '-T',
      sentinelHelper,
      fixtureKeychain
    ])
    const launchSource = (path, storage, userData) => {
      const child = spawn(path, ['--remote-debugging-port=0', '--serve=0'], {
        detached: true,
        env: {
          ...process.env,
          OPEN_SCIENCE_CONFIG_ROOT: storage,
          OPEN_SCIENCE_E2E_STORAGE_ROOT: storage,
          OPEN_SCIENCE_USER_DATA: userData
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      children.push(child)
      report.launchesByHarness.push({
        executable: path,
        pid: child.pid,
        purpose: path === executable ? 'source-only' : 'protected-other-installation'
      })
      child.on('error', (error) => logs.push(error.message))
      child.stdout.on('data', (b) => logs.push(b.toString()))
      child.stderr.on('data', (b) => logs.push(b.toString()))
      return child
    }
    const connect = async (userData, pid) => {
      const port = (await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 })
      try {
        const session = await browser.newBrowserCDPSession()
        const info = await session.send('SystemInfo.getProcessInfo')
        await session.detach()
        if (!info.processInfo.some((p) => p.type === 'browser' && +p.id === pid))
          throw new Error('CDP browser does not belong to externally observed target PID')
        const page = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().startsWith('file:'))
        if (!page) throw new Error('No real renderer window')
        await page.waitForFunction(() => Boolean(window.api?.update), undefined, { timeout: 3000 })
        return { browser, page }
      } catch (error) {
        await browser.close()
        throw error
      }
    }
    const readBackend = async (dataRoot) => {
      const state = JSON.parse(await readFile(join(dataRoot, 'web-service.json'), 'utf8'))
      const token = (await readFile(join(dataRoot, 'web-token'), 'utf8')).trim()
      const response = await fetch(
        `http://127.0.0.1:${state.port}/api/bootstrap?token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(15000) }
      )
      if (!response.ok) throw new Error(`Packaged backend HTTP ${response.status}`)
      return response.json()
    }
    const readFixture = (page, fixture) =>
      page.evaluate(
        async ({ projectId, sessionId }) => ({
          projects: await window.api.projects.list(),
          session: await window.api.sessions.loadOne({ projectId, sessionId })
        }),
        { projectId: fixture.project.id, sessionId: fixture.session.id }
      )
    const sentinelConfig = join(root, 'other-data')
    const sentinelProfile = join(root, 'other-profile')
    const sentinel = launchSource(sentinelExecutable, sentinelConfig, sentinelProfile)
    const sentinelProcess = await wait('protected other installation process', async () =>
      (await processes()).find((p) => p.pid === sentinel.pid && p.executable === sentinelExecutable)
    )
    const sentinelConnection = await wait('other installation desktop CDP', () =>
      connect(sentinelProfile, sentinel.pid)
    )
    sentinelBrowser = sentinelConnection.browser
    const sentinelPage = sentinelConnection.page
    await sentinelPage.waitForFunction(
      async () => (await window.api.databaseStartup.getState()).phase === 'ready',
      undefined,
      { timeout: 60000 }
    )
    const sentinelFixture = await sentinelPage.evaluate(async (cwd) => {
      const project = await window.api.projects.create({
        name: 'Other installation protected research 数据'
      })
      const session = {
        id: 'other-installation-saved-session',
        projectId: project.id,
        cwd,
        title: 'Protected other installation session',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        messages: [
          {
            id: 'sentinel-message',
            role: 'user',
            content: 'Other installation original saved scientific content 数据',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
      await window.api.sessions.saveSession(session)
      return {
        project: { id: project.id, name: project.name },
        session: { id: session.id, content: session.messages[0].content }
      }
    }, root)
    const sentinelBefore = await readFixture(sentinelPage, sentinelFixture)
    const sentinelBackendBefore = await wait('other installation backend', async () => {
      const backend = await readBackend(sentinelConfig)
      return backend.appVersion === source.version &&
        backend.configRoot === sentinelConfig &&
        backend.platform === 'darwin'
        ? backend
        : undefined
    })
    const sentinelWindowBefore = JSON.parse(
      (await run(join(output, 'gui-probe'), [String(sentinel.pid)])).stdout
    )
    if (
      sentinelWindowBefore.onScreenWindows < 1 ||
      sentinelBefore.projects.find((p) => p.id === sentinelFixture.project.id)?.name !==
        sentinelFixture.project.name ||
      sentinelBefore.session?.messages[0]?.content !== sentinelFixture.session.content
    )
      throw new Error('Other installation was not ready with readable saved data before update')
    report.sentinelBefore = {
      process: sentinelProcess,
      backend: sentinelBackendBefore,
      window: sentinelWindowBefore,
      data: sentinelBefore
    }
    await sentinelPage.screenshot({ path: join(output, 'other-installation-before.png') })
    const sourceChild = launchSource(executable, configRoot, profile)
    const sourceConnection = await wait('source desktop CDP', () =>
      connect(profile, sourceChild.pid)
    )
    sourceBrowser = sourceConnection.browser
    const page = sourceConnection.page
    await page.waitForFunction(
      async () => (await window.api.databaseStartup.getState()).phase === 'ready',
      undefined,
      { timeout: 60000 }
    )
    await page.evaluate(async () => {
      await window.api.settings.markOnboardingComplete()
      await window.api.locale.setPreference({ preference: 'en' })
    })
    await page.reload()
    const fixture = await page.evaluate(async (cwd) => {
      const project = await window.api.projects.create({
        name: 'Mac update original research 数据'
      })
      const session = {
        id: 'mac-update-saved-session',
        projectId: project.id,
        cwd,
        title: 'Original session',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        messages: [
          {
            id: 'original-message',
            role: 'user',
            content: 'Saved original scientific content 数据',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
      await window.api.sessions.saveSession(session)
      return {
        project: { id: project.id, name: project.name },
        session: { id: session.id, content: session.messages[0].content }
      }
    }, root)
    await page.getByRole('button', { name: /^Settings$/ }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const nav = settings.getByRole('navigation', { name: 'Settings', exact: true })
    if (!(await nav.isVisible()))
      await settings.getByRole('button', { name: 'Open settings navigation' }).click()
    await nav.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: 'Check now', exact: true }).click()
    await page.getByRole('button', { name: `Update to ${target.version}`, exact: true }).click()
    await page.getByRole('button', { name: /^Download update/ }).click()
    const restart = page.getByRole('button', { name: 'Restart to update', exact: true })
    await expect(restart).toBeVisible({ timeout: 180000 })
    await page.screenshot({ path: join(output, 'before-update.png') })
    const appliedAt = Math.floor(Date.now() / 1000) * 1000 // ps lstart has second precision
    await restart.click()
    const successor = await wait('automatically started target PID', async () =>
      (await processes()).find(
        (p) => p.executable === executable && p.pid !== sourceChild.pid && p.startedAt >= appliedAt
      )
    )
    // Observation only: never spawn or open the target package to repair a failed relaunch.
    const connection = await wait('automatic target desktop CDP', () =>
      connect(profile, successor.pid)
    )
    targetBrowser = connection.browser
    const targetPage = connection.page
    await targetPage.waitForFunction(
      async () => (await window.api.databaseStartup.getState()).phase === 'ready',
      undefined,
      { timeout: 60000 }
    )
    const data = await targetPage.evaluate(
      async ({ projectId, sessionId }) => ({
        app: await window.api.update.getAppInfo(),
        projects: await window.api.projects.list(),
        session: await window.api.sessions.loadOne({ projectId, sessionId }),
        storage: await window.api.storage.getStatus()
      }),
      { projectId: fixture.project.id, sessionId: fixture.session.id }
    )
    const bootstrap = await readBackend(configRoot)
    const nativeWindow = JSON.parse(
      (await run(join(output, 'gui-probe'), [String(successor.pid)])).stdout
    )
    const sentinelAfter = (await processes()).find((p) => p.pid === sentinel.pid)
    const sentinelData = await readFixture(sentinelPage, sentinelFixture)
    const sentinelBackend = await readBackend(sentinelConfig)
    const sentinelWindow = JSON.parse(
      (await run(join(output, 'gui-probe'), [String(sentinel.pid)])).stdout
    )
    report.sentinelAfter = {
      process: sentinelAfter,
      backend: sentinelBackend,
      window: sentinelWindow,
      data: sentinelData
    }
    await sentinelPage.screenshot({ path: join(output, 'other-installation-after.png') })
    const observation = {
      sentinelBackendReady:
        sentinelBackend.appVersion === source.version &&
        sentinelBackend.configRoot === sentinelConfig &&
        sentinelBackend.platform === 'darwin',
      sentinelWindowVisible:
        sentinelWindow.onScreenWindows > 0 && (await sentinelPage.locator('body').isVisible()),
      sentinelDataPreserved:
        sentinelData.projects.find((p) => p.id === sentinelFixture.project.id)?.name ===
          sentinelFixture.project.name &&
        sentinelData.session?.id === sentinelFixture.session.id &&
        sentinelData.session.messages?.[0]?.content === sentinelFixture.session.content,
      process: successor,
      launchedByHarness: false,
      version: data.app.version,
      nativeWindowVisible: nativeWindow.onScreenWindows > 0,
      rendererReady: await targetPage.locator('body').isVisible(),
      backendReady: bootstrap.appVersion === target.version && bootstrap.platform === 'darwin',
      configRoot: bootstrap.configRoot,
      profilePath: profile,
      project: data.projects.find((p) => p.id === fixture.project.id),
      session: data.session,
      sentinelIdentity: identity(sentinelAfter),
      ...feed.metrics
    }
    report.observation = observation
    report.result = assertAutomaticUpdate(observation, {
      sourcePid: sourceChild.pid,
      appliedAt,
      executable,
      version: target.version,
      configRoot,
      profilePath: profile,
      ...fixture,
      sentinelIdentity: identity(sentinelProcess)
    })
    await targetPage.screenshot({ path: join(output, 'target-ready.png') })
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source.app])
    report.status = 'passed'
  } catch (error) {
    failure = error
    report.error = error.message
    for (const [label, browser] of [
      ['source', sourceBrowser],
      ['target', targetBrowser],
      ['other-installation', sentinelBrowser]
    ]) {
      try {
        const page = browser?.contexts().flatMap((context) => context.pages())[0]
        await page?.screenshot({ path: join(output, `${label}-failure.png`), timeout: 5000 })
      } catch {
        /* Disconnected windows cannot provide screenshots. Logs and JSON remain. */
      }
    }
  } finally {
    const clean = async (name, fn) => {
      try {
        await fn()
        report.cleanup[name] = true
      } catch (error) {
        report.cleanup[name] = error.message
        failure ||= error
        report.status = 'failed'
      }
    }
    await clean('cdpDisconnected', async () => {
      await sourceBrowser?.close()
      await targetBrowser?.close()
      await sentinelBrowser?.close()
    })
    await clean('processesStopped', async () => {
      // Resolve current executable ownership again; never kill a reused historical PID.
      for (const p of await processes())
        if (p.executable.startsWith(`${root}/`)) {
          try {
            process.kill(p.pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
      for (const child of children) {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }
      await wait(
        'fixture processes to stop',
        async () => !(await processes()).some((p) => p.executable.startsWith(`${root}/`)),
        10000
      )
    })
    await clean('feedClosed', async () => feed?.close())
    await clean('keychainRestored', async () => {
      if (originalKeychains)
        await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...originalKeychains])
      if (fixtureKeychain) await run('/usr/bin/security', ['delete-keychain', fixtureKeychain])
    })
    // Raw stderr can contain service tokens. Keep equivalent diagnostics with tokens redacted.
    await writeFile(
      join(output, 'app.log'),
      logs.join('').replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]')
    )
    await clean('fixtureRootRemoved', async () => rm(root, { recursive: true, force: true }))
    await writeFile(join(output, 'normal-update.json'), JSON.stringify(report, null, 2))
  }
  if (failure) throw failure
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
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
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='])
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/.exec(
      line
    )
    return match
      ? [{ pid: +match[1], ppid: +match[2], startedAt: Date.parse(match[3]), executable: match[4] }]
      : []
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
  const scenarioId = process.argv.includes('--scenario')
    ? process.argv[process.argv.indexOf('--scenario') + 1]
    : 'M01'
  if (!/^M(?:0[1-9]|1[0-4])$/.test(scenarioId)) throw new Error('Unknown fixed Mac scenario')
  const expectedSha = process.env.GITHUB_SHA
  await mkdir(output, { recursive: true })
  const report = {
    scenario: scenarioId,
    status: 'failed',
    sourceSha: expectedSha,
    arch: process.arch,
    runId: process.env.GITHUB_RUN_ID,
    launchesByHarness: [],
    cleanup: {}
  }
  const root = await realpath(
    await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'open-science-mac-update-'))
  )
  const logs = []
  let feed
  let sourceBrowser
  let sentinelBrowser
  let originalKeychains
  let fixtureKeychain
  let failure
  const children = []
  const attachedBrowsers = new Set()
  let scenario
  let admissionObserver
  let ctx
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
      const zip = await one(directory, (name) =>
        name.endsWith(
          label === 'source' ? `-mac-${process.arch}.zip` : `-mac-${process.arch}-runtime.zip`
        )
      )
      const extracted = join(root, label)
      await mkdir(extracted)
      await run('/usr/bin/ditto', ['-x', '-k', zip, extracted])
      const entryApp = await one(extracted, (name) => name.endsWith('.app'))
      let app = entryApp
      let entryConfiguration
      if (label === 'source') {
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', entryApp])
        const entryDetails = (
          await run('/usr/bin/codesign', ['-d', '--verbose=4', entryApp])
        ).stderr.split('\n')
        if (
          !entryDetails.includes('Identifier=com.aipoch.open-science.launcher') ||
          !entryDetails.includes('TeamIdentifier=87G9WFU9H3')
        )
          throw new Error('Source ordinary entry must have the official stable launcher identity')
        entryConfiguration = JSON.parse(
          await readFile(join(entryApp, 'Contents/Resources/mac-recovery-entry.json'), 'utf8')
        )
        const seed = join(entryApp, 'Contents/Resources/runtime-seed.zip')
        if (
          entryConfiguration.schema !== 1 ||
          entryConfiguration.runtimeBundleIdentifier !== 'com.aipoch.open-science' ||
          entryConfiguration.seedSha512 !== (await digest(seed, 'sha512', 'base64'))
        )
          throw new Error('Stable source entry seed identity or SHA-512 is invalid')
        const seedRoot = join(root, 'source-runtime-inspection')
        await mkdir(seedRoot)
        await run('/usr/bin/ditto', ['-x', '-k', seed, seedRoot])
        app = await one(seedRoot, (name) => name.endsWith('.app'))
      }
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
      if (entryConfiguration && entryConfiguration.seedVersion !== version)
        throw new Error('Stable entry seed version does not match its signed runtime')
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
        entryApp: label === 'source' ? entryApp : undefined,
        entryConfiguration,
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
    let profile = join(root, 'electron-profile')
    const configRoot = join(root, 'saved-data')
    const runtimeRoot = join(root, 'runtimes')
    await mkdir(runtimeRoot)
    const entryApp = await realpath(source.entryApp)
    const entryExecutableName = (
      await run('/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleExecutable',
        join(entryApp, 'Contents/Info.plist')
      ])
    ).stdout.trim()
    const entryExecutable = join(entryApp, 'Contents/MacOS', entryExecutableName)
    const entryExecutableBefore = await digest(entryExecutable)
    const sentinelEntry = join(root, 'another-installation', basename(entryApp))
    await cp(entryApp, sentinelEntry, { recursive: true })
    const installedRuntime = (entry) =>
      join(runtimeRoot, createHash('sha256').update(entry).digest('hex'), 'Open-Science.app')
    const runtimeTemplate = source.app
    source.app = installedRuntime(entryApp)
    const sentinelApp = installedRuntime(await realpath(sentinelEntry))
    const executable = join(source.app, 'Contents/MacOS/Open-Science')
    const sentinelExecutable = join(sentinelApp, 'Contents/MacOS/Open-Science')
    const stateRoot = join(root, 'installation-state')
    const ownedHandoffs = []
    ctx = {
      root,
      output,
      appBundle: source.app,
      entryApp,
      runtimeRoot,
      executable,
      profile,
      configRoot,
      stateRoot,
      appDataRoot: join(homedir(), 'Library/Application Support'),
      ownedHandoffs,
      targetVersion: target.version,
      sourceVersion: source.version,
      feed,
      report,
      wait,
      processes,
      run,
      logs,
      children
    }
    const { loadMacUpdateScenario } = await import('./mac-update-fault-scenarios.mjs')
    ctx.registerOwnedHandoff = async (bound) => {
      const { validateOwnedHandoff } = await import('./mac-update-fault-scenarios.mjs')
      const directory = await validateOwnedHandoff(ctx, bound)
      if (!ownedHandoffs.some((entry) => entry.directory === directory))
        ownedHandoffs.push({ directory, bound })
    }
    scenario = await loadMacUpdateScenario(scenarioId, ctx)

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
      runtimeTemplate,
      'Contents/Resources/backend/node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_secret'
    )
    const sentinelHelper = join(
      runtimeTemplate,
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
      join(runtimeTemplate, 'Contents/MacOS/Open-Science'),
      '-T',
      helper,
      '-T',
      join(runtimeTemplate, 'Contents/MacOS/Open-Science'),
      '-T',
      sentinelHelper,
      fixtureKeychain
    ])
    const launchSource = async (path, storage, userData) => {
      const entry = path === executable ? entryApp : sentinelEntry
      const before = new Set(
        (await processes()).filter((row) => row.executable === path).map((row) => row.pid)
      )
      const environment = {
        ...(path === executable ? ctx.launchEnv : {}),
        OPEN_SCIENCE_MAC_RUNTIME_ROOT: runtimeRoot,
        OPEN_SCIENCE_INSTALLATION_STATE_ROOT: stateRoot,
        OPEN_SCIENCE_CONFIG_ROOT: storage,
        OPEN_SCIENCE_E2E_STORAGE_ROOT: storage,
        OPEN_SCIENCE_USER_DATA: userData
      }
      const arguments_ = ['-n']
      for (const [key, value] of Object.entries(environment))
        arguments_.push('--env', `${key}=${value}`)
      arguments_.push(entry, '--args', '--remote-debugging-port=0', '--serve=0')
      report.launchesByHarness.push({
        executable: entry,
        runtimeExecutable: path,
        purpose: path === executable ? 'source-ordinary-entry' : 'protected-other-ordinary-entry'
      })
      await run('/usr/bin/open', arguments_)
      const process = await wait(
        'ordinary launcher automatically creates its runtime process',
        async () =>
          (await processes()).find((row) => row.executable === path && !before.has(row.pid))
      )
      report.launchesByHarness.at(-1).runtimePid = process.pid
      return { pid: process.pid }
    }
    const connect = async (userData, pid) => {
      const port = (await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 })
      try {
        attachedBrowsers.add(browser)
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
    Object.assign(ctx, {
      connect,
      readFixture,
      readBackend,
      nativeWindow: async (pid) =>
        JSON.parse((await run(join(output, 'gui-probe'), [String(pid)])).stdout),
      readStatus: () => ctx.page.evaluate(() => window.api.update.getStatus()),
      readProductLogs: () => readFile(join(ctx.profile, 'desktop-logs/main.log'), 'utf8'),
      prepareProfile: async ({ page: profilePage, label }) => {
        await profilePage.waitForFunction(
          async () => (await window.api.databaseStartup.getState()).phase === 'ready',
          undefined,
          { timeout: 60000 }
        )
        return profilePage.evaluate(
          async ({ cwd, label }) => {
            const project = await window.api.projects.create({ name: label })
            const session = {
              id: `saved-${project.id}`,
              projectId: project.id,
              cwd,
              title: label,
              status: 'idle',
              createdAt: 1,
              updatedAt: 1,
              messages: [
                {
                  id: `message-${project.id}`,
                  role: 'user',
                  content: `Original saved content ${label}`,
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
          },
          { cwd: root, label }
        )
      },

      launchSameInstallation: async ({ configRoot: storage, profile: userData, purpose }) => {
        if (purpose === 'participant-data-verification' && report.result?.status !== 'passed')
          throw new Error(
            'Additional target profiles may launch only after automatic target success'
          )
        const child = await launchSource(executable, storage, userData)
        report.launchesByHarness.at(-1).purpose = purpose || 'same-installation-source-peer'
        const connection = await wait('additional profile desktop', () =>
          connect(userData, child.pid)
        )
        return { ...connection, pid: child.pid, child }
      },
      openOrdinaryEntry: async ({ pauseAt, startupPause, releaseFile } = {}) => {
        if (startupPause && !releaseFile?.startsWith(stateRoot + '/'))
          throw new Error('Invalid isolated startup fault gate')
        if (
          pauseAt &&
          (!['native-recovery-runtime-absent', 'native-recovery-installed'].includes(pauseAt) ||
            !releaseFile?.startsWith(root + '/'))
        )
          throw new Error('Invalid isolated native fault gate')
        report.launchesByHarness.push({
          executable: entryApp,
          purpose: 'ordinary-recovery-entry',
          profileFromMarker: true
        })
        await run('/usr/bin/open', [
          '-n',
          '--env',
          `OPEN_SCIENCE_INSTALLATION_STATE_ROOT=${stateRoot}`,
          '--env',
          `OPEN_SCIENCE_MAC_RUNTIME_ROOT=${runtimeRoot}`,
          ...(pauseAt
            ? [
                '--env',
                `OPEN_SCIENCE_MAC_ENTRY_PAUSE_AT=${pauseAt}`,
                '--env',
                `OPEN_SCIENCE_MAC_ENTRY_RELEASE_FILE=${releaseFile}`
              ]
            : []),
          ...(startupPause
            ? [
                '--env',
                'OPEN_SCIENCE_MAC_STARTUP_PAUSE_AT=verified-ready',
                '--env',
                `OPEN_SCIENCE_MAC_STARTUP_RELEASE_FILE=${releaseFile}`
              ]
            : []),
          entryApp,
          '--args',
          '--remote-debugging-port=0',
          '--serve=0'
        ])
      }
    })
    await scenario.prepareLaunch?.(ctx)
    const sentinelConfig = join(root, 'other-data')
    const sentinelProfile = join(root, 'other-profile')
    const sentinel = await launchSource(sentinelExecutable, sentinelConfig, sentinelProfile)
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
    const sourceChild = await launchSource(executable, configRoot, profile)
    const sourceConnection = await wait('source desktop CDP', () =>
      connect(profile, sourceChild.pid)
    )
    sourceBrowser = sourceConnection.browser
    let page = sourceConnection.page
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
    Object.assign(ctx, {
      page,
      browser: sourceBrowser,
      sourceBrowser,
      sourcePid: sourceChild.pid,
      fixture,
      setInitiator: (next) => {
        page = next.page
        profile = next.profile
        sourceBrowser = next.browser
        Object.assign(ctx, {
          page,
          browser: sourceBrowser,
          sourceBrowser,
          sourcePid: next.pid,
          profile
        })
      }
    })
    await scenario.beforeDownload?.(ctx)
    page = ctx.page
    await page.getByRole('button', { name: /^Settings$/ }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const nav = settings.getByRole('navigation', { name: 'Settings', exact: true })
    if (!(await nav.isVisible()))
      await settings.getByRole('button', { name: 'Open settings navigation' }).click()
    await nav.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: 'Check now', exact: true }).click()
    await page.getByRole('button', { name: `Update to ${target.version}`, exact: true }).click()
    await page.getByRole('button', { name: /^Download update/ }).click()
    await scenario.duringDownload?.(ctx)
    let restart = page.getByRole('button', { name: 'Restart to update', exact: true })
    await expect(restart).toBeVisible({ timeout: 180000 })
    await scenario.afterDownloaded?.(ctx)
    await scenario.beforeApply?.(ctx)
    page = ctx.page
    restart = page.getByRole('button', { name: 'Restart to update', exact: true })
    await page.screenshot({ path: join(output, 'before-update.png') })
    const appliedAt = Math.floor(Date.now() / 1000) * 1000 // ps lstart has second precision
    ctx.appliedAt = appliedAt
    const { observeAutomaticTarget, watchUpdateAdmissions } =
      await import('./mac-update-target-observation.mjs')
    admissionObserver = watchUpdateAdmissions(ctx)
    const defaultApply = () =>
      ctx.page.getByRole('button', { name: 'Restart to update', exact: true }).click()
    if (scenario.apply) await scenario.apply(ctx, defaultApply)
    else await defaultApply()
    await scenario.afterApply?.(ctx)
    const { successor, targetReadiness } = await wait(
      'automatic target process, native window and original data readiness',
      async () => {
        for (const candidate of await processes()) {
          if (
            candidate.executable !== executable ||
            candidate.pid === ctx.sourcePid ||
            candidate.startedAt < appliedAt
          )
            continue
          try {
            const targetReadiness = await observeAutomaticTarget(ctx, candidate)
            return { successor: candidate, targetReadiness }
          } catch {
            /* An original-version recovery process is not target completion. */
          }
        }
        return undefined
      }
    )
    // Squirrel does not promise to preserve CDP launch flags. Use the authenticated real backend
    // owner and its native process ancestry, plus the actual shown native window, to observe target.
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
      ...targetReadiness,
      sentinelIdentity: identity(sentinelAfter),
      ...feed.metrics
    }
    report.observation = observation
    report.result = assertAutomaticUpdate(observation, {
      sourcePid: ctx.sourcePid,
      appliedAt,
      executable,
      version: target.version,
      configRoot,
      profilePath: profile,
      ...fixture,
      sentinelIdentity: identity(sentinelProcess)
    })
    Object.assign(ctx, {
      successor,
      readTargetFixture: async (requested) => {
        const result = await observeAutomaticTarget({ ...ctx, fixture: requested }, successor)
        return { projects: result.project ? [result.project] : [], session: result.session }
      }
    })
    await scenario.afterUpdate?.(ctx, observation)
    await run('/usr/sbin/screencapture', [
      '-x',
      '-l',
      String(targetReadiness.nativeWindow.windowNumber),
      join(output, 'target-ready.png')
    ])
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source.app])
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', entryApp])
    if ((await digest(entryExecutable)) !== entryExecutableBefore)
      throw new Error('The stable ordinary entry executable changed during runtime update')
    report.entryPreserved = {
      executableSha256: entryExecutableBefore,
      originalEntryBundle: entryApp,
      runtimeInstallation: source.app
    }
    report.status = 'passed'
  } catch (error) {
    failure = error
    report.error = error.message
    for (const [label, browser] of [
      ['source', sourceBrowser],
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
    await clean('admissionObserverStopped', async () => admissionObserver?.stop())
    await clean('scenarioCleanup', async () => scenario?.cleanup?.(ctx))
    await clean('cdpDisconnected', async () => {
      await sourceBrowser?.close()
      await sentinelBrowser?.close()
      for (const browser of attachedBrowsers) await browser.close()
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
    await clean('ownedHandoffsRemoved', async () => {
      const { validateOwnedHandoff } = await import('./mac-update-fault-scenarios.mjs')
      for (const entry of ctx?.ownedHandoffs || []) {
        try {
          await validateOwnedHandoff(ctx, entry.bound)
        } catch (error) {
          if (error.code === 'ENOENT') continue
          throw error
        }
        await rm(entry.directory, { recursive: true, force: true })
      }
    })
    await clean('feedClosed', async () => feed?.close())
    await clean('keychainRestored', async () => {
      if (originalKeychains)
        await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...originalKeychains])
      if (fixtureKeychain) await run('/usr/bin/security', ['delete-keychain', fixtureKeychain])
    })
    // Raw stderr can contain service tokens. Keep equivalent diagnostics with tokens redacted.
    try {
      if (ctx?.readProductLogs) logs.push(await ctx.readProductLogs())
    } catch {
      /* Startup can fail before logs exist. */
    }
    await writeFile(
      join(output, 'app.log'),
      logs.join('').replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]')
    )
    await clean('fixtureRootRemoved', async () => rm(root, { recursive: true, force: true }))
    await writeFile(
      join(output, scenarioId === 'M01' ? 'normal-update.json' : `${scenarioId}.json`),
      JSON.stringify(report, null, 2)
    )
  }
  if (failure) throw failure
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})

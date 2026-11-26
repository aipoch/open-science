/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Run in Electron on macOS. Only the release origin and cache directory are fixtures.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { app } = require('electron')
const { MacUpdater } = require('electron-updater')
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor')
const { load } = require('js-yaml')

const root = fs.mkdtempSync(join(tmpdir(), 'mac-zip-differential-'))
app.setPath('userData', root)

async function run() {
  assert.equal(process.platform, 'darwin')
  await app.whenReady()
  const files = new Map()
  const zipPath = (v) => `/releases/${v}/aipoch-open-science-${v}-mac-${process.arch}.zip`
  const old = zipPath('1.0.0')
  const target = zipPath('2.0.0')
  fs.writeFileSync(join(root, 'shared'), randomBytes(512 * 1024))
  for (const path of [old, target]) {
    const zip = root + path
    fs.mkdirSync(join(zip, '..'), { recursive: true })
    fs.writeFileSync(join(root, 'revision'), path)
    execFileSync('zip', ['-Xq0', zip, 'shared', 'revision'], { cwd: root })
    execFileSync('node', [
      join(__dirname, '../regenerate-mac-feed.mjs'),
      join(zip, '..'),
      process.arch
    ])
    const [{ sha512, size }] = load(
      fs.readFileSync(join(zip, '..', process.arch + '-mac.yml'), 'utf8')
    ).files
    execFileSync('python3', [join(__dirname, 'verify-mac-zip-blockmaps.py'), zip])
    files.set(path, fs.readFileSync(zip))
    files.set(path + '.blockmap', fs.readFileSync(zip + '.blockmap'))
    if (path === target)
      files.set(
        '/latest-mac.yml',
        Buffer.from(
          JSON.stringify({
            version: '2.0.0',
            files: [{ url: path.slice(1), sha512, size }]
          })
        )
      )
  }

  // Same-size stale maps can pass a manifest size check after stapling.
  fs.writeFileSync(root + target + '.blockmap', files.get(old + '.blockmap'))
  assert.throws(
    () =>
      execFileSync('python3', [join(__dirname, 'verify-mac-zip-blockmaps.py'), root + target], {
        stdio: 'pipe'
      }),
    /Blockmap differs from final ZIP/
  )
  fs.writeFileSync(root + target + '.blockmap', files.get(target + '.blockmap'))

  let scenario
  const requests = []
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    let body = files.get(path)
    if (!body || path === scenario) return res.writeHead(404).end()
    const range = req.headers.range
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)
      if (!match) return res.writeHead(416).end()
      const total = body.length
      body = body.subarray(Number(match[1]), Number(match[2]) + 1)
      if (scenario === 'bad range') body = Buffer.alloc(body.length)
      res.writeHead(206, {
        'Content-Range': `bytes ${match[1]}-${match[2]}/${total}`,
        'Content-Length': body.length
      })
    } else res.writeHead(200, { 'Content-Length': body.length })
    requests.push({ path, range, bytes: body.length })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const [index, [mode, reason]] of [
      ['warm', null],
      ['cold', 'No cached update.zip'],
      [old + '.blockmap', 'old blockmap download'],
      [target + '.blockmap', 'new blockmap download'],
      ['bad range', 'differential reconstruction']
    ].entries()) {
      scenario = mode
      requests.length = 0
      const cache = 'cache-' + index
      const config = join(root, cache + '.yml')
      fs.writeFileSync(config, `updaterCacheDirName: ${cache}\n`)
      fs.mkdirSync(join(root, cache))
      if (mode !== 'cold') fs.copyFileSync(root + old, join(root, cache, 'update.zip'))
      const updater = new MacUpdater(undefined, {
        version: '1.0.0',
        isPackaged: true,
        whenReady: () => app.whenReady(),
        userDataPath: root,
        baseCachePath: root,
        appUpdateConfigPath: config
      })
      updater.httpExecutor = new ElectronHttpExecutor()
      updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}` })
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      const messages = []
      const log = (message) => messages.push(String(message))
      updater.logger = { info: log, error: log, warn: log }
      try {
        await updater.checkForUpdates()
        await updater.downloadUpdate()
        assert.deepEqual(fs.readFileSync(join(root, cache, 'update.zip')), files.get(target))
        const transfers = requests.filter((req) => req.path === target)
        const full = transfers.filter((req) => !req.range)
        if (mode === 'warm') {
          assert.deepEqual(
            requests
              .filter((req) => req.path.endsWith('.blockmap'))
              .map((req) => req.path)
              .sort(),
            [old + '.blockmap', target + '.blockmap']
          )
          assert.equal(full.length, 0, messages.join('\n'))
          const bytes = transfers.reduce((sum, req) => sum + req.bytes, 0)
          assert(bytes > 0 && bytes < files.get(target).length)
          console.log(
            `Warm cache: ${transfers.length} Range request(s), ${bytes}/${files.get(target).length} ZIP bytes`
          )
        } else {
          assert(
            messages.some((message) => message.includes(reason)),
            messages.join('\n')
          )
          assert.equal(full.length, 1)
          console.log(`${reason}: full download, ${full[0].bytes} ZIP bytes`)
        }
      } finally {
        updater.closeServerIfExists()
      }
    }
  } finally {
    server.close()
  }
}

run()
  .then(
    () => 0,
    (error) => {
      console.error(error)
      return 1
    }
  )
  .then((code) => {
    fs.rmSync(root, { recursive: true, force: true })
    app.exit(code)
  })

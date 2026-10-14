/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports */
// Keep this bootstrap free of application/native addon imports. It runs before spawning the backend.
const { createHash, randomUUID } = require('node:crypto')
const {
  mkdirSync,
  existsSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  readdirSync
} = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { homedir } = require('node:os')

function installationRootForEntry(entryPath) {
  // AppImage mount directories change on every launch; coordinate the stable outer image.
  if (
    process.platform === 'linux' &&
    process.env.APPIMAGE &&
    process.env.APPDIR &&
    resolve(entryPath).startsWith(resolve(process.env.APPDIR) + '/')
  )
    return existsSync(process.env.APPIMAGE)
      ? realpathSync(process.env.APPIMAGE)
      : resolve(process.env.APPIMAGE)
  let existing = resolve(entryPath),
    suffix = ''
  while (!existsSync(existing)) {
    suffix = join(existing.slice(dirname(existing).length + 1), suffix)
    existing = dirname(existing)
  }
  const entry = resolve(realpathSync(existing), suffix)
  let cursor = dirname(entry)
  while (dirname(cursor) !== cursor) {
    if (cursor.endsWith(join('Contents', 'Resources'))) return dirname(dirname(cursor))
    if (cursor.endsWith('/resources') || cursor.endsWith('\\resources')) return dirname(cursor)
    cursor = dirname(cursor)
  }
  const backend = dirname(entry)
  return dirname(backend).endsWith('/out') || dirname(backend).endsWith('\\out')
    ? dirname(dirname(backend))
    : dirname(backend)
}
function protectInstallationStartup(entryPath, configRoot, stateRoot) {
  // Loading node:sqlite emits an experimental warning on Node 22; ordinary CLI commands
  // must not load it and contaminate their machine-readable output.
  const { DatabaseSync } = require('node:sqlite')
  const root = installationRootForEntry(entryPath)
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? root.toLowerCase() : root)
    .digest('hex')
  const directory = join(
    stateRoot ??
      process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT ??
      (process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT
        ? join(process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT, 'installations')
        : join(homedir(), '.open-science', 'installations')),
    key
  )
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const coordinator = new DatabaseSync(join(directory, 'coordinator.sqlite'))
  let lease
  let identity
  try {
    coordinator.exec('PRAGMA busy_timeout = 1500; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE')
    if (existsSync(join(directory, 'update-in-progress.json')))
      throw new Error('Installation update requires recovery before starting Open-Science.')
    let owner
    const helperFlags = [
      '--open-science-artifact-mcp',
      '--open-science-notebook-mcp',
      '--open-science-reviewer-mcp-proxy',
      '--open-science-skill-import-mcp',
      '--open-science-skill-runtime-mcp',
      '--open-science-plan-mcp'
    ]
    if (
      helperFlags.some((flag) => process.argv.includes(flag)) &&
      process.env.OPEN_SCIENCE_INSTALLATION_OWNER
    ) {
      const candidate = JSON.parse(process.env.OPEN_SCIENCE_INSTALLATION_OWNER)
      const tokenHash = createHash('sha256').update(String(candidate.token)).digest('hex')
      for (const name of readdirSync(directory).filter((name) =>
        /^[\da-f-]{36}\.json$/.test(name)
      )) {
        const registration = JSON.parse(readFileSync(join(directory, name), 'utf8'))
        if (
          registration.pid !== candidate.pid ||
          registration.generation !== candidate.generation ||
          registration.configRoot !== candidate.configRoot ||
          registration.helperTokenHash !== tokenHash
        )
          continue
        const probe = new DatabaseSync(join(directory, name.replace(/\.json$/, '.sqlite')))
        try {
          probe.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
        } catch (error) {
          if (error.errcode === 5 || error.errcode === 6)
            owner = {
              pid: candidate.pid,
              generation: candidate.generation,
              configRoot: candidate.configRoot
            }
          else throw error
        } finally {
          probe.close()
        }
      }
      if (!owner) throw new Error('The runtime helper installation capability is no longer valid.')
      configRoot = owner.configRoot
    }
    const id = randomUUID()
    identity = Object.freeze({
      pid: process.pid,
      generation: id,
      configRoot,
      installationRoot: root
    })
    lease = new DatabaseSync(join(directory, `${id}.sqlite`))
    lease.exec('PRAGMA busy_timeout = 1500; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE')
    writeFileSync(
      join(directory, `${id}.json`),
      JSON.stringify({
        pid: process.pid,
        generation: id,
        configRoot,
        ...(owner ? { role: 'helper', owner } : {})
      }),
      { flag: 'wx', mode: 0o600 }
    )
  } catch (error) {
    lease?.close()
    throw error
  } finally {
    coordinator.close()
  }
  let released = false
  return {
    identity,
    isHeld: () => !released,
    release() {
      if (!released) {
        released = true
        lease.close()
      }
    }
  }
}

module.exports = { installationRootForEntry, protectInstallationStartup }

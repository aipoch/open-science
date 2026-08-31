import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

import type { NotebookEnvironmentLockComponent } from '../../shared/notebook'
import type { SpawnResult } from './package-manager'
import { pythonBin } from './runtime-paths'
import { PIP_WHEEL_EVIDENCE_SCRIPT } from './pip-wheel-evidence'

const EVIDENCE_DIRECTORY = '.open-science-pip'
const MAX_BYTES = 2 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const normalizeName = (name: string): string => name.toLowerCase().replace(/[-_.]+/gu, '-')
const digest = (content: string): string => createHash('sha256').update(content).digest('hex')
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const parseObject = (raw: string): Record<string, unknown> | undefined => {
  try {
    return object(JSON.parse(raw))
  } catch {
    return undefined
  }
}

const readBounded = async (path: string): Promise<string | undefined> => {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return undefined
    const content = await readFile(path, 'utf8')
    return Buffer.byteLength(content) <= MAX_BYTES ? content : undefined
  } catch {
    return undefined
  }
}

const evidenceDirectory = async (prefix: string, create = false): Promise<string | undefined> => {
  try {
    const path = join(await realpath(prefix), EVIDENCE_DIRECTORY)
    if (create)
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    const stat = await lstat(path)
    return stat.isDirectory() && !stat.isSymbolicLink() ? path : undefined
  } catch {
    return undefined
  }
}

const distributions = async (prefix: string): Promise<string[]> => {
  const root = await realpath(prefix)
  const libraries = await readdir(join(root, 'lib')).catch(() => [])
  const sites = [
    join(root, 'Lib', 'site-packages'),
    ...libraries
      .filter((name) => /^python\d+\.\d+$/u.test(name))
      .map((name) => join(root, 'lib', name, 'site-packages'))
  ]
  const existingSites = [
    ...new Set(
      (await Promise.all(sites.map((site) => realpath(site).catch(() => undefined)))).filter(
        (site): site is string => site !== undefined
      )
    )
  ]
  // Multiple Python library trees leave the active distribution ambiguous; a native lock is needed.
  if (existingSites.length !== 1) return []
  const paths: string[] = []
  for (const site of existingSites) {
    for (const entry of await readdir(site, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue
      const path = await realpath(join(site, entry.name))
      const local = relative(root, path)
      if (local.startsWith('..') || isAbsolute(local)) continue
      paths.push(path)
    }
  }
  return [...new Set(paths)].sort()
}

const installedIdentity = async (
  path: string
): Promise<
  | {
      name: string
      version: string
      installedChecksum: string
    }
  | undefined
> => {
  const [metadata, record] = await Promise.all([
    readBounded(join(path, 'METADATA')),
    readBounded(join(path, 'RECORD'))
  ])
  if (!metadata || !record) return undefined
  const name = /^Name:[ \t]*([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*\r?$/mu.exec(metadata)?.[1]
  const version = /^Version:[ \t]*([A-Za-z0-9][A-Za-z0-9.!+_-]*)[ \t]*\r?$/mu.exec(metadata)?.[1]
  if (!name || !version) return undefined
  return { name: normalizeName(name), version, installedChecksum: digest(`${metadata}\0${record}`) }
}

const savePipReport = async (
  prefix: string,
  reportPath: string,
  expectedIdentities?: ReadonlyMap<string, string>
): Promise<void> => {
  const raw = await readBounded(reportPath)
  const report = raw && parseObject(raw)
  if (!report || report.version !== '1' || !Array.isArray(report.install)) return
  const wheels = new Map<string, { version: string; sha256: string }>()
  for (const value of report.install) {
    const item = object(value)
    const metadata = object(item?.metadata)
    const download = object(item?.download_info)
    const hash = object(object(download?.archive_info)?.hashes)?.sha256
    if (
      typeof metadata?.name !== 'string' ||
      typeof metadata.version !== 'string' ||
      typeof download?.url !== 'string' ||
      typeof hash !== 'string' ||
      !SHA256.test(hash)
    )
      continue
    const url = new URL(download.url)
    // Name/version pins can recover public PyPI wheels with hash verification. Private indexes,
    // local/editable installs and source builds need their own native lock; never guess their origin.
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'files.pythonhosted.org' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('.whl')
    )
      continue
    wheels.set(normalizeName(metadata.name), { version: metadata.version, sha256: hash })
  }
  if (wheels.size === 0) return
  const evidenceRoot = await evidenceDirectory(prefix, true)
  if (!evidenceRoot) return
  for (const path of await distributions(prefix)) {
    const identity = await installedIdentity(path)
    const wheel = identity && wheels.get(identity.name)
    if (!identity || !wheel || identity.version !== wheel.version) continue
    if (expectedIdentities && expectedIdentities.get(identity.name) !== identity.installedChecksum)
      continue
    const temporary = join(evidenceRoot, `${identity.name}.${randomUUID()}.tmp`)
    try {
      await writeFile(
        temporary,
        JSON.stringify({ schemaVersion: 1, ...identity, sha256: wheel.sha256 }),
        { flag: 'wx', mode: 0o600 }
      )
      await rename(temporary, join(evidenceRoot, `${identity.name}.json`))
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

// Evidence collection must not turn a successful package installation into a failed operation.
// Missing reports remain missing evidence, and the environment-lock owner fails closed later.
// Callers use PIP_REPORT so older pip versions ignore the unsupported setting rather than reject
// an unknown CLI option. Raw reports may contain private URLs and are always removed afterward.
const withPipInstallEvidence = async (
  prefix: string,
  install: (reportPath?: string) => Promise<SpawnResult>
): Promise<SpawnResult> => {
  const temporary = await mkdtemp(join(tmpdir(), 'open-science-pip-report-')).catch(() => undefined)
  if (!temporary) return install()
  const reportPath = join(temporary, 'report.json')
  try {
    const result = await install(reportPath)
    if (result.code === 0) await savePipReport(prefix, reportPath).catch(() => undefined)
    return result
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

const capturePipInstallEvidence = async (
  prefix: string
): Promise<Extract<NotebookEnvironmentLockComponent, { ecosystem: 'python' }> | undefined> => {
  const evidenceRoot = await evidenceDirectory(prefix)
  if (!evidenceRoot) return undefined
  const requirements = new Map<string, string>()
  for (const path of await distributions(prefix).catch(() => [])) {
    const identity = await installedIdentity(path)
    if (!identity) continue
    const raw = await readBounded(join(evidenceRoot, `${identity.name}.json`))
    if (!raw) continue
    const saved = parseObject(raw)
    if (
      !saved ||
      saved.schemaVersion !== 1 ||
      !identity ||
      saved.name !== identity.name ||
      saved.version !== identity.version ||
      saved.installedChecksum !== identity.installedChecksum ||
      typeof saved.sha256 !== 'string' ||
      !SHA256.test(saved.sha256)
    )
      continue
    requirements.set(
      identity.name,
      `${identity.name}==${identity.version} --hash=sha256:${saved.sha256}`
    )
  }
  if (requirements.size === 0) return undefined
  const content = `${[...requirements.values()].sort().join('\n')}\n`
  if (Buffer.byteLength(content) > MAX_BYTES) return undefined
  return {
    ecosystem: 'python',
    format: 'pip-requirements',
    resolution: 'locked',
    files: [{ path: 'pip/requirements.lock', content, checksum: digest(content) }]
  }
}

const recoverPipInstallEvidence = async (
  prefix: string,
  requiredPackages: string[],
  execute: (argv: string[]) => Promise<string>
): Promise<Extract<NotebookEnvironmentLockComponent, { ecosystem: 'python' }> | undefined> => {
  // Avoid starting a probe for absent, Conda-owned, local or editable distributions.
  const eligible: string[] = []
  const identities = new Map<string, string>()
  for (const path of await distributions(prefix).catch(() => [])) {
    const identity = await installedIdentity(path)
    if (!identity || !requiredPackages.includes(`python:${identity.name}`)) continue
    if ((await readBounded(join(path, 'INSTALLER')))?.trim() !== 'pip') continue
    if (
      await lstat(join(path, 'direct_url.json')).then(
        () => true,
        () => false
      )
    )
      continue
    eligible.push(`python:${identity.name}`)
    identities.set(identity.name, identity.installedChecksum)
  }
  if (!eligible.length) return undefined
  const temporary = await mkdtemp(join(tmpdir(), 'open-science-pip-recovery-')).catch(
    () => undefined
  )
  if (!temporary) return undefined
  try {
    const report = await execute([
      pythonBin(prefix),
      '-c',
      PIP_WHEEL_EVIDENCE_SCRIPT,
      prefix,
      JSON.stringify(eligible)
    ])
    if (Buffer.byteLength(report) > MAX_BYTES) return undefined
    const reportPath = join(temporary, 'report.json')
    await writeFile(reportPath, report, { flag: 'wx', mode: 0o600 })
    await savePipReport(prefix, reportPath, identities)
    return await capturePipInstallEvidence(prefix)
  } catch {
    return undefined
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}

export { withPipInstallEvidence, capturePipInstallEvidence, recoverPipInstallEvidence }

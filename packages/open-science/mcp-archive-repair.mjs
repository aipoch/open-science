/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  access as accessAsync,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { runtimeTargets } from './runtime-package.mjs'

const execFileAsync = promisify(execFile)
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const RELEASE_BASE_URL = 'https://github.com/aipoch/open-science/releases'
const FETCH_TIMEOUT_MS = 120_000
const EXTRACT_TIMEOUT_MS = 120_000
const MCP_VERIFY_TIMEOUT_MS = 30_000

const validVersion = (version) =>
  typeof version === 'string' && /^\d+\.\d+\.\d+(?:-nightly\.g[a-f0-9]{7})?$/u.test(version)

const validSourceSha = (sourceSha) =>
  typeof sourceSha === 'string' && /^[a-f0-9]{40}$/u.test(sourceSha)

const targetFor = (id) => runtimeTargets.find((target) => target.id === id)
const nodeName = (platform) => (platform === 'win32' ? 'node.exe' : 'node')
const archiveExtension = (platform) => (platform === 'win32' ? '.zip' : '.tar.gz')
const archiveStem = (filename, platform) => filename.slice(0, -archiveExtension(platform).length)

const archiveRootCandidate = async (directory, platform) => {
  let metadata
  try {
    metadata = await readJson(join(directory, 'release.json'))
    await Promise.all([
      accessAsync(join(directory, 'backend', 'cli.mjs')),
      accessAsync(join(directory, 'node-runtime', nodeName(platform)))
    ])
  } catch {
    return undefined
  }
  if (
    !validVersion(metadata.version) ||
    !targetFor(metadata.target) ||
    !validSourceSha(metadata.sourceSha)
  )
    return undefined
  return metadata
}

const installationFrom = (root, metadata, platform, arch) => {
  const target = targetFor(metadata.target)
  return {
    kind: 'archive',
    root,
    cliPath: join(root, 'backend', 'cli.mjs'),
    nodePath: join(root, 'node-runtime', nodeName(platform)),
    version: metadata.version,
    target: metadata.target,
    sourceSha: metadata.sourceSha,
    nodeVersion: metadata.nodeVersion,
    compatible: target.os === platform && target.cpu === arch
  }
}

export const findStandaloneInstallation = async ({
  cliPath,
  platform = process.platform,
  arch = process.arch
} = {}) => {
  if (typeof cliPath !== 'string' || !cliPath) return undefined
  let directory = normalize(dirname(cliPath))
  while (true) {
    const metadata = await archiveRootCandidate(directory, platform)
    if (metadata) return installationFrom(directory, metadata, platform, arch)
    const parent = dirname(directory)
    if (parent === directory || basename(directory) === '') return undefined
    directory = parent
  }
}

const repairError = (code, message) => Object.assign(new Error(message), { code })

const failure = (installation, profile, platform, arch, error) => ({
  status: 'failed',
  installation: 'archive',
  root: installation?.root,
  version: installation?.version,
  platform,
  arch,
  profile,
  error: {
    code:
      typeof error?.code === 'string' && error.code.startsWith('mcp_repair_')
        ? error.code
        : 'mcp_repair_failed',
    message: error.message ?? 'The standalone archive repair failed.',
    owner: 'deployment',
    requiresUser: true,
    retryable: false
  }
})

const releaseChannel = (version) =>
  version.includes('-nightly.g')
    ? { tag: 'nightly', checksums: 'CLI-SHA256SUMS.txt' }
    : { tag: 'latest', checksums: 'SHA256SUMS.txt' }

const releaseUrl = (baseUrl, channel, filename) => `${baseUrl}/${channel.tag}/download/${filename}`

const parseChecksums = (text, target, platform) => {
  const extension = archiveExtension(platform)
  const suffix = `-${target.id}${extension}`
  const entries = text
    .split(/\r?\n/u)
    .map((line) => /^\s*([a-f0-9]{64})\s+\*?(.+?)\s*$/iu.exec(line))
    .filter(Boolean)
    .map((match) => ({ sha256: match[1].toLowerCase(), filename: match[2] }))
    .filter(({ filename }) => filename.startsWith('open-science-cli-') && filename.endsWith(suffix))
  if (entries.length !== 1)
    throw repairError(
      'mcp_repair_release_invalid',
      'The official release does not contain one compatible CLI archive.'
    )
  const [entry] = entries
  const version = entry.filename.slice('open-science-cli-'.length, -suffix.length)
  if (!validVersion(version))
    throw repairError(
      'mcp_repair_release_invalid',
      'The official release contains invalid CLI archive metadata.'
    )
  return { ...entry, version }
}

const downloadResponse = async (fetchImpl, url) => {
  let response
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch {
    throw repairError('mcp_repair_download_failed', 'The official archive download failed.')
  }
  if (!response.ok)
    throw repairError(
      'mcp_repair_download_failed',
      `The official archive download failed (${response.status}).`
    )
  return response
}

const downloadFile = async (fetchImpl, url, destination) => {
  const response = await downloadResponse(fetchImpl, url)
  if (!response.body) {
    await writeFile(destination, Buffer.from(await response.arrayBuffer()), { flag: 'wx' })
    return
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }))
}

const sha256File = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export const extractStandaloneArchive = async ({
  archivePath,
  destination,
  expectedRoot,
  platform = process.platform,
  exec = execFileAsync
}) => {
  await mkdir(destination, { recursive: true })
  const archiveTool =
    platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  await exec(archiveTool, ['-xf', archivePath, '-C', destination], {
    timeout: EXTRACT_TIMEOUT_MS,
    windowsHide: true
  })
  await accessAsync(expectedRoot)
}

const verifyWindowsSignatures = async (root, nightly, exec) => {
  const script = `
param([string]$root, [string]$mode)
$ErrorActionPreference = 'Stop'
$files = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { @('.exe', '.dll', '.node') -contains $_.Extension.ToLowerInvariant() }
if ($files.Count -eq 0) { throw 'No Windows payloads found' }
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($mode -eq 'nightly' -and $signature.Status -eq 'NotSigned') { continue }
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) { throw "Invalid Windows signature: $($file.FullName) ($($signature.Status))" }
}
`
  const scriptPath = join(root, `.mcp-signature-${randomUUID()}.ps1`)
  await writeFile(scriptPath, script, 'utf8')
  let lastError
  try {
    for (const executable of ['pwsh', 'powershell.exe']) {
      try {
        await exec(
          executable,
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            scriptPath,
            root,
            nightly ? 'nightly' : 'stable'
          ],
          {
            timeout: EXTRACT_TIMEOUT_MS,
            windowsHide: true
          }
        )
        return
      } catch (error) {
        lastError = error
        if (error?.code !== 'ENOENT') throw error
      }
    }
  } finally {
    await rm(scriptPath, { force: true })
  }
  throw lastError
}

export const verifyStandaloneSignature = async ({
  root,
  platform,
  nightly = false,
  exec = execFileAsync
}) => {
  if (platform === 'linux' || (nightly && ['win32', 'darwin'].includes(platform))) return
  if (platform === 'win32') return verifyWindowsSignatures(root, nightly, exec)
  if (platform === 'darwin')
    await exec(
      'codesign',
      ['--verify', '--strict', '--deep', ...(nightly ? [] : ['--check-notarization']), root],
      { timeout: EXTRACT_TIMEOUT_MS }
    )
}

const waitForMcpResponse = (child, id, timeoutMs) => {
  let buffer = ''
  const responses = new Map()
  let resolveResponse
  let rejectResponse
  const promise = new Promise((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  const timer = setTimeout(
    () => rejectResponse(new Error(`MCP response ${id} timed out.`)),
    timeoutMs
  )
  const onData = (chunk) => {
    buffer += chunk.toString()
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        rejectResponse(new Error('MCP emitted non-JSON stdout during repair verification.'))
        return
      }
      if (message.id === id) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolveResponse(message)
        return
      }
      responses.set(message.id, message)
    }
  }
  child.stdout.on('data', onData)
  child.once('error', rejectResponse)
  child.once('exit', (code) => {
    if (code !== null) rejectResponse(new Error(`MCP exited before response ${id}.`))
  })
  return promise
}

export const verifyMcpHandshake = async ({
  root,
  profile,
  platform = process.platform,
  spawnProcess = spawn,
  timeoutMs = MCP_VERIFY_TIMEOUT_MS
}) => {
  const child = spawnProcess(
    join(root, 'node-runtime', nodeName(platform)),
    [join(root, 'backend', 'cli.mjs'), 'mcp', '--profile', profile],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  )
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'open-science-repair', version: '1.0.0' }
        }
      }) + '\n'
    )
    const initialized = await waitForMcpResponse(child, 1, timeoutMs)
    if (initialized.error) throw new Error('MCP initialize failed during repair verification.')
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
    )
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n'
    )
    const tools = await waitForMcpResponse(child, 2, timeoutMs)
    if (tools.error || !Array.isArray(tools.result?.tools))
      throw new Error('MCP tools/list failed during repair verification.')
    return { initialize: 'verified', toolsList: 'verified', toolCount: tools.result.tools.length }
  } finally {
    child.kill()
  }
}

const readStandaloneMetadata = async (root, platform) => {
  const metadata = await readJson(join(root, 'release.json'))
  await Promise.all([
    accessAsync(join(root, 'backend', 'cli.mjs')),
    accessAsync(join(root, 'node-runtime', nodeName(platform)))
  ])
  if (
    !validVersion(metadata.version) ||
    !targetFor(metadata.target) ||
    !validSourceSha(metadata.sourceSha)
  )
    throw repairError(
      'mcp_repair_release_invalid',
      'The downloaded archive has invalid release metadata.'
    )
  return metadata
}

const verifyArchiveTarget = (metadata, expectedVersion, target, platform, arch) => {
  if (
    metadata.version !== expectedVersion ||
    metadata.target !== target.id ||
    target.os !== platform ||
    target.cpu !== arch
  )
    throw repairError(
      'mcp_repair_incompatible_target',
      'The downloaded archive is not compatible with this host.'
    )
}

export const repairStandaloneMcp = async ({
  profile,
  installation,
  cliPath,
  platform = process.platform,
  arch = process.arch,
  checkDependency = async () => ({ available: false }),
  fetchImpl = fetch,
  releaseBaseUrl = RELEASE_BASE_URL,
  extractArchive = extractStandaloneArchive,
  verifySignature = verifyStandaloneSignature,
  verifyMcp = verifyMcpHandshake
} = {}) => {
  const current = installation ?? (await findStandaloneInstallation({ cliPath, platform, arch }))
  if (!current) {
    return failure(undefined, profile, platform, arch, {
      code: 'mcp_repair_unsupported_installation',
      message: 'This installation is not a standalone CLI archive. Use its official updater.'
    })
  }
  if ((await checkDependency()).available)
    return {
      status: 'already_healthy',
      installation: 'archive',
      version: current.version,
      target: current.target,
      platform,
      arch,
      profile,
      root: current.root
    }
  if (!current.compatible)
    return failure(current, profile, platform, arch, {
      code: 'mcp_repair_incompatible_target',
      message: 'The installed standalone archive does not match this host platform or architecture.'
    })

  let temporary
  try {
    const target = targetFor(current.target)
    const channel = releaseChannel(current.version)
    const checksumsUrl = releaseUrl(releaseBaseUrl, channel, channel.checksums)
    const checksums = await (await downloadResponse(fetchImpl, checksumsUrl)).text()
    const release = parseChecksums(checksums, target, platform)
    temporary = await mkdtemp(join(dirname(current.root), `.${basename(current.root)}-mcp-repair-`))
    const archivePath = join(temporary, release.filename)
    await downloadFile(
      fetchImpl,
      releaseUrl(releaseBaseUrl, channel, release.filename),
      archivePath
    )
    if ((await sha256File(archivePath)) !== release.sha256)
      throw repairError(
        'mcp_repair_verification_failed',
        'The downloaded archive failed SHA-256 verification.'
      )
    const extraction = join(temporary, 'extracted')
    const expectedRoot = join(extraction, archiveStem(release.filename, platform))
    try {
      await extractArchive({
        archivePath,
        destination: extraction,
        expectedRoot,
        platform
      })
    } catch {
      throw repairError('mcp_repair_install_failed', 'The verified archive could not be extracted.')
    }
    const metadata = await readStandaloneMetadata(expectedRoot, platform)
    verifyArchiveTarget(metadata, release.version, target, platform, arch)
    try {
      await verifySignature({
        root: expectedRoot,
        metadata,
        target,
        platform,
        arch,
        nightly: channel.tag === 'nightly'
      })
    } catch {
      throw repairError(
        'mcp_repair_signature_failed',
        'The verified archive failed platform signature verification.'
      )
    }
    let verification
    try {
      verification = await verifyMcp({
        root: expectedRoot,
        profile,
        platform,
        arch,
        version: metadata.version
      })
    } catch {
      throw repairError(
        'mcp_repair_mcp_unavailable',
        'The repaired archive did not pass MCP initialize and tools/list.'
      )
    }
    if (verification?.initialize !== 'verified' || verification?.toolsList !== 'verified')
      throw repairError(
        'mcp_repair_mcp_unavailable',
        'The repaired archive did not pass MCP initialize and tools/list.'
      )
    const nextRoot = join(
      dirname(current.root),
      `${basename(current.root)}-repaired-${metadata.version}-${randomUUID()}`
    )
    await rename(expectedRoot, nextRoot)
    return {
      status: 'repaired',
      installation: 'archive',
      version: metadata.version,
      target: metadata.target,
      platform,
      arch,
      profile,
      root: nextRoot,
      cliPath: join(nextRoot, 'backend', 'cli.mjs'),
      previousRoot: current.root,
      verification
    }
  } catch (error) {
    return failure(current, profile, platform, arch, error)
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}

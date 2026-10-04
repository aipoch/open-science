/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Publication is separate from application releases. The reviewed application catalog is the
// trust anchor; neither an Actions artifact nor a mutable CDN manifest can select new binaries.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function runtimeCdnBaseUrl(environment = process.env) {
  const prefix = environment.S3_PREFIX?.split('/')[0]
  if (!environment.CDN_BASE_URL || !prefix)
    throw new Error('CDN_BASE_URL and S3_PREFIX are required')
  const base = new URL(environment.CDN_BASE_URL)
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(prefix)
  )
    throw new Error('Expected an HTTPS CDN origin and a valid application prefix')
  return `${base.origin}/${prefix}/notebook-runtime`
}

export function runtimeArchiveUrl(component, architecture, digest, environment = process.env) {
  if (
    !['node', 'powershell'].includes(component) ||
    !['x64', 'arm64'].includes(architecture) ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new Error('Invalid immutable runtime URL')
  return `${runtimeCdnBaseUrl(environment)}/${component}/win32-${architecture}/${digest}/${component}.tar.zst`
}

function validateRuntimeCatalog(catalog, environment) {
  if (catalog.schema !== 1 || !Array.isArray(catalog.releases) || !catalog.releases.length)
    throw new Error('Invalid runtime catalog')
  for (const release of catalog.releases) {
    const { component, architecture, archive } = release
    const expected = runtimeArchiveUrl(component, architecture, archive.sha256, environment)
    if (!Number.isSafeInteger(archive.size) || archive.size <= 0 || archive.url !== expected)
      throw new Error('Invalid immutable runtime URL')
  }
  return catalog
}

export async function readRuntimeCatalog(
  environment = process.env,
  catalogPath = new URL('../src/main/notebook/windows-runtime-catalog.json', import.meta.url)
) {
  return validateRuntimeCatalog(JSON.parse(await readFile(catalogPath, 'utf8')), environment)
}

export async function verifyRuntimeArchives(directory, catalog) {
  for (const release of catalog.releases) {
    const path = join(directory, `${release.component}.tar.zst`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (
      (await stat(path)).size !== release.archive.size ||
      hash.digest('hex') !== release.archive.sha256
    )
      throw new Error(`Archive does not match the reviewed catalog: ${release.component}`)
  }
}

export async function checkRuntimeCdn(catalog, fetchImpl = fetch, { verifyBytes = false } = {}) {
  await Promise.all(
    catalog.releases.map(async ({ component, archive }) => {
      const response = await fetchImpl(archive.url, {
        method: verifyBytes ? 'GET' : 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
      })
      if (!response.ok || Number(response.headers.get('content-length')) !== archive.size)
        throw new Error(
          `CDN runtime is unavailable or has the wrong size: ${component} (${response.status})`
        )
      if (verifyBytes) {
        if (!response.body) throw new Error(`CDN runtime has no readable body: ${component}`)
        const hash = createHash('sha256')
        for await (const chunk of response.body) hash.update(chunk)
        if (hash.digest('hex') !== archive.sha256)
          throw new Error(`CDN runtime has the wrong SHA-256: ${component}`)
      }
    })
  )
}

export async function publishRuntimeArchives(
  directory,
  catalog,
  environment = process.env,
  invoke = spawnSync
) {
  validateRuntimeCatalog(catalog, environment)
  await verifyRuntimeArchives(directory, catalog)
  const bucket = environment.S3_BUCKET
  if (!bucket) throw new Error('S3_BUCKET is required')
  const failureDetails = (result) => {
    let diagnostic = result.stderr ?? ''
    for (const value of [
      bucket,
      environment.AWS_ACCESS_KEY_ID,
      environment.AWS_SECRET_ACCESS_KEY,
      environment.AWS_SESSION_TOKEN
    ]) {
      if (value) diagnostic = diagnostic.replaceAll(value, '[redacted]')
    }
    return `${result.error?.code ?? result.status ?? 'unknown'}: ${diagnostic.slice(-1500)}`
  }
  const aws = (args) => {
    const result = invoke('aws', ['s3api', ...args, '--output', 'json', '--no-cli-pager'], {
      encoding: 'utf8',
      timeout: 600_000
    })
    if (result.error || result.status !== 0)
      throw new Error(
        `CDN object operation failed; no overwrite was attempted. ${failureDetails(result)}`
      )
    return JSON.parse(result.stdout)
  }
  for (const { component, archive } of catalog.releases) {
    const key = new URL(archive.url).pathname.slice(1)
    const checksum = Buffer.from(archive.sha256, 'hex').toString('base64')
    const head = invoke(
      'aws',
      [
        's3api',
        'head-object',
        '--bucket',
        bucket,
        '--key',
        key,
        '--checksum-mode',
        'ENABLED',
        '--output',
        'json',
        '--no-cli-pager'
      ],
      { encoding: 'utf8', timeout: 30_000 }
    )
    if (!head.error && head.status === 0) {
      const info = JSON.parse(head.stdout)
      if (info.ContentLength !== archive.size || info.ChecksumSHA256 !== checksum)
        throw new Error(`Existing immutable runtime differs: ${component}`)
      continue
    }
    if (head.error || !/\((?:404|NoSuchKey|NotFound)\)/.test(head.stderr ?? ''))
      throw new Error(`Cannot inspect the CDN object; refusing to publish. ${failureDetails(head)}`)
    // S3 enforces create-only even if a different publisher races this process.
    aws([
      'put-object',
      '--bucket',
      bucket,
      '--key',
      key,
      '--body',
      join(directory, `${component}.tar.zst`),
      '--if-none-match',
      '*',
      '--checksum-algorithm',
      'SHA256',
      '--checksum-sha256',
      checksum,
      '--content-type',
      'application/zstd',
      '--cache-control',
      'public, max-age=31536000, immutable'
    ])
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const [mode, directory] = args
  const catalog = await readRuntimeCatalog()
  if (mode === 'check')
    await checkRuntimeCdn(catalog, fetch, { verifyBytes: args.includes('--verify-bytes') })
  else if (mode === 'verify' && directory) await verifyRuntimeArchives(resolve(directory), catalog)
  else if (mode === 'publish' && directory) {
    await publishRuntimeArchives(resolve(directory), catalog)
    await checkRuntimeCdn(catalog)
  } else
    throw new Error(
      'Usage: windows-runtime-cdn.mjs check | verify <directory> | publish <directory>'
    )
  console.log(`Windows runtime CDN ${mode} complete.`)
}

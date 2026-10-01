/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Publication is separate from application releases. The reviewed application catalog is the
// trust anchor; neither an Actions artifact nor a mutable CDN manifest can select new binaries.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function readRuntimeCatalog() {
  const catalog = JSON.parse(
    await readFile(
      new URL('../src/main/notebook/windows-runtime-catalog.json', import.meta.url),
      'utf8'
    )
  )
  if (catalog.schema !== 1 || !catalog.releases.length) throw new Error('Invalid runtime catalog')
  for (const release of catalog.releases) {
    const { component, architecture, archive } = release
    const expected = `https://statics.aipoch.com/open-science/notebook-runtime/${component}/win32-${architecture}/${archive.sha256}/${component}.tar.zst`
    if (
      !['node', 'powershell'].includes(component) ||
      !['x64', 'arm64'].includes(architecture) ||
      !/^[a-f0-9]{64}$/.test(archive.sha256) ||
      !Number.isSafeInteger(archive.size) ||
      archive.size <= 0 ||
      archive.url !== expected
    )
      throw new Error('Invalid immutable runtime URL')
  }
  return catalog
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

export async function checkRuntimeCdn(catalog, fetchImpl = fetch) {
  for (const { component, archive } of catalog.releases) {
    const response = await fetchImpl(archive.url, {
      method: 'HEAD',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok || Number(response.headers.get('content-length')) !== archive.size)
      throw new Error(
        `CDN runtime is unavailable or has the wrong size: ${component} (${response.status})`
      )
  }
}

export async function publishRuntimeArchives(
  directory,
  catalog,
  environment = process.env,
  invoke = spawnSync
) {
  await verifyRuntimeArchives(directory, catalog)
  const bucket = environment.S3_BUCKET
  const prefix = environment.S3_PREFIX?.split('/')[0]
  if (!bucket || prefix !== 'open-science')
    throw new Error('Expected the configured Open-Science CDN bucket and prefix')
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
  const [mode, directory] = process.argv.slice(2)
  const catalog = await readRuntimeCatalog()
  if (mode === 'check') await checkRuntimeCdn(catalog)
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

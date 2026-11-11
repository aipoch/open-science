/* eslint-disable @typescript-eslint/explicit-function-return-type */
// OCR publication is separate from application releases. The reviewed catalog remains the trust anchor.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIRST_PARTY_FILES = new Set(['licenses.txt', 'ocr-engine.mjs', 'ocr-worker.mjs'])

export function ocrCdnBaseUrl(environment = process.env) {
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
  return `${base.origin}/${prefix}/ocr`
}

function validateAsset(asset, environment) {
  if (
    !asset ||
    typeof asset.file !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(asset.file) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    typeof asset.url !== 'string'
  )
    throw new Error(`Invalid OCR catalog asset: ${asset?.file ?? 'unknown'}`)

  const url = new URL(asset.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error(`Invalid OCR catalog URL: ${asset.file}`)

  if (FIRST_PARTY_FILES.has(asset.file)) {
    const expected = `${ocrCdnBaseUrl(environment)}/${asset.sha256}/${asset.file}`
    if (asset.url !== expected) throw new Error(`Invalid OCR first-party URL: ${asset.file}`)
  } else if (url.origin === new URL(environment.CDN_BASE_URL).origin) {
    throw new Error(`External OCR assets must not use the project CDN: ${asset.file}`)
  }
  return asset
}

export function validateOcrCatalog(catalog, environment = process.env) {
  if (
    !catalog ||
    typeof catalog.revision !== 'string' ||
    !/^ocr-[a-f0-9]{16}$/.test(catalog.revision) ||
    !Array.isArray(catalog.assets) ||
    catalog.assets.length === 0
  )
    throw new Error('Invalid OCR catalog')

  const assets = catalog.assets.map((asset) => validateAsset(asset, environment))
  const firstParty = assets.filter((asset) => FIRST_PARTY_FILES.has(asset.file))
  if (
    firstParty.length !== FIRST_PARTY_FILES.size ||
    new Set(firstParty.map((asset) => asset.file)).size !== FIRST_PARTY_FILES.size
  )
    throw new Error('OCR catalog must contain exactly the three first-party assets')
  return { ...catalog, assets }
}

export async function readOcrCatalog(
  environment = process.env,
  catalogPath = join(process.cwd(), 'out/ocr/manifest.json')
) {
  return validateOcrCatalog(JSON.parse(await readFile(catalogPath, 'utf8')), environment)
}

function firstPartyAssets(catalog) {
  return catalog.assets.filter((asset) => FIRST_PARTY_FILES.has(asset.file))
}

export async function verifyOcrAssets(directory, catalog) {
  for (const asset of firstPartyAssets(catalog)) {
    const path = join(directory, asset.file)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if ((await stat(path)).size !== asset.size || hash.digest('hex') !== asset.sha256)
      throw new Error(`OCR asset does not match the reviewed catalog: ${asset.file}`)
  }
}

export async function checkOcrCdn(catalog, fetchImpl = fetch, { verifyBytes = false } = {}) {
  await Promise.all(
    firstPartyAssets(catalog).map(async (asset) => {
      const response = await fetchImpl(asset.url, {
        method: verifyBytes ? 'GET' : 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
      })
      if (
        !response.ok ||
        (!verifyBytes && Number(response.headers.get('content-length')) !== asset.size)
      )
        throw new Error(`OCR CDN is unavailable or has the wrong size: ${asset.file}`)
      if (verifyBytes) {
        if (!response.body) throw new Error(`OCR CDN has no readable body: ${asset.file}`)
        const hash = createHash('sha256')
        // Fetch decodes CDN compression; Content-Length describes the encoded transfer, if present.
        let bytes = 0
        for await (const chunk of response.body) {
          bytes += chunk.byteLength
          if (bytes > asset.size)
            throw new Error(`OCR CDN is unavailable or has the wrong size: ${asset.file}`)
          hash.update(chunk)
        }
        if (bytes !== asset.size)
          throw new Error(`OCR CDN is unavailable or has the wrong size: ${asset.file}`)
        if (hash.digest('hex') !== asset.sha256)
          throw new Error(`OCR CDN has the wrong SHA-256: ${asset.file}`)
      }
    })
  )
}

export async function publishOcrAssets(
  directory,
  catalog,
  environment = process.env,
  invoke = spawnSync
) {
  catalog = validateOcrCatalog(catalog, environment)
  await verifyOcrAssets(directory, catalog)
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
      throw new Error(`OCR CDN object operation failed. ${failureDetails(result)}`)
    return JSON.parse(result.stdout)
  }

  for (const asset of firstPartyAssets(catalog)) {
    const key = new URL(asset.url).pathname.slice(1)
    const checksum = Buffer.from(asset.sha256, 'hex').toString('base64')
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
      if (info.ContentLength !== asset.size || info.ChecksumSHA256 !== checksum)
        throw new Error(`Published OCR bytes differ: ${asset.file}`)
      continue
    }
    if (head.error || !/\((?:404|NoSuchKey|NotFound)\)/.test(head.stderr ?? ''))
      throw new Error(
        `Cannot inspect the OCR CDN object; refusing to publish. ${failureDetails(head)}`
      )

    aws([
      'put-object',
      '--bucket',
      bucket,
      '--key',
      key,
      '--body',
      join(directory, asset.file),
      '--if-none-match',
      '*',
      '--checksum-algorithm',
      'SHA256',
      '--checksum-sha256',
      checksum,
      '--content-type',
      asset.file === 'licenses.txt' ? 'text/plain' : 'application/javascript',
      '--cache-control',
      'public, max-age=31536000, immutable'
    ])
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory = 'out/ocr'] = process.argv.slice(2)
  const catalog = await readOcrCatalog(process.env, join(directory, 'manifest.json'))
  if (mode === 'verify') await verifyOcrAssets(resolve(directory), catalog)
  else if (mode === 'check') await checkOcrCdn(catalog, fetch, { verifyBytes: true })
  else if (mode === 'publish') {
    await publishOcrAssets(resolve(directory), catalog)
    await checkOcrCdn(catalog, fetch, { verifyBytes: true })
  } else throw new Error('Usage: publish-ocr-assets.mjs verify | check | publish [directory]')
  console.log(`OCR CDN ${mode} complete.`)
}

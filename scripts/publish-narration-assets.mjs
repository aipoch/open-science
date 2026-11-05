/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  researchNarrationCdnUrl,
  researchNarrationMirrorUrl
} from '../src/main/local-models/download-sources.ts'

export async function readNarrationCatalog() {
  const { RESEARCH_NARRATION_MODELS } =
    await import('../packages/research-film/dist/model-catalog.js')
  const objects = new Map()
  for (const revision of RESEARCH_NARRATION_MODELS) {
    for (const asset of revision.assets) {
      if (researchNarrationMirrorUrl(asset)) continue
      const url = researchNarrationCdnUrl(asset)
      const previous = objects.get(url)
      if (previous && previous.size !== asset.size)
        throw new Error('Conflicting narration asset size')
      objects.set(url, { ...asset, upstream: asset.url, url })
    }
  }
  return { assets: [...objects.values()] }
}

// Hash directories preserve files with the same name on different platforms.
const assetPath = (directory, asset) => join(directory, asset.sha256, asset.file)

export async function stageNarrationAssets(directory, catalog) {
  const { resilientDownload } = await import('../packages/resilient-download/dist/index.js')
  for (const asset of catalog.assets) {
    const path = assetPath(directory, asset)
    await mkdir(join(directory, asset.sha256), { recursive: true })
    await resilientDownload(asset.upstream, path, {
      expectedSize: asset.size,
      expectedSha256: asset.sha256
    })
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(catalog, null, 2) + '\n')
}

export async function verifyNarrationAssets(directory, catalog) {
  for (const asset of catalog.assets) {
    const path = assetPath(directory, asset)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if ((await stat(path)).size !== asset.size || hash.digest('hex') !== asset.sha256)
      throw new Error(`Narration asset does not match the reviewed catalog: ${asset.file}`)
  }
}

export async function checkNarrationCdn(catalog, fetchImpl = fetch, { verifyBytes = false } = {}) {
  await Promise.all(
    catalog.assets.map(async (asset) => {
      const response = await fetchImpl(asset.url, {
        method: verifyBytes ? 'GET' : 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
      })
      if (
        !response.ok ||
        (!verifyBytes && Number(response.headers.get('content-length')) !== asset.size)
      )
        throw new Error(`Narration CDN is unavailable or has the wrong size: ${asset.file}`)
      if (verifyBytes) {
        if (!response.body) throw new Error(`Narration CDN has no readable body: ${asset.file}`)
        const hash = createHash('sha256')
        // Fetch decodes CDN compression; Content-Length describes the encoded transfer, if present.
        let bytes = 0
        for await (const chunk of response.body) {
          bytes += chunk.byteLength
          if (bytes > asset.size)
            throw new Error(`Narration CDN is unavailable or has the wrong size: ${asset.file}`)
          hash.update(chunk)
        }
        if (bytes !== asset.size)
          throw new Error(`Narration CDN is unavailable or has the wrong size: ${asset.file}`)
        if (hash.digest('hex') !== asset.sha256)
          throw new Error(`Narration CDN has the wrong SHA-256: ${asset.file}`)
      }
    })
  )
}

export async function publishNarrationAssets(
  directory,
  catalog,
  environment = process.env,
  invoke = spawnSync
) {
  for (const asset of catalog.assets) {
    if (
      asset.url !== researchNarrationCdnUrl(asset) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    )
      throw new Error('Invalid narration publication asset')
  }
  if (
    environment.CDN_BASE_URL?.replace(/\/$/, '') !== 'https://statics.aipoch.com' ||
    environment.S3_PREFIX?.split('/')[0] !== 'open-science'
  )
    throw new Error('CDN configuration must match the narration client URLs')
  await verifyNarrationAssets(directory, catalog)
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
      throw new Error(`Narration CDN object operation failed. ${failureDetails(result)}`)
    return JSON.parse(result.stdout)
  }

  for (const asset of catalog.assets) {
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
        throw new Error(`Published Narration bytes differ: ${asset.file}`)
      continue
    }
    if (head.error || !/\((?:404|NoSuchKey|NotFound)\)/.test(head.stderr ?? ''))
      throw new Error(
        `Cannot inspect the Narration CDN object; refusing to publish. ${failureDetails(head)}`
      )

    aws([
      'put-object',
      '--bucket',
      bucket,
      '--key',
      key,
      '--body',
      assetPath(directory, asset),
      '--if-none-match',
      '*',
      '--checksum-algorithm',
      'SHA256',
      '--checksum-sha256',
      checksum,
      '--content-type',
      'application/octet-stream',
      '--cache-control',
      'public, max-age=31536000, immutable'
    ])
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory = 'out/research-narration'] = process.argv.slice(2)
  const catalog = await readNarrationCatalog()
  if (mode === 'stage') await stageNarrationAssets(directory, catalog)
  else if (mode === 'verify') await verifyNarrationAssets(directory, catalog)
  else if (mode === 'check') await checkNarrationCdn(catalog, fetch, { verifyBytes: true })
  else if (mode === 'publish') {
    await publishNarrationAssets(directory, catalog)
    await checkNarrationCdn(catalog, fetch, { verifyBytes: true })
  } else
    throw new Error(
      'Usage: publish-narration-assets.mjs stage | verify | check | publish [directory]'
    )
  console.log(`Narration CDN ${mode} complete (${catalog.assets.length} shared objects).`)
}

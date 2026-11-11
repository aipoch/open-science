import { createHash } from 'node:crypto'
import { createWriteStream, openAsBlob } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { deleteFiles, downloadFile, fileDownloadInfo, uploadFiles } from '@huggingface/hub'
import type { BucketTask, HuggingFaceArchivedFile } from './hugging-face-bucket'

const hub = 'https://huggingface.co'
const marker = '.open-science-volume'
const limit = 10_000
class BucketError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BucketError(message)
}

function validPath(path: string): void {
  check(
    typeof path === 'string' &&
      path.length <= 4096 &&
      path
        .split('/')
        .every(
          (part) =>
            part &&
            part !== '.' &&
            part !== '..' &&
            part.length <= 255 &&
            !/[\\:*?"<>|#%]/.test(part) &&
            !/[. ]$/.test(part) &&
            !Array.from(part).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
            !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
        ),
    'Unsafe Hugging Face Bucket file path.'
  )
}

type Entry = { path: string; bytes: number; xetHash?: string }
function validateFiles(
  files: readonly { path: string; bytes?: number; sha256?: string }[],
  maxBytes: number
): void {
  check(
    Number.isSafeInteger(maxBytes) && maxBytes >= 0 && files.length <= limit,
    'Invalid Bucket transfer budget.'
  )
  const names = new Set<string>()
  let total = 0
  for (const file of files) {
    validPath(file.path)
    const name = file.path.normalize('NFC').toLowerCase()
    check(!names.has(name) && name.split('/')[0] !== marker, 'Conflicting Bucket file paths.')
    names.add(name)
    if (file.bytes !== undefined) {
      check(Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'Invalid Bucket file size.')
      total += file.bytes
    }
    check(
      file.sha256 === undefined || /^[a-f0-9]{64}$/.test(file.sha256),
      'Invalid Bucket file digest.'
    )
  }
  for (const name of names) {
    let i = name.indexOf('/')
    while (i >= 0) {
      check(!names.has(name.slice(0, i)), 'Conflicting Bucket file paths.')
      i = name.indexOf('/', i + 1)
    }
  }
  check(total <= maxBytes, 'Bucket transfer exceeds approved byte budget.')
}

export function bucketFetch(token: string, transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    // The pinned SDK uses URL/string + init. Fail closed on new request shapes.
    check(typeof input === 'string' || input instanceof URL, 'Unexpected Bucket request shape.')
    const url = new URL(input)
    const headers = new Headers(init?.headers)
    const auth = headers.get('authorization')
    check(
      url.protocol === 'https:' && !url.username && !url.password && !url.port,
      'Unsafe Bucket transport URL.'
    )
    const isCas = /^cas-server\.xethub(?:-[a-z0-9-]+)?\.hf\.co$/.test(url.hostname)
    const isTransfer = /^transfer\.xethub(?:-[a-z0-9-]+)?\.hf\.co$/.test(url.hostname)
    // Xet reconstruction can return a signed CDN URL for the file bytes.
    const isCdnRead =
      url.origin === 'https://us.aws.cdn.hf.co' &&
      (init?.method ?? 'GET') === 'GET' &&
      !headers.has('authorization') &&
      !headers.has('cookie')
    check(
      url.origin === hub ||
        (isCas && auth !== 'Bearer ' + token) ||
        (isTransfer && !auth) ||
        isCdnRead,
      'Unsafe Bucket credential destination.'
    )
    const res = await transport(url, {
      ...init,
      redirect: 'error',
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000)
    })
    return res
  }
}

async function transfer(
  blob: Blob,
  maxBytes: number,
  destination?: string
): Promise<{ bytes: number; sha256: string }> {
  check(
    Number.isSafeInteger(blob.size) && blob.size >= 0 && blob.size <= maxBytes,
    'Bucket transfer exceeds approved byte budget.'
  )
  let bytes = 0
  const hash = createHash('sha256')
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > blob.size || bytes > maxBytes)
        return callback(new BucketError('Bucket stream exceeds declared size.'))
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  const sink = destination
    ? createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    : new Writable({
        write(_chunk, _enc, cb) {
          cb()
        }
      })
  await pipeline(Readable.fromWeb(blob.stream() as NodeReadableStream<Uint8Array>), measure, sink)
  check(bytes === blob.size, 'Incomplete Bucket file transfer.')
  return { bytes, sha256: hash.digest('hex') }
}

export async function executeBucketTask(
  task: BucketTask,
  transport: typeof fetch = fetch
): Promise<unknown> {
  check(
    /^[\w-]+\/[\w.-]+$/.test(task.bucket) &&
      !['.', '..'].includes(task.bucket.split('/')[1]) &&
      /^[\w-]{1,128}$/.test(task.runId) &&
      /^hf_[!-~]+$/.test(task.token),
    'Invalid Hugging Face Bucket identity or credential.'
  )
  const scopedFetch = bucketFetch(task.token, transport)
  const sdk = {
    repo: { type: 'bucket' as const, name: task.bucket },
    accessToken: task.token,
    fetch: scopedFetch
  }
  const api = hub + '/api/buckets/' + task.bucket
  const authorization = { Authorization: 'Bearer ' + task.token }
  const root = 'open-science/' + task.runId
  const inputs = { bucket: task.bucket, prefix: root + '/inputs' }
  const outputs = { bucket: task.bucket, prefix: root + '/outputs' }

  async function verifyPrivate(): Promise<void> {
    const res = await scopedFetch(api, { headers: authorization })
    check(res.ok, 'Cannot verify private Hugging Face Bucket (HTTP ' + res.status + ').')
    const info = await res.json()
    check(
      info?.id === task.bucket && info.private === true,
      'The selected Hugging Face Bucket must match and be private.'
    )
  }
  await verifyPrivate()

  async function inventory(prefix: string): Promise<Entry[]> {
    const base = new URL(api + '/tree/' + prefix)
    let next: URL | undefined = new URL(base)
    const seen = new Set<string>()
    const entries: Entry[] = []
    while (next) {
      check(
        next.origin === base.origin &&
          next.pathname === base.pathname &&
          !next.username &&
          !next.password &&
          !next.hash,
        'Unsafe Bucket listing continuation.'
      )
      next.searchParams.set('recursive', 'true')
      check(!seen.has(next.href) && seen.size < 100, 'Incomplete Bucket listing.')
      seen.add(next.href)
      const res: Response = await scopedFetch(next, { headers: authorization })
      if (
        seen.size === 1 &&
        res.status === 404 &&
        res.headers.get('x-error-code') === 'EntryNotFound'
      )
        return []
      check(res.ok, 'Bucket listing failed (HTTP ' + res.status + ').')
      const rows: unknown = await res.json()
      check(Array.isArray(rows), 'Invalid Bucket listing.')
      for (const row of rows) {
        check(
          typeof row?.path === 'string' && row.path.startsWith(prefix + '/'),
          'Bucket listing escaped the job directory.'
        )
        const path = row.path.slice(prefix.length + 1)
        validPath(path)
        if (row.type === 'directory') continue
        check(
          row.type === 'file' && Number.isSafeInteger(row.size) && row.size >= 0,
          'Invalid Bucket file record.'
        )
        check(
          row.xetHash == null ||
            (typeof row.xetHash === 'string' && /^[a-f0-9]{64}$/.test(row.xetHash)),
          'Invalid Bucket object identity.'
        )
        entries.push({ path, bytes: row.size, ...(row.xetHash && { xetHash: row.xetHash }) })
        check(entries.length <= limit + 1, 'Bucket listing exceeds file limit.')
      }
      const link: string | null = res.headers.get('link')
      let target: string | undefined
      for (const part of link?.split(/,(?=\s*<)/) ?? []) {
        const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/.exec(part)
        check(match, 'Invalid Bucket pagination.')
        if (match[2].split(/\s+/).includes('next')) {
          check(!target, 'Ambiguous Bucket pagination.')
          target = match[1]
        }
      }
      next = target ? new URL(target, next) : undefined
    }
    return entries
  }

  async function read(
    path: string,
    expectedHash?: string
  ): Promise<{ blob: Blob; xetHash?: string }> {
    const info = await fileDownloadInfo({ ...sdk, path })
    check(info, 'Declared Hugging Face Bucket file is missing.')
    check(
      expectedHash === undefined || info.xet?.hash === expectedHash,
      'Bucket object identity changed.'
    )
    const blob = await downloadFile({ ...sdk, path, downloadInfo: info, parallelDownloads: false })
    check(blob, 'Declared Hugging Face Bucket file is missing.')
    return { blob, xetHash: info.xet?.hash }
  }
  if (task.kind === 'stage') {
    validateFiles(task.files, task.maxBytes)
    const files: Array<{ path: string; content: Blob }> = []
    for (const file of task.files) {
      check(
        isAbsolute(file.localPath) && (await lstat(file.localPath)).isFile(),
        'Expected a regular frozen input file.'
      )
      // Node's file-backed Blob rejects reads if the underlying file changes.
      const content = await openAsBlob(file.localPath)
      check(
        content.size === file.bytes && (await transfer(content, file.bytes)).sha256 === file.sha256,
        'Frozen input size or digest mismatch.'
      )
      files.push({ path: inputs.prefix + '/' + file.path, content })
    }
    for (const mount of [inputs, outputs])
      files.push({ path: mount.prefix + '/' + marker, content: new Blob(['\n']) })
    await verifyPrivate()
    // The SDK obtains a bucket write grant before sending Xet chunks. All declared inputs were checked first.
    await uploadFiles({ ...sdk, files })
    // A successful batch receipt alone does not establish end-to-end integrity.
    for (const file of task.files) {
      const received = await transfer(
        (await read(inputs.prefix + '/' + file.path)).blob,
        file.bytes
      )
      check(
        received.bytes === file.bytes && received.sha256 === file.sha256,
        'Uploaded Bucket file verification failed.'
      )
    }
    return { inputs, outputs }
  }
  if (task.kind === 'list')
    return (await inventory(outputs.prefix)).filter((f) => f.path !== marker)
  if (task.kind === 'cleanup') {
    const expected = new Map(task.expectedOutputs?.map((file) => [file.path, file]))
    const discarded = new Map(task.discardedOutputs?.map((file) => [file.path, file]))
    const stagedInputs = task.expectedInputs
    const guarded =
      stagedInputs !== undefined ||
      task.expectedOutputs !== undefined ||
      task.discardedOutputs !== undefined
    async function verifyStagingMarker(prefix: string, file: Entry): Promise<void> {
      check(file.bytes === 1, 'Bucket staging marker changed; cleanup stopped.')
      const { blob } = await read(prefix + '/' + marker)
      check(
        blob.size === 1 && (await blob.text()) === '\n',
        'Bucket staging marker changed; cleanup stopped.'
      )
    }
    let verifiedInputs: Entry[] | undefined
    if (stagedInputs) {
      validateFiles(stagedInputs, Number.MAX_SAFE_INTEGER)
      const manifest = new Map(stagedInputs.map((file) => [file.path, file]))
      verifiedInputs = await inventory(inputs.prefix)
      for (const file of verifiedInputs) {
        if (file.path === marker) {
          await verifyStagingMarker(inputs.prefix, file)
          continue
        }
        const receipt = manifest.get(file.path)
        check(
          receipt && receipt.bytes === file.bytes,
          'Unexpected or changed Bucket input; cleanup stopped.'
        )
        const { blob } = await read(inputs.prefix + '/' + file.path)
        const actual = await transfer(blob, receipt.bytes)
        check(
          actual.bytes === receipt.bytes && actual.sha256 === receipt.sha256,
          'Bucket input digest changed; cleanup stopped.'
        )
      }
    }
    if (guarded) {
      validateFiles(
        [...(task.expectedOutputs ?? []), ...(task.discardedOutputs ?? [])],
        Number.MAX_SAFE_INTEGER
      )
      for (const file of expected.values())
        check(/^[a-f0-9]{64}$/.test(file.sha256), 'Invalid archived output digest.')
      for (const file of discarded.values())
        check(/^[a-f0-9]{64}$/.test(file.xetHash), 'Invalid discarded output identity.')
    }
    // Check outputs before deleting inputs. HF only offers unconditional path deletion:
    // the caller must own this prefix exclusively and have confirmed that execution stopped.
    for (const mount of [outputs, inputs]) {
      const files =
        mount === inputs && verifiedInputs ? verifiedInputs : await inventory(mount.prefix)
      if (mount === outputs && guarded) {
        for (const file of files) {
          if (file.path === marker) {
            if (stagedInputs) await verifyStagingMarker(outputs.prefix, file)
            continue
          }
          const skipped = discarded.get(file.path)
          if (skipped) {
            check(
              skipped.bytes === file.bytes && skipped.xetHash === file.xetHash,
              'Discarded Bucket output changed; cleanup stopped.'
            )
            continue
          }
          const receipt = expected.get(file.path)
          check(
            receipt && receipt.bytes === file.bytes,
            'Unexpected or changed Bucket output; cleanup stopped.'
          )
          if (receipt.xetHash && file.xetHash) {
            check(
              receipt.xetHash === file.xetHash,
              'Bucket output identity changed; cleanup stopped.'
            )
          } else {
            const { blob } = await read(mount.prefix + '/' + file.path, receipt.xetHash)
            const actual = await transfer(blob, receipt.bytes)
            check(
              actual.bytes === receipt.bytes && actual.sha256 === receipt.sha256,
              'Bucket output digest changed; cleanup stopped.'
            )
          }
        }
      }
      for (let i = 0; i < files.length; i += 100)
        await deleteFiles({
          ...sdk,
          paths: files.slice(i, i + 100).map((f) => mount.prefix + '/' + f.path)
        })
      check(!(await inventory(mount.prefix)).length, 'Bucket cleanup is incomplete.')
    }
    return
  }
  validateFiles(task.files, task.maxBytes)
  let remaining = task.maxBytes
  const result: HuggingFaceArchivedFile[] = []
  for (const file of task.files) {
    const { blob, xetHash } = await read(outputs.prefix + '/' + file.path, file.xetHash)
    check(file.bytes === undefined || blob.size === file.bytes, 'Bucket output changed size.')
    const localPath = join(task.directory, ...file.path.split('/'))
    await mkdir(dirname(localPath), { recursive: true, mode: 0o700 })
    const received = await transfer(blob, remaining, localPath)
    check(
      file.sha256 === undefined || received.sha256 === file.sha256,
      'Bucket output digest mismatch.'
    )
    remaining -= received.bytes
    result.push({ path: file.path, localPath, ...received, ...(xetHash && { xetHash }) })
  }
  return result
}

if (require.main === module && !isMainThread && parentPort) {
  const port = parentPort
  void executeBucketTask(workerData).then(
    (result) => port.postMessage({ result }),
    // SDK errors can include provider bodies and signed URLs.
    (error) =>
      port.postMessage({
        error: error instanceof BucketError ? error.message : 'Hugging Face Bucket transfer failed.'
      })
  )
}

import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Transform } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'

import {
  manifestUrl,
  packId,
  PACK_PATH_BUDGET_FILE,
  packArchiveFile,
  packUrl,
  parseManifest,
  pathBudgetForPack,
  resolvePack,
  SUPPORTED_SCHEMA,
  verifyPackChecksum,
  type BundleManifest,
  type PackEntry,
  type PackLanguage
} from './bundle-manifest'
import type { EnvSpec, FetchedBundle, ProvisionProgress } from './provisioner'
import { extractPackArchiveWithDeps } from './pack-archive'
import { validateAndSeedPack } from './pack-content'
import { runtimePackDir, runtimeSubdir } from './runtime-paths'
import { operationJournalPath, RuntimeOperationJournal } from './operation-journal'

// Client fetch helper for one curated language pack (split-language-pack protocol, multi-version).
// Given the CDN inputs the runtime already has (cdnBase, envVersion, conda subdir) plus the chosen
// language+version, it fetches the shared manifest, resolves the single matching pack archive,
// downloads ONLY that archive, and verifies it against the manifest (fail-closed). It does NOT
// create/materialize an env — that wiring lives in the provisioner and is added in a later step.
// Deps are injected so this unit-tests without real network or hashing.
export type LanguagePackFetchDeps = {
  // Fetches a URL and returns its body as text (used for manifest.json).
  fetchText: (url: string) => Promise<string>
  // Downloads a URL to destPath (the pack archive).
  download: (
    url: string,
    destPath: string,
    onProgress?: (downloadedBytes: number, totalBytes?: number) => void
  ) => Promise<void>
  // sha256 hex of a file; injectable for tests, defaults to the streaming sha256File.
  sha256?: (path: string) => Promise<string>
}

// The manifest is tiny, so a total request timeout is fine. Without it, a CDN that accepts the
// connection then stalls would hang first-run provisioning (and the serialized provision queue behind
// it) forever instead of failing closed.
const MANIFEST_TIMEOUT_MS = 30_000
// The pack can be large (hundreds of MB), so a total timeout would wrongly kill a legit slow download.
// Use a STALL timeout instead: abort only when no bytes arrive for this window (covers a stalled
// connect and a mid-stream stall alike), and reset it on every received chunk.
const PACK_STALL_TIMEOUT_MS = 60_000

// Combines the internal timeout/stall controller with an optional external cancel signal (user
// pressing Cancel), so either one aborts the request. AbortSignal.any short-circuits if the external
// signal is already aborted.
const withCancel = (internal: AbortSignal, external?: AbortSignal): AbortSignal =>
  external ? AbortSignal.any([internal, external]) : internal

const fetchText = async (url: string, external?: AbortSignal): Promise<string> => {
  const signal = withCancel(AbortSignal.timeout(MANIFEST_TIMEOUT_MS), external)
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`runtime manifest request failed (${response.status})`)
  return response.text()
}

const downloadFile = async (
  url: string,
  destPath: string,
  onProgress: (downloadedBytes: number, totalBytes?: number) => void = () => undefined,
  external?: AbortSignal
): Promise<void> => {
  const controller = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(
      () =>
        controller.abort(new Error(`runtime pack download stalled (>${PACK_STALL_TIMEOUT_MS}ms)`)),
      PACK_STALL_TIMEOUT_MS
    )
  }
  armStall()
  try {
    const response = await fetch(url, { signal: withCancel(controller.signal, external) })
    if (!response.ok) throw new Error(`runtime pack request failed (${response.status})`)
    if (!response.body) throw new Error('runtime pack response had no body')
    const contentLength = Number(response.headers.get('content-length'))
    // A missing Content-Length yields 0 (Number(null)); treat only a positive value as known, so the
    // caller falls back to the manifest's pack size for the progress bar instead of showing a stuck 0.
    const totalBytes =
      Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
    let downloadedBytes = 0
    onProgress(downloadedBytes, totalBytes)
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length
        armStall()
        onProgress(downloadedBytes, totalBytes)
        callback(null, chunk)
      }
    })
    await pipeline(
      // Node's DOM and stream lib definitions use incompatible ReadableStream generics here; the
      // runtime contract is the standard Web stream returned by Node fetch.
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      meter,
      createWriteStream(destPath),
      { signal: withCancel(controller.signal, external) }
    )
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
  }
}

// The result of a successful pack fetch: the resolved id/entry and where the verified file landed.
export type FetchedLanguagePack = {
  id: string
  entry: PackEntry
  filePath: string
  manifest: BundleManifest
}

// Fetches + verifies the single pack for (language, version). Throws (fail-closed) when the manifest
// is malformed, its schema/envVersion disagree with what the runtime expects, the requested version
// was not published, or the downloaded pack fails its sha256/size check — the CDN adapter treats any
// throw as unavailable and the provisioner emits an actionable no-source error.
export const fetchLanguagePack = async (
  destDir: string,
  cdnBase: string,
  version: number,
  subdir: string,
  language: PackLanguage,
  packVersion: string,
  deps: LanguagePackFetchDeps,
  onDownloadProgress: (downloadedBytes: number, totalBytes?: number) => void = () => undefined
): Promise<FetchedLanguagePack> => {
  const manifest = parseManifest(await deps.fetchText(manifestUrl(cdnBase, version, subdir)))
  if (manifest.schema !== SUPPORTED_SCHEMA) {
    throw new Error(`unsupported manifest schema ${manifest.schema} (expected ${SUPPORTED_SCHEMA})`)
  }
  if (manifest.envVersion !== version) {
    throw new Error(`manifest envVersion ${manifest.envVersion} does not match expected ${version}`)
  }
  if (manifest.subdir !== subdir) {
    throw new Error(`manifest subdir ${manifest.subdir} does not match expected ${subdir}`)
  }
  const entry = resolvePack(manifest, language, packVersion)
  if (!entry) {
    throw new Error(`no ${language} ${packVersion} pack in manifest for subdir ${subdir}`)
  }
  const canonicalFile = packArchiveFile(language, packVersion)
  if (entry.file !== canonicalFile) {
    throw new Error(
      `runtime manifest uses a non-canonical pack filename for ${language}-${packVersion}`
    )
  }
  const filePath = join(destDir, canonicalFile)
  await deps.download(
    packUrl(cdnBase, version, subdir, entry.file),
    filePath,
    (downloadedBytes, totalBytes) => onDownloadProgress(downloadedBytes, totalBytes ?? entry.size)
  )
  await verifyPackChecksum(
    filePath,
    { sha256: entry.sha256, size: entry.size },
    { sha256: deps.sha256 }
  )
  return { id: packId(language, packVersion), entry, filePath, manifest }
}

export type FetchBundleAdapterDeps = Partial<LanguagePackFetchDeps> & {
  extract?: (archivePath: string, destDir: string) => Promise<void>
  subdir?: string
}

type FetchBundleFn = (
  spec: EnvSpec,
  version: number,
  onProgress: (p: ProvisionProgress) => void,
  signal?: AbortSignal
) => Promise<FetchedBundle | undefined>

// Adapts the single-file CDN fetch to the provisioner's lock-based contract. A failed CDN fetch throws
// one source-scoped, actionable error so HTTP/integrity failures survive through Settings and lazy
// provisioning; no online solve is attempted. An aborted `signal` (user Cancel) aborts the download.
export const createFetchBundleAdapter =
  (root: string, cdnBase: string | undefined, deps: FetchBundleAdapterDeps = {}): FetchBundleFn =>
  async (spec, version, onProgress, signal) => {
    if (!cdnBase) return undefined
    // Stage under <root>/packs (the SAME volume as the final pack dir), NOT the system tmpdir: the
    // final commit is an atomic rename() into runtimePackDir(root,...), and a relocated data root on a
    // separate filesystem would make a tmpdir->root rename fail EXDEV even though the download, verify,
    // and extract all succeeded. Staging on-volume keeps the rename atomic (and avoids dumping a large
    // pack — the R pack is ~345 MB — into system /tmp).
    const packsRoot = join(root, 'packs')
    await mkdir(packsRoot, { recursive: true })
    const workDir = await mkdtemp(join(packsRoot, '.incoming-'))
    const unpackedDir = join(workDir, 'pack')
    // Crash recovery (WS13): record the download intent BEFORE staging so a hard-quit mid-fetch leaves
    // a journal entry whose targetPath is this .incoming-* dir; startup recovery removes the orphan.
    // Cleared in the finally on every normal completion/failure (the staging is gone by then), so only
    // a killed process leaves it behind. Best-effort — journal I/O never fails the fetch.
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(root))
    const operationId = randomUUID()
    await journal
      .begin({
        operationId,
        kind: 'download',
        runtimeId: packId(spec.language, spec.version),
        phase: `fetch-${spec.language}`,
        startedAt: Date.now(),
        targetPath: workDir
      })
      .catch(() => undefined)
    try {
      onProgress({
        phase: `fetch-${spec.language}`,
        message: 'Fetching managed runtime manifest…',
        progress: 0.05
      })
      const fetched = await fetchLanguagePack(
        workDir,
        cdnBase,
        version,
        deps.subdir ?? runtimeSubdir(),
        spec.language,
        spec.version,
        {
          // Bake the external cancel signal into the default fetchers so a user Cancel aborts the
          // in-flight manifest fetch and pack download (injected test deps opt out, as before).
          fetchText: deps.fetchText ?? ((url) => fetchText(url, signal)),
          download: deps.download ?? ((url, dest, op) => downloadFile(url, dest, op, signal)),
          sha256: deps.sha256
        },
        (downloadedBytes, totalBytes) => {
          const ratio = totalBytes && totalBytes > 0 ? downloadedBytes / totalBytes : 0
          const detail = totalBytes
            ? ` (${Math.min(100, Math.round(ratio * 100))}%)`
            : downloadedBytes > 0
              ? ` (${Math.round(downloadedBytes / 1024 / 1024)} MB)`
              : ''
          onProgress({
            phase: `fetch-${spec.language}`,
            message: `Downloading managed ${spec.language} runtime${detail}`,
            progress: 0.1 + 0.25 * Math.min(1, ratio)
          })
        }
      )
      onProgress({
        phase: `fetch-${spec.language}`,
        message: `Downloaded ${fetched.entry.file}`,
        progress: 0.35
      })

      await extractPackArchiveWithDeps(fetched.filePath, unpackedDir, { extract: deps.extract })
      const lockPath = join(unpackedDir, `${fetched.id}.lock`)
      await readFile(lockPath, 'utf8')
      const entries = await validateAndSeedPack(root, unpackedDir, lockPath, (completed, total) => {
        onProgress({
          phase: `fetch-${spec.language}`,
          message: `Verifying ${completed}/${total} packages…`,
          progress: 0.35 + 0.15 * (completed / total)
        })
      })
      if (entries.length === 0) return undefined

      const subdir = deps.subdir ?? runtimeSubdir()
      const pathBudget = pathBudgetForPack(fetched.entry)
      if (subdir === 'win-64' && !pathBudget) return undefined
      if (pathBudget) {
        await writeFile(
          join(unpackedDir, PACK_PATH_BUDGET_FILE),
          `${JSON.stringify(pathBudget)}\n`,
          'utf8'
        )
      }
      const finalDir = runtimePackDir(root, version, subdir, fetched.id)
      await mkdir(join(finalDir, '..'), { recursive: true })
      try {
        // The pack id is immutable for an envVersion/subdir. Rename the fully verified directory
        // into place first, so readers never observe a partially extracted pack.
        await rename(unpackedDir, finalDir)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error
        try {
          const winnerLockPath = join(finalDir, `${fetched.id}.lock`)
          await validateAndSeedPack(root, finalDir, winnerLockPath)
          // A prior verified immutable fetch won the race; revalidating its lock and tarballs ensures
          // an interrupted directory with only a readable lock cannot masquerade as the winner.
          if (pathBudget) {
            await writeFile(
              join(finalDir, PACK_PATH_BUDGET_FILE),
              `${JSON.stringify(pathBudget)}\n`,
              'utf8'
            )
          }
          return { lockPath: winnerLockPath, pathBudget }
        } catch {
          // Only remove a directory that is demonstrably not a complete pack, then retry the
          // rename. This handles a process interrupted before its final commit.
          await rm(finalDir, { recursive: true, force: true })
          await rename(unpackedDir, finalDir)
        }
      }
      return { lockPath: join(finalDir, `${fetched.id}.lock`), pathBudget }
    } catch (error) {
      const message = `Managed runtime pack unavailable: ${error instanceof Error ? error.message : String(error)}`
      onProgress({
        phase: `fetch-${spec.language}`,
        message,
        progress: 0.1
      })
      throw new Error(message, { cause: error })
    } finally {
      await rm(workDir, { recursive: true, force: true })
      // Staging is gone (committed or cleaned) — clear the journal entry so only a killed process
      // leaves it for startup recovery.
      await journal.complete(operationId).catch(() => undefined)
    }
  }

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

export type MicromambaRunnerCandidate = {
  id: string
  path: string
  // SHA-256 of the extracted upstream executable before an optional release signature is added.
  expectedSha256?: string
  // Bundled Windows candidates may be Authenticode-signed after this digest was recorded.
  verifySignature?: boolean
  selectionTier?: 'explicit' | 'pinned-primary' | 'compatibility' | 'fallback'
}

export type MicromambaRunner = {
  initialPath: string
  resolve: () => Promise<string>
}

export type MicromambaRunnerResolverOptions = {
  candidates: MicromambaRunnerCandidate[]
  toolsDir: string
  preflight?: (path: string) => Promise<void>
  verifySignature?: (path: string) => Promise<void>
}

type SelectionReceipt = {
  schema: 1
  candidateId: string
  sha256: string
}

const execFileAsync = promisify(execFile)
const digestPattern = /^[0-9a-f]{64}$/
const candidateIdPattern = /^[a-z0-9][a-z0-9.-]*$/

const hashFile = async (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })

const defaultPreflight = async (path: string): Promise<void> => {
  await execFileAsync(path, ['--version'], { timeout: 10_000, windowsHide: true })
}

const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const code = (error as Error & { code?: string | number }).code
  if (typeof code === 'number') {
    const windowsStatus = `0x${(code >>> 0).toString(16).padStart(8, '0').toUpperCase()}`
    return `${error.message} (exit ${code}; ${windowsStatus})`
  }
  return code === undefined ? error.message : `${error.message} (exit ${code})`
}

export const micromambaRunnerCachePath = (
  toolsDir: string,
  candidateId: string,
  digest: string
): string => join(toolsDir, candidateId, digest, 'micromamba.exe')

const readReceipt = async (path: string): Promise<SelectionReceipt | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SelectionReceipt>
    if (
      parsed.schema !== 1 ||
      typeof parsed.candidateId !== 'string' ||
      !candidateIdPattern.test(parsed.candidateId) ||
      typeof parsed.sha256 !== 'string' ||
      !digestPattern.test(parsed.sha256)
    ) {
      return undefined
    }
    return parsed as SelectionReceipt
  } catch {
    return undefined
  }
}

const existingFileMatches = async (path: string, expected: string): Promise<boolean> => {
  try {
    return (await hashFile(path)) === expected
  } catch {
    return false
  }
}

const materializeCandidate = async (
  candidate: MicromambaRunnerCandidate,
  toolsDir: string,
  verifySignature?: (path: string) => Promise<void>
): Promise<{ path: string; sha256: string }> => {
  if (!candidateIdPattern.test(candidate.id)) {
    throw new Error(`invalid runner candidate id: ${candidate.id}`)
  }

  const sourceDigest = await hashFile(candidate.path)
  const expected = candidate.expectedSha256?.toLowerCase()
  const signedSource = Boolean(expected && sourceDigest !== expected && candidate.verifySignature)
  if (expected && sourceDigest !== expected && !signedSource) {
    throw new Error(`sha256 mismatch: expected ${expected}, got ${sourceDigest}`)
  }
  if (signedSource) {
    if (!verifySignature) throw new Error('signed runner requires Authenticode verification')
    await verifySignature(candidate.path)
  }

  const destination = micromambaRunnerCachePath(toolsDir, candidate.id, sourceDigest)
  if (await existingFileMatches(destination, sourceDigest)) {
    if (signedSource) {
      if (!verifySignature) throw new Error('signed runner requires Authenticode verification')
      await verifySignature(destination)
    }
    return { path: destination, sha256: sourceDigest }
  }

  await mkdir(join(toolsDir, candidate.id, sourceDigest), { recursive: true })
  const staging = `${destination}.${process.pid}.${randomUUID()}.tmp`
  try {
    await copyFile(candidate.path, staging)
    if (!(await existingFileMatches(staging, sourceDigest))) {
      throw new Error('copied runner failed sha256 verification')
    }
    if (signedSource) {
      if (!verifySignature) throw new Error('signed runner requires Authenticode verification')
      await verifySignature(staging)
    }
    await rm(destination, { force: true })
    await rename(staging, destination)
  } finally {
    await rm(staging, { force: true })
  }

  return { path: destination, sha256: sourceDigest }
}

const resolveRunner = async (opts: MicromambaRunnerResolverOptions): Promise<string> => {
  const preflight = opts.preflight ?? defaultPreflight
  const receiptPath = join(opts.toolsDir, 'selection.json')
  const failures: string[] = []
  const attempted = new Set<string>()
  const receipt = await readReceipt(receiptPath)

  const tryCandidate = async (
    candidate: MicromambaRunnerCandidate
  ): Promise<string | undefined> => {
    if (attempted.has(candidate.id)) return undefined
    attempted.add(candidate.id)
    try {
      const materialized = await materializeCandidate(
        candidate,
        opts.toolsDir,
        opts.verifySignature
      )
      await preflight(materialized.path)
      await mkdir(opts.toolsDir, { recursive: true })
      await writeFile(
        receiptPath,
        JSON.stringify(
          { schema: 1, candidateId: candidate.id, sha256: materialized.sha256 },
          undefined,
          2
        ) + '\n',
        'utf8'
      )
      return materialized.path
    } catch (error) {
      failures.push(`${candidate.id}: ${errorText(error)}`)
      return undefined
    }
  }

  const receiptCandidate = receipt
    ? opts.candidates.find((candidate) => candidate.id === receipt.candidateId)
    : undefined
  const receiptTier = receiptCandidate?.selectionTier ?? 'fallback'
  for (const candidate of opts.candidates) {
    const supersedesReceipt =
      (candidate.selectionTier === 'explicit' && candidate.id !== receiptCandidate?.id) ||
      (candidate.selectionTier === 'pinned-primary' && receiptTier === 'fallback')
    if (!supersedesReceipt) continue
    const selected = await tryCandidate(candidate)
    if (selected) return selected
  }

  if (receipt) {
    const cached = receiptCandidate
    const expected = cached?.expectedSha256?.toLowerCase()
    let sourceStillMatches = false
    if (cached) {
      const sourceDigest = await hashFile(cached.path).catch(() => undefined)
      sourceStillMatches = sourceDigest === receipt.sha256 || sourceDigest === expected
      if (!sourceStillMatches && cached.verifySignature && sourceDigest && opts.verifySignature) {
        try {
          await opts.verifySignature(cached.path)
          sourceStillMatches = true
        } catch (error) {
          failures.push(`${cached.id} cached signature: ${errorText(error)}`)
        }
      }
    }
    const receiptMatchesInstalled =
      cached &&
      (await existingFileMatches(
        micromambaRunnerCachePath(opts.toolsDir, cached.id, receipt.sha256),
        receipt.sha256
      ))
    if (cached && sourceStillMatches && receiptMatchesInstalled) {
      const path = micromambaRunnerCachePath(opts.toolsDir, cached.id, receipt.sha256)
      try {
        if (cached.verifySignature && expected !== receipt.sha256) {
          if (!opts.verifySignature) {
            throw new Error('signed runner requires Authenticode verification')
          }
          await opts.verifySignature(path)
        }
        if (await existingFileMatches(path, receipt.sha256)) {
          attempted.add(cached.id)
          await preflight(path)
          return path
        }
      } catch (error) {
        failures.push(`${cached.id} cached preflight: ${errorText(error)}`)
      }
    }
  }

  for (const candidate of opts.candidates) {
    const selected = await tryCandidate(candidate)
    if (selected) return selected
  }

  throw new Error(`No usable micromamba runner. ${failures.join('; ')}`)
}

export const createMicromambaRunnerResolver = (
  opts: MicromambaRunnerResolverOptions
): MicromambaRunner => {
  if (opts.candidates.length === 0)
    throw new Error('No micromamba runner candidates were provided.')
  let resolution: Promise<string> | undefined
  return {
    initialPath: opts.candidates[0].path,
    resolve: () => (resolution ??= resolveRunner(opts))
  }
}

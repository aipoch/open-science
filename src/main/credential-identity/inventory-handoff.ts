import { readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { createHash } from 'node:crypto'

// One desktop bootstrap only. A blocked startup must obtain a fresh snapshot on relaunch.
export const CREDENTIAL_INVENTORY_MAX_AGE_MS = 60_000

const credentialInventoryDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.number().int().nonnegative(),
    attemptId: z.string().uuid(),
    configRoot: z.string().min(1),
    profilePath: z.string().min(1),
    ciphertexts: z.array(z.string())
  })
  .strict()

const comparablePath = (path: string): string => {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const decodeCiphertext = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'base64')
  if (!value || !bytes.length || bytes.toString('base64') !== value)
    throw new Error('Credential inventory contains invalid ciphertext data')
  return bytes
}

export const writeCredentialInventory = async (options: {
  path: string
  attemptId: string
  configRoot: string
  profilePath: string
  ciphertexts: readonly Buffer[]
  capturedAt?: number
}): Promise<string> => {
  const document = JSON.stringify({
    schemaVersion: 1,
    capturedAt: options.capturedAt ?? Date.now(),
    attemptId: options.attemptId,
    configRoot: options.configRoot,
    profilePath: options.profilePath,
    ciphertexts: options.ciphertexts.map((value) => value.toString('base64'))
  })
  await writeFile(options.path, document, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return createHash('sha256').update(document).digest('hex')
}

export const removeCredentialInventory = async (path: string): Promise<void> => {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Credential inventory cleanup failed', { cause: error })
  }
}

export const readCredentialInventory = async (options: {
  path: string
  attemptId: string
  configRoot: string
  profilePath: string
  expectedDigest?: string
}): Promise<Buffer[]> => {
  try {
    const contents = await readFile(options.path, 'utf8')
    if (
      options.expectedDigest !== undefined &&
      createHash('sha256').update(contents).digest('hex') !== options.expectedDigest
    )
      throw new Error('Credential inventory integrity check failed')
    const parsed = credentialInventoryDocumentSchema.parse(JSON.parse(contents))
    const age = Date.now() - parsed.capturedAt
    if (age < 0 || age > CREDENTIAL_INVENTORY_MAX_AGE_MS)
      throw new Error('Credential inventory has expired; restart the desktop for a fresh snapshot')
    const mismatches = [
      parsed.attemptId !== options.attemptId ? 'attemptId' : undefined,
      comparablePath(parsed.configRoot) !== comparablePath(options.configRoot)
        ? 'configRoot'
        : undefined,
      comparablePath(parsed.profilePath) !== comparablePath(options.profilePath)
        ? 'profilePath'
        : undefined
    ].filter((value): value is string => Boolean(value))
    if (mismatches.length)
      throw new Error(`Credential inventory does not match this startup (${mismatches.join(',')})`)
    return parsed.ciphertexts.map(decodeCiphertext)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Credential inventory')) throw error
    throw new Error('Credential inventory bootstrap is unavailable or invalid', { cause: error })
  } finally {
    await removeCredentialInventory(options.path)
  }
}

export const consumeCredentialInventoryFromEnv = async (options: {
  attemptId: string
  configRoot: string
  profilePath: string
}): Promise<Buffer[] | undefined> => {
  const path = process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH
  const expectedDigest = process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256
  delete process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH
  delete process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256
  // This variable is private to the Electron-owned launch handoff. A direct backend/CLI launch
  // must not consume an inherited path from a parent shell or an unrelated child process.
  if (!path || !options.attemptId) return undefined
  // The digest travels outside the temporary file, so a corrupted/empty replacement cannot
  // replace the inventory captured by the parent. It is an integrity check, not authentication
  // against a process that can alter this process's launch environment.
  if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    await removeCredentialInventory(path)
    throw new Error('Credential inventory integrity metadata is missing or invalid')
  }
  return readCredentialInventory({ path, ...options, expectedDigest })
}

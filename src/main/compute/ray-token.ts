import { join } from 'node:path'
import { isRayBearerEndpoint, resolveRayJobsEndpoint } from '@aipoch/compute/node'
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'
import {
  decodeRayTokenDocument,
  rayTokenDocumentMaxBytes,
  rayTokenEndpointMaxLength,
  rayTokenFileName,
  rayTokenMaxEntries,
  type RayTokenEntry
} from '../credential-identity/ray-token-document'
import {
  assertCredentialAccessAllowed,
  assertCredentialReadAllowed
} from '../credential-identity/runtime'
import { resolveConfigRoot } from '../storage-root'
import { isRecord } from '../value-guards'
import { OptionalSecureStorageStringProtection } from '../secure-storage'

function canonicalEndpoint(endpoint: string): string {
  if (
    typeof endpoint !== 'string' ||
    !endpoint.trim() ||
    endpoint.length > rayTokenEndpointMaxLength
  )
    throw new Error('Invalid Ray Dashboard endpoint.')
  const canonical = resolveRayJobsEndpoint(endpoint)
  if (canonical.length > rayTokenEndpointMaxLength)
    throw new Error('Invalid Ray Dashboard endpoint.')
  return canonical
}
function validToken(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 16 * 1024 && /^[A-Za-z0-9._~+/-]+=*$/.test(value)
  )
}

// Each device host owns its configuration. Serialize whole read/modify/write operations across
// instances for the same file, including reads which can promote a crash-recovery temp.
const operations = new Map<string, Promise<unknown>>()

export class RayTokenStore {
  constructor(
    private readonly configRoot: () => string,
    private readonly protection: Pick<
      OptionalSecureStorageStringProtection,
      'protect' | 'reveal'
    > = new OptionalSecureStorageStringProtection()
  ) {}

  private async run<T>(
    operation: (entries: RayTokenEntry[], path: string) => T | Promise<T>
  ): Promise<T> {
    const path = join(this.configRoot(), rayTokenFileName)
    const prior = operations.get(path)
    const next = Promise.resolve(prior)
      .catch(() => {})
      .then(async () => {
        assertCredentialAccessAllowed()
        const result = await readDurableJsonFile(
          path,
          decodeRayTokenDocument,
          {},
          { maxBytes: rayTokenDocumentMaxBytes }
        )
        const entries = result.status === 'found' ? result.value.entries : []
        if (
          entries.some(
            ({ endpoint }) =>
              !isRayBearerEndpoint(endpoint) || canonicalEndpoint(endpoint) !== endpoint
          )
        )
          throw new Error('Invalid Ray Dashboard credential document.')
        return operation(entries, path)
      })
    operations.set(path, next)
    try {
      return await next
    } finally {
      if (operations.get(path) === next) operations.delete(path)
    }
  }

  private async write(entries: RayTokenEntry[], path: string): Promise<void> {
    const contents = JSON.stringify({ version: 1, entries })
    if (Buffer.byteLength(contents) > rayTokenDocumentMaxBytes)
      throw new Error('Ray Dashboard credential storage is full.')
    // Check the protected envelope before persistence, including when storage is unavailable.
    decodeRayTokenDocument(contents)
    assertCredentialAccessAllowed()
    await writeDurableJsonFile(path, contents)
  }

  list(): Promise<string[]> {
    return this.run((entries) => entries.map(({ endpoint }) => endpoint))
  }

  async set(endpoint: string, token: string): Promise<void> {
    const canonical = canonicalEndpoint(endpoint)
    if (!isRayBearerEndpoint(canonical))
      throw new Error('Ray Dashboard tokens require HTTPS or a loopback IP address.')
    if (!validToken(token)) throw new Error('Invalid Ray Dashboard access token.')
    await this.run(async (entries, path) => {
      const existing = entries.find((entry) => entry.endpoint === canonical)
      if (!existing && entries.length >= rayTokenMaxEntries)
        throw new Error('Ray Dashboard credential storage is full.')
      assertCredentialAccessAllowed()
      let sealed: string
      try {
        sealed = this.protection.protect(JSON.stringify({ endpoint: canonical, token }))
      } catch {
        throw new Error('Secure credential storage unavailable.')
      }
      if (existing) existing.sealed = sealed
      else entries.push({ endpoint: canonical, sealed })
      await this.write(entries, path)
    })
  }

  async remove(endpoint: string): Promise<void> {
    const canonical = canonicalEndpoint(endpoint)
    await this.run(async (entries, path) => {
      const kept = entries.filter((entry) => entry.endpoint !== canonical)
      if (kept.length !== entries.length) await this.write(kept, path)
    })
  }

  async get(endpoint: string): Promise<string | undefined> {
    const canonical = canonicalEndpoint(endpoint)
    if (!isRayBearerEndpoint(canonical)) return undefined
    return this.run((entries) => {
      const entry = entries.find((candidate) => candidate.endpoint === canonical)
      if (!entry) return undefined
      assertCredentialReadAllowed()
      try {
        const material: unknown = JSON.parse(this.protection.reveal(entry.sealed))
        if (isRecord(material) && material.endpoint === canonical && validToken(material.token))
          return material.token
      } catch {
        // Neither malformed decrypted text nor an underlying cipher diagnostic may escape.
      }
      throw new Error('Unable to read the Ray Dashboard access token.')
    })
  }
}

export const rayTokens = new RayTokenStore(resolveConfigRoot)
export const getRayToken = (endpoint: string): Promise<string | undefined> =>
  rayTokens.get(endpoint)

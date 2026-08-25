import { createHash, createPublicKey, verify } from 'node:crypto'

import { z } from 'zod'

import { validateSpecialistPackageVersion } from '../../../shared/specialist'

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const semver = z
  .string()
  .refine((value) => validateSpecialistPackageVersion(value) === undefined, 'Expected SemVer.')
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((segment) => segment && segment !== '.' && segment !== '..'),
    'Expected a safe relative path.'
  )

const publisherSchema = z
  .object({
    id,
    name: z.string().min(1).max(160),
    url: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === 'https:')
      .optional()
  })
  .strict()

const rootSchema = z
  .object({
    schema_version: z.literal(1),
    revision: z.string().min(1).max(128),
    marketplace: z.object({ id, name: z.string().min(1).max(160) }).strict(),
    specialists: z
      .array(
        z
          .object({
            id,
            display_name: z.string().min(1).max(160),
            summary: z.string().min(1).max(500),
            author: z.string().trim().min(1).max(160).optional(),
            publisher: publisherSchema,
            latest: z
              .object({
                version: semver,
                release: z.object({ path: relativePath, sha256: digest }).strict()
              })
              .strict()
          })
          .strict()
      )
      .max(2_000)
  })
  .strict()

const signatureSchema = z
  .object({
    schema_version: z.literal(1),
    algorithm: z.literal('ed25519'),
    key_id: id,
    public_key: z.string().min(1).max(1_024),
    signature: z.string().min(1).max(1_024)
  })
  .strict()

const releaseSchema = z
  .object({
    schema_version: z.literal(1),
    specialist_id: id,
    version: semver,
    source: z
      .object({
        repository: z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === 'https:'),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        license: z.string().min(1).max(128)
      })
      .strict(),
    artifact: z
      .object({
        path: relativePath,
        github_release: z
          .object({ tag: z.string().min(1).max(255), asset_name: z.string().min(1).max(255) })
          .strict(),
        sha256: digest,
        compressed_bytes: z.number().int().nonnegative(),
        uncompressed_bytes: z.number().int().nonnegative(),
        file_count: z.number().int().nonnegative()
      })
      .strict(),
    defaults: z.object({ skill_ids: z.array(id), connector_ids: z.array(id) }).strict(),
    skills: z
      .array(
        z
          .object({
            id,
            name: id,
            display_name: z.string().min(1).max(160),
            description: z.string().min(1).max(500),
            path: relativePath,
            content_digest: digest,
            file_count: z.number().int().nonnegative(),
            uncompressed_bytes: z.number().int().nonnegative()
          })
          .strict()
      )
      .max(4_096),
    connectors: z
      .array(
        z
          .object({
            id,
            required: z.boolean(),
            default_selected: z.boolean()
          })
          .strict()
      )
      .max(512)
  })
  .strict()

export type MarketplaceRoot = z.infer<typeof rootSchema>
export type MarketplaceSignature = z.infer<typeof signatureSchema>
export type MarketplaceRelease = z.infer<typeof releaseSchema>

const decoder = new TextDecoder('utf-8', { fatal: true })

const parseJson = (bytes: Uint8Array): unknown => JSON.parse(decoder.decode(bytes))

export const parseMarketplaceRoot = (bytes: Uint8Array): MarketplaceRoot =>
  rootSchema.parse(parseJson(bytes))

export const parseMarketplaceSignature = (bytes: Uint8Array): MarketplaceSignature =>
  signatureSchema.parse(parseJson(bytes))

export const parseMarketplaceRelease = (bytes: Uint8Array): MarketplaceRelease =>
  releaseSchema.parse(parseJson(bytes))

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

export const marketplaceKeyFingerprint = (publicKey: string): string =>
  sha256(Buffer.from(publicKey, 'base64'))

export const verifyMarketplaceRoot = (
  rootBytes: Uint8Array,
  signature: MarketplaceSignature
): boolean => {
  try {
    const key = createPublicKey({
      key: Buffer.from(signature.public_key, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return verify(null, rootBytes, key, Buffer.from(signature.signature, 'base64'))
  } catch {
    return false
  }
}

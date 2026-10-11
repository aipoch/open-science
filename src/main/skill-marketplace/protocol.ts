import { createHash, createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  skillMarketplaceCategories,
  type SkillMarketplaceEntry
} from '../../shared/skill-marketplace'

// Protocol v1: aipoch/openscience-skill-marketplace/protocol/schemas (Apache-2.0).
// Wire names stay at this boundary. Unknown fields fail closed until explicitly supported.
const text = (max: number): z.ZodString => z.string().min(1).max(max)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = text(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const version = text(128).regex(
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
)
export const marketplacePath = text(1024).refine(
  (value) =>
    value === value.normalize('NFC') &&
    // eslint-disable-next-line no-control-regex -- Protocol paths must reject ASCII controls.
    !/[\\\x00-\x1f\x7f<>:"|?*]/.test(value) &&
    value
      .split('/')
      .every(
        (part) =>
          part &&
          Buffer.byteLength(part) <= 255 &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      )
)
const path = marketplacePath
const https = text(4096).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
})
const immutableUrl = https.refine((value) =>
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[a-f0-9]{40}\/.+/.test(value)
)
const date = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value
  )
const score = z.strictObject({ score: z.number().nonnegative(), max_score: z.number().positive() })
const evaluation = z
  .strictObject({
    kind: z.literal('upstream-self-assessment'),
    ...score.shape,
    report_url: immutableUrl,
    evaluated_on: date.optional(),
    evaluator_version: text(200).optional(),
    skill_version: text(200).optional(),
    static_score: score.optional(),
    dynamic_score: score.optional()
  })
  .refine((value) =>
    [value, value.static_score, value.dynamic_score].every(
      (pair) => !pair || pair.score <= pair.max_score
    )
  )
const skillFields = {
  id,
  version,
  display_name: text(500),
  summary: text(10000),
  category: z.enum(skillMarketplaceCategories),
  source: z.strictObject({
    repository: https.refine((value) =>
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
    ),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    path,
    upstream_version: text(200).optional()
  }),
  publisher: z.strictObject({ id, name: text(200), url: https }),
  authors: z
    .array(z.strictObject({ name: text(500), url: https.optional() }))
    .min(1)
    .max(30)
    .optional(),
  evaluation: evaluation.optional()
}
const pointer = z.strictObject({ path, sha256: hash })
const artifact = z.strictObject({
  path: z.string().regex(/^shards\/[a-f0-9]{64}\.zip$/),
  sha256: hash,
  bytes: z.number().int().min(1).max(67108864),
  skill_path: path.pipe(text(128))
})
const listing = z.strictObject({
  ...skillFields,
  license: text(500),
  release: pointer,
  artifact,
  content_sha256: hash
})
const rootSchema = z.strictObject({
  schema_version: z.literal(1),
  protocol: z.literal('openscience-skill-marketplace'),
  revision: hash,
  marketplace: z.strictObject({ id: z.literal('openscience-skills'), name: text(200) }),
  skills: z.array(listing).max(584),
  release_index: pointer,
  previous_revision: hash.nullable()
})
const indexSchema = z.strictObject({
  schema_version: z.literal(1),
  releases: z.array(pointer).max(10000)
})
const releaseSchema = z.strictObject({
  schema_version: z.literal(1),
  protocol: z.literal('openscience-skill-marketplace'),
  skill: z.strictObject({
    ...skillFields,
    license: z.strictObject({
      expression: text(500),
      evidence: z
        .array(z.strictObject({ url: immutableUrl, sha256: hash }))
        .min(1)
        .max(20),
      review: z.strictObject({
        reviewed_by: text(200),
        reviewed_on: date,
        exception_reason: text(2000).optional()
      })
    })
  }),
  package: z.strictObject({
    content_sha256: hash,
    file_count: z.number().int().min(1).max(16384),
    uncompressed_bytes: z.number().int().min(1).max(134217728)
  }),
  artifact
})

// Independently read from the production environment public variable, not from the envelope.
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAZxbPFjkKi5iSxkFaxeIeBiOuatWOTQTHv0b8n+sYe0A='
const signatureSchema = z.strictObject({
  schema_version: z.literal(1),
  algorithm: z.literal('ed25519'),
  key_id: z.literal('openscience-skills-prod-1'),
  public_key: z.literal(PUBLIC_KEY),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
})
const publicKey = createPublicKey({
  key: Buffer.from(PUBLIC_KEY, 'base64'),
  format: 'der',
  type: 'spki'
})
export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
const json = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

export type MarketplaceRoot = z.infer<typeof rootSchema>

function checkSkill(skill: z.infer<typeof listing> | z.infer<typeof releaseSchema>['skill']): void {
  const evaluation = skill.evaluation
  if (!evaluation) return
  const prefix = `${skill.source.repository}/blob/${skill.source.commit}/${skill.source.path.split('/').map(encodeURIComponent).join('/')}/`
  if (!evaluation.report_url.startsWith(prefix)) throw new Error('Assessment source mismatch')
  const relative = decodeURIComponent(evaluation.report_url.slice(prefix.length))
  path.parse(relative)
  if (
    !relative.endsWith('.json') ||
    prefix + relative.split('/').map(encodeURIComponent).join('/') !== evaluation.report_url
  ) {
    throw new Error('Assessment path mismatch')
  }
}

export function verifyMarketplaceRoot(
  bytes: Uint8Array,
  signatureBytes: Uint8Array
): MarketplaceRoot {
  const envelope = signatureSchema.parse(json(signatureBytes))
  if (!verify(null, bytes, publicKey, Buffer.from(envelope.signature, 'base64')))
    throw new Error('Invalid catalog signature')
  const source = json(bytes)
  const root = rootSchema.parse(source)
  // Hash the validated original property order, before Zod projects the wire object.
  const { revision, ...body } = source as MarketplaceRoot
  if (sha256(Buffer.from(JSON.stringify(body, null, 2) + '\n')) !== revision)
    throw new Error('Catalog revision mismatch')
  if (root.release_index.path !== `indexes/${root.release_index.sha256}.json`)
    throw new Error('Index path mismatch')
  const seen = new Set<string>()
  for (const skill of root.skills) {
    checkSkill(skill)
    if (
      seen.has(skill.id) ||
      skill.release.path !== `releases/${skill.id}/${skill.version}.json` ||
      skill.artifact.path !== `shards/${skill.artifact.sha256}.zip` ||
      skill.artifact.skill_path !== skill.id
    )
      throw new Error('Listing identity mismatch')
    seen.add(skill.id)
  }
  return root
}

export function verifyMarketplaceIndex(bytes: Uint8Array, root: MarketplaceRoot): void {
  if (sha256(bytes) !== root.release_index.sha256) throw new Error('Index digest mismatch')
  const index = indexSchema.parse(json(bytes))
  const entries = new Map(index.releases.map((release) => [release.path, release.sha256]))
  if (
    entries.size !== index.releases.length ||
    root.skills.some((skill) => entries.get(skill.release.path) !== skill.release.sha256)
  )
    throw new Error('Release index mismatch')
}

export function toMarketplaceEntry(
  skill: z.infer<typeof listing> | z.infer<typeof releaseSchema>['skill']
): SkillMarketplaceEntry {
  const value = skill.evaluation
  const pair = (
    value: z.infer<typeof score> | undefined
  ): { score: number; maxScore: number } | undefined =>
    value && { score: value.score, maxScore: value.max_score }
  return {
    id: skill.id,
    displayName: skill.display_name,
    summary: skill.summary,
    category: skill.category,
    version: skill.version,
    authors: skill.authors,
    publisher: { name: skill.publisher.name, url: skill.publisher.url },
    source: {
      repository: skill.source.repository,
      commit: skill.source.commit,
      path: skill.source.path
    },
    license: typeof skill.license === 'string' ? skill.license : skill.license.expression,
    evaluation: value && {
      kind: value.kind,
      score: value.score,
      maxScore: value.max_score,
      reportUrl: value.report_url,
      evaluatedOn: value.evaluated_on,
      evaluatorVersion: value.evaluator_version,
      skillVersion: value.skill_version,
      staticScore: pair(value.static_score),
      dynamicScore: pair(value.dynamic_score)
    }
  }
}

export function verifyMarketplaceDetail(
  bytes: Uint8Array,
  listing: MarketplaceRoot['skills'][number]
): {
  entry: SkillMarketplaceEntry
  licenseEvidence: { url: string; sha256: string }[]
  package: { contentSha256: string; fileCount: number; uncompressedBytes: number }
} {
  const { release: pointer, artifact, content_sha256, ...listedSkill } = listing
  if (sha256(bytes) !== pointer.sha256) throw new Error('Descriptor digest mismatch')
  const release = releaseSchema.parse(json(bytes))
  checkSkill(release.skill)
  if (
    !isDeepStrictEqual(
      { ...release.skill, license: release.skill.license.expression },
      listedSkill
    ) ||
    !isDeepStrictEqual(artifact, release.artifact) ||
    content_sha256 !== release.package.content_sha256
  )
    throw new Error('Descriptor identity mismatch')
  return {
    entry: toMarketplaceEntry(release.skill),
    licenseEvidence: release.skill.license.evidence,
    package: {
      contentSha256: release.package.content_sha256,
      fileCount: release.package.file_count,
      uncompressedBytes: release.package.uncompressed_bytes
    }
  }
}

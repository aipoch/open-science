import { z } from 'zod'

// Optional Artifact content, not a .science manifest extension or a sealed execution recipe.
export const RESEARCH_REPRODUCTION_FORMAT = 'open-science-reproduction-description'
export const RESEARCH_REPRODUCTION_MAX_BYTES = 512 * 1024
const MAX_FILE_BYTES = 32 * 1024 ** 3
const MAX_EXPANDED_BYTES = 256 * 1024 ** 3
const MAX_ENTRIES = 10_000
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const encoder = new TextEncoder()

export type ResearchReproductionIssue = { path: string; message: string }
type Invalid = { status: 'invalid'; issues: ResearchReproductionIssue[] }

const invalid = (message: string, path = ''): Invalid => ({
  status: 'invalid',
  issues: [{ path, message }]
})

// Check before Zod or JSON serialization: do not invoke getters, custom prototypes or toJSON.
const inspectJsonValue = (input: unknown): Invalid | undefined => {
  const ancestors = new Set<object>()
  let nodes = 0
  let bytes = 0
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 50_000 || depth > 24) return false
    if (value === null || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'string') {
      bytes += encoder.encode(value).byteLength
      return bytes <= RESEARCH_REPRODUCTION_MAX_BYTES
    }
    if (typeof value !== 'object' || ancestors.has(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (
      prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype) &&
      prototype !== null
    )
      return false
    if (Object.getOwnPropertySymbols(value).length) return false
    ancestors.add(value)
    const properties = Object.getOwnPropertyDescriptors(value)
    if (Array.isArray(value) && value.length > MAX_ENTRIES) return false
    for (const [key, property] of Object.entries(properties)) {
      if (Array.isArray(value) && key === 'length') continue
      if (
        forbiddenKeys.has(key) ||
        !property.enumerable ||
        !('value' in property) ||
        (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key))
      )
        return false
      bytes += encoder.encode(key).byteLength
      if (bytes > RESEARCH_REPRODUCTION_MAX_BYTES || !visit(property.value, depth + 1)) return false
    }
    if (Array.isArray(value) && Object.keys(properties).length !== value.length + 1) return false
    ancestors.delete(value)
    return true
  }
  try {
    if (!visit(input, 0)) return invalid('Expected bounded plain JSON without reserved keys.')
    if (encoder.encode(JSON.stringify(input)).byteLength > RESEARCH_REPRODUCTION_MAX_BYTES)
      return invalid('Description exceeds the byte limit.')
  } catch {
    return invalid('Expected bounded plain JSON.')
  }
  return undefined
}

export const isPortableResearchReproductionPath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 1024 &&
  value.split('/').every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      // eslint-disable-next-line no-control-regex -- paths must be portable across filesystems
      !/[\\<>:"|?*\u0000-\u001f\u007f]/u.test(segment) &&
      !/[. ]$/u.test(segment) &&
      !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment)
  )

const portablePath = z
  .string()
  .refine(isPortableResearchReproductionPath, 'Expected a portable relative path.')
const key = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
  .refine((value) => !forbiddenKeys.has(value))
const text = z.string().trim().min(1).max(4096)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const size = z.number().int().min(0).max(MAX_FILE_BYTES)
const httpsUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'https:' &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  }, 'Expected a public HTTPS URL without credentials, query or fragment.')
const role = z.enum([
  'source',
  'data',
  'checkpoint',
  'reference',
  'script',
  'configuration',
  'documentation'
])
const archiveEntrySchema = z.discriminatedUnion('type', [
  z
    .object({ path: portablePath, type: z.literal('file'), sha256: digest, sizeBytes: size })
    .strict(),
  z.object({ path: portablePath, type: z.literal('directory') }).strict()
])
const archiveEntriesSchema = z.array(archiveEntrySchema).min(1).max(MAX_ENTRIES)
export type ResearchReproductionArchiveEntry = z.infer<typeof archiveEntrySchema>

type PathEntry = { path: string; type: 'file' | 'directory' }

// Include implicit parent directories: a/one + A/two also collide on portable filesystems.
const pathIssues = (
  entries: readonly PathEntry[],
  allowSharedDirectories = false
): ResearchReproductionIssue[] => {
  const paths = new Map<string, { path: string; type: PathEntry['type']; explicit: boolean }>()
  const issues: ResearchReproductionIssue[] = []
  for (const entry of entries) {
    const segments = entry.path.split('/')
    for (let index = 1; index <= segments.length; index++) {
      const path = segments.slice(0, index).join('/')
      const normalized = path.normalize('NFC').toLowerCase()
      const explicit = index === segments.length
      const type = explicit ? entry.type : 'directory'
      const previous = paths.get(normalized)
      if (previous) {
        if (
          previous.path !== path ||
          previous.type !== type ||
          (previous.explicit && explicit && !(allowSharedDirectories && type === 'directory'))
        ) {
          issues.push({
            path: entry.path,
            message: 'Restore paths collide or a file is used as a directory.'
          })
          break
        }
        previous.explicit ||= explicit
      } else paths.set(normalized, { path, type, explicit })
    }
  }
  return issues
}

const zodIssues = (error: z.ZodError): ResearchReproductionIssue[] =>
  error.issues.slice(0, 32).map((issue) => ({ path: issue.path.join('.'), message: issue.message }))

const archiveIssues = (
  entries: readonly ResearchReproductionArchiveEntry[]
): ResearchReproductionIssue[] => {
  const issues = pathIssues(entries)
  if (
    entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.sizeBytes : 0), 0) >
    MAX_EXPANDED_BYTES
  )
    issues.push({ path: 'entries', message: 'Archive contents exceed the expanded byte limit.' })
  return issues
}

export const validateResearchReproductionArchiveEntries = (
  input: unknown
): { status: 'valid'; entries: ResearchReproductionArchiveEntry[] } | Invalid => {
  const unsafe = inspectJsonValue(input)
  if (unsafe) return unsafe
  const parsed = archiveEntriesSchema.safeParse(input)
  if (!parsed.success) return { status: 'invalid', issues: zodIssues(parsed.error) }
  const issues = archiveIssues(parsed.data)
  return issues.length
    ? { status: 'invalid', issues: issues.slice(0, 32) }
    : { status: 'valid', entries: parsed.data }
}

// The archive reader supplies observed sizes and digests. This compares inventories only; it
// neither opens an archive nor authorizes extraction. Explicit directory headers are optional.
export const compareResearchReproductionArchiveEntries = (
  expected: unknown,
  observed: unknown
): { status: 'matched' } | Invalid => {
  const declared = validateResearchReproductionArchiveEntries(expected)
  if (declared.status === 'invalid') return declared
  const actual = validateResearchReproductionArchiveEntries(observed)
  if (actual.status === 'invalid') return actual
  const files = new Map(
    declared.entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry])
  )
  const actualFiles = actual.entries.filter((entry) => entry.type === 'file')
  if (actualFiles.length !== files.size) return invalid('Archive file inventory does not match.')
  for (const entry of actualFiles) {
    const reference = files.get(entry.path)
    if (!reference || reference.sha256 !== entry.sha256 || reference.sizeBytes !== entry.sizeBytes)
      return invalid('Archive file identity does not match.', entry.path)
  }
  // Empty, otherwise unlisted directories also change the declared restoration tree.
  const directories = (entries: readonly ResearchReproductionArchiveEntry[]): Set<string> => {
    const result = new Set<string>()
    for (const entry of entries) {
      const segments = entry.path.split('/')
      const count = entry.type === 'directory' ? segments.length : segments.length - 1
      for (let index = 1; index <= count; index++) result.add(segments.slice(0, index).join('/'))
    }
    return result
  }
  const declaredDirectories = directories(declared.entries)
  const actualDirectories = directories(actual.entries)
  if (
    declaredDirectories.size !== actualDirectories.size ||
    [...actualDirectories].some((path) => !declaredDirectories.has(path))
  )
    return invalid('Archive directory inventory does not match.')
  return { status: 'matched' }
}

const materialSchema = z.discriminatedUnion('availability', [
  z
    .object({
      key,
      role,
      availability: z.literal('included'),
      filename: portablePath.refine(
        (value) => !value.includes('/'),
        'Expected a filename, not a path.'
      ),
      sha256: digest,
      sizeBytes: size,
      restorePath: portablePath,
      archive: z
        .object({ format: z.enum(['tar', 'tar.gz', 'zip']), entries: archiveEntriesSchema })
        .strict()
        .optional(),
      source: z
        .object({
          repository: httpsUrl,
          commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)
        })
        .strict()
        .optional()
    })
    .strict(),
  z
    .object({
      key,
      role,
      availability: z.literal('external'),
      description: text,
      url: httpsUrl.optional()
    })
    .strict(),
  z.object({ key, role, availability: z.literal('withheld'), description: text }).strict()
])

const materialPath = z.object({ materialKey: key, path: portablePath.optional() }).strict()
const planSchema = z
  .object({
    key,
    title: text,
    scope: z.enum(['end-to-end', 'downstream-only', 'alternative-conditions', 'engineering-check']),
    materialKeys: z.array(key).min(1).max(1000),
    claim: text,
    limitations: z.array(text).max(100),
    entrypoints: z
      .array(
        z
          .object({
            materialKey: key,
            path: portablePath.optional(),
            arguments: z.array(z.string().max(4096)).max(100).optional()
          })
          .strict()
      )
      .max(32)
      .optional(),
    requirements: z
      .object({
        node: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[0-9A-Za-z.*<>=~^| -]+$/u)
          .optional(),
        platforms: z
          .array(z.enum(['darwin', 'linux', 'win32']))
          .min(1)
          .max(3)
          .optional(),
        lockfile: materialPath.optional()
      })
      .strict()
      .optional()
  })
  .strict()

const parameterSchema = z.discriminatedUnion('type', [
  z
    .object({
      key,
      type: z.literal('string'),
      description: text,
      default: z.string().max(4096).optional()
    })
    .strict(),
  z
    .object({
      key,
      type: z.literal('number'),
      description: text,
      default: z.number().finite().optional()
    })
    .strict(),
  z
    .object({ key, type: z.literal('boolean'), description: text, default: z.boolean().optional() })
    .strict()
])

const reservedEnvironment = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH'
])
const descriptionSchema = z
  .object({
    format: z.literal(RESEARCH_REPRODUCTION_FORMAT),
    descriptionVersion: z.literal(1),
    title: text,
    materials: z.array(materialSchema).min(1).max(1000),
    plans: z.array(planSchema).min(1).max(32),
    parameters: z.array(parameterSchema).max(100).optional(),
    secrets: z
      .array(
        z
          .object({
            key,
            description: text,
            required: z.boolean(),
            environmentVariable: z
              .string()
              .regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
              .refine(
                (value) => !reservedEnvironment.has(value) && !value.startsWith('OPEN_SCIENCE_')
              ),
            planKeys: z.array(key).min(1).max(32)
          })
          .strict()
      )
      .max(100)
      .optional()
  })
  .strict()

export type ResearchReproductionDescription = z.infer<typeof descriptionSchema>
export type ResearchReproductionMaterial = z.infer<typeof materialSchema>
export type ResearchReproductionInspection =
  | { status: 'valid'; description: ResearchReproductionDescription }
  | { status: 'unsupported'; version: number }
  | Invalid

const descriptionIssues = (
  description: ResearchReproductionDescription
): ResearchReproductionIssue[] => {
  const issues: ResearchReproductionIssue[] = []
  const unique = (values: readonly string[], path: string): void => {
    if (new Set(values).size !== values.length)
      issues.push({ path, message: 'Keys must be unique.' })
  }
  unique(
    description.materials.map((material) => material.key),
    'materials'
  )
  unique(
    description.materials.flatMap((material) =>
      material.availability === 'included' ? [material.restorePath] : []
    ),
    'materials.restorePath'
  )
  unique(
    description.plans.map((plan) => plan.key),
    'plans'
  )
  unique(
    [...(description.parameters ?? []), ...(description.secrets ?? [])].map(
      (parameter) => parameter.key
    ),
    'parameters'
  )
  unique(
    (description.secrets ?? []).map((secret) => secret.environmentVariable),
    'secrets'
  )
  const materials = new Map(description.materials.map((material) => [material.key, material]))
  const restored: PathEntry[] = []
  let expandedBytes = 0
  for (const material of description.materials) {
    if (material.availability !== 'included') continue
    restored.push({ path: material.restorePath, type: material.archive ? 'directory' : 'file' })
    if (material.archive) {
      issues.push(
        ...archiveIssues(material.archive.entries).map((issue) => ({
          ...issue,
          path: `materials.${material.key}.archive.${issue.path}`
        }))
      )
      for (const entry of material.archive.entries) {
        restored.push({ path: `${material.restorePath}/${entry.path}`, type: entry.type })
        if (entry.type === 'file') expandedBytes += entry.sizeBytes
      }
    } else expandedBytes += material.sizeBytes
  }
  issues.push(...pathIssues(restored, true))
  if (expandedBytes > MAX_EXPANDED_BYTES)
    issues.push({
      path: 'materials',
      message: 'Restored materials exceed the expanded byte limit.'
    })
  for (const plan of description.plans) {
    unique(plan.materialKeys, `plans.${plan.key}.materialKeys`)
    for (const materialKey of plan.materialKeys)
      if (!materials.has(materialKey))
        issues.push({
          path: `plans.${plan.key}.materialKeys`,
          message: 'Plan references an unknown material.'
        })
    const references = [
      ...(plan.entrypoints ?? []),
      ...(plan.requirements?.lockfile ? [plan.requirements.lockfile] : [])
    ]
    for (const reference of references) {
      const material = materials.get(reference.materialKey)
      if (!material || !plan.materialKeys.includes(reference.materialKey)) {
        issues.push({
          path: `plans.${plan.key}`,
          message: 'Entrypoint or lockfile must reference a material required by this plan.'
        })
      } else if (material.availability === 'included') {
        const isDeclaredFile = material.archive
          ? material.archive.entries.some(
              (entry) => entry.type === 'file' && entry.path === reference.path
            )
          : reference.path === undefined
        if (!isDeclaredFile)
          issues.push({
            path: `plans.${plan.key}`,
            message: 'Entrypoint or lockfile must identify a declared material file.'
          })
      }
    }
  }
  const planKeys = new Set(description.plans.map((plan) => plan.key))
  for (const secret of description.secrets ?? []) {
    unique(secret.planKeys, `secrets.${secret.key}.planKeys`)
    if (secret.planKeys.some((planKey) => !planKeys.has(planKey)))
      issues.push({
        path: `secrets.${secret.key}.planKeys`,
        message: 'Secret slot references an unknown plan.'
      })
  }
  return issues.slice(0, 32)
}

export const inspectResearchReproductionDescription = (
  input: unknown
): ResearchReproductionInspection => {
  const unsafe = inspectJsonValue(input)
  if (unsafe) return unsafe
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return invalid('Expected a description object.')
  const envelope = input as Record<string, unknown>
  if (envelope.format !== RESEARCH_REPRODUCTION_FORMAT)
    return invalid('Unknown description format.', 'format')
  if (
    typeof envelope.descriptionVersion === 'number' &&
    Number.isSafeInteger(envelope.descriptionVersion) &&
    envelope.descriptionVersion > 1
  )
    return { status: 'unsupported', version: envelope.descriptionVersion }
  const parsed = descriptionSchema.safeParse(input)
  if (!parsed.success) return { status: 'invalid', issues: zodIssues(parsed.error) }
  const issues = descriptionIssues(parsed.data)
  return issues.length
    ? { status: 'invalid', issues }
    : { status: 'valid', description: parsed.data }
}

export const parseResearchReproductionDescription = (
  json: string
): ResearchReproductionInspection => {
  if (encoder.encode(json).byteLength > RESEARCH_REPRODUCTION_MAX_BYTES)
    return invalid('Description exceeds the byte limit.')
  try {
    const value: unknown = JSON.parse(json)
    // JSON.parse otherwise silently accepts contradictory fields. Tokenize only validated JSON;
    // strings stay whole, including escaped quotes, so punctuation inside values is never syntax.
    const containers: (Set<string> | null)[] = []
    const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}[\]:,]/gu
    for (const match of json.matchAll(tokens)) {
      const token = match[0]
      if (token === '{') containers.push(new Set())
      else if (token === '[') containers.push(null)
      else if (token === '}' || token === ']') containers.pop()
      else if (token.startsWith('"')) {
        let next = match.index + token.length
        while (/\s/u.test(json[next] ?? '') && next < json.length) next++
        if (json[next] !== ':') continue
        const object = containers.at(-1)
        const name = JSON.parse(token) as string
        if (object?.has(name)) return invalid('Description has duplicate object fields.')
        object?.add(name)
      }
    }
    return inspectResearchReproductionDescription(value)
  } catch {
    return invalid('Description is not valid JSON.')
  }
}

// The caller supplies the exact imported research closure, not the Project-wide Artifact catalog.
// Metadata must come from verified managed Versions; this function does not read or hash bytes.
export type ResearchReproductionMaterialCandidate = {
  researchId: string
  artifactId: string
  filename: string
  sha256: string
  sizeBytes: number
  contentAvailable?: boolean
}
export type ResearchReproductionMaterialResolution = {
  key: string
  status: 'available' | 'external' | 'withheld' | 'missing' | 'mismatch'
  artifactIds?: string[]
}

export const resolveResearchReproductionMaterials = (
  description: ResearchReproductionDescription,
  catalog: { researchId: string; artifacts: readonly ResearchReproductionMaterialCandidate[] }
): ResearchReproductionMaterialResolution[] => {
  const scoped = catalog.artifacts.filter((artifact) => artifact.researchId === catalog.researchId)
  return description.materials.map((material) => {
    if (material.availability !== 'included')
      return { key: material.key, status: material.availability }
    const matching = scoped.filter(
      (artifact) => artifact.sha256 === material.sha256 && artifact.sizeBytes === material.sizeBytes
    )
    const available = matching.filter((artifact) => artifact.contentAvailable !== false)
    if (available.length)
      return {
        key: material.key,
        status: 'available',
        artifactIds: [...new Set(available.map((artifact) => artifact.artifactId))].sort()
      }
    if (matching.length) return { key: material.key, status: 'missing' }
    return {
      key: material.key,
      status: scoped.some(
        (artifact) => artifact.sha256 === material.sha256 || artifact.filename === material.filename
      )
        ? 'mismatch'
        : 'missing'
    }
  })
}

import { dump, load } from 'js-yaml'

import type { ArtifactVersionDescriptor } from '../../shared/artifact-provenance'
import { MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS } from '../../shared/artifacts'
import type {
  ManuscriptBibtexExport,
  ManuscriptBibliography,
  ManuscriptCitationKey,
  PrepareManuscriptResult,
  ResolvedManuscriptReference
} from '../../shared/manuscripts'

type ResolveManuscriptReferencesRequest = Readonly<{
  projectId: string
  appSessionId: string
  content: string
  resolveVersionDescriptors: (request: {
    projectId: string
    appSessionId: string
    versionIds: string[]
  }) => Promise<ArtifactVersionDescriptor[]>
  exportBibtex?: (itemIds: readonly string[]) => Promise<ManuscriptBibtexExport>
}>

type ManuscriptReferenceErrorCode =
  | 'INVALID_MANUSCRIPT_REFERENCE'
  | 'UNKNOWN_ARTIFACT_REFERENCE'
  | 'UNKNOWN_ARTIFACT_VERSION'
  | 'STALE_ARTIFACT_VERSION'

class ManuscriptReferenceError extends Error {
  constructor(
    readonly code: ManuscriptReferenceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ManuscriptReferenceError'
  }
}

type FrontMatter = {
  body: string
  prefix: string
  value: Record<string, unknown>
  present: boolean
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u
const FIGURE_REFERENCE = /(?<![\w@])@(fig-[A-Za-z0-9][A-Za-z0-9_-]*)\b/gu
const SHA256 = /^[a-f0-9]{64}$/u
const CITATION_KEY = /^[A-Za-z0-9][A-Za-z0-9_:.+-]{0,127}$/u

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requiredString = (value: unknown, field: string, maxLength: number): string => {
  if (typeof value !== 'string') {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      `Manuscript Artifact reference ${field} must be a string.`
    )
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      `Manuscript Artifact reference ${field} is invalid.`
    )
  }
  return trimmed
}

const parseFrontMatter = (content: string): FrontMatter => {
  const match = FRONT_MATTER.exec(content)
  if (!match) {
    return { body: content, prefix: '', value: {}, present: false }
  }

  let parsed: unknown
  try {
    parsed = load(match[1] ?? '')
  } catch (error) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      `Manuscript Quarto front matter is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (parsed !== undefined && !isRecord(parsed)) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      'Manuscript Quarto front matter must be a YAML mapping.'
    )
  }

  return {
    body: content.slice(match[0].length),
    prefix: match[0],
    value: parsed ?? {},
    present: true
  }
}

const parseBindings = (frontMatter: FrontMatter): Map<string, ResolvedManuscriptReference> => {
  const openScience = frontMatter.value['open-science']
  if (openScience === undefined) return new Map()
  if (!isRecord(openScience)) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      'Manuscript front matter open-science must be a mapping.'
    )
  }
  const artifactReferences = openScience['artifact-references']
  if (artifactReferences === undefined) return new Map()
  if (!isRecord(artifactReferences)) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      'Manuscript front matter open-science.artifact-references must be a mapping.'
    )
  }

  const bindings = new Map<string, ResolvedManuscriptReference>()
  for (const [rawLabel, rawBinding] of Object.entries(artifactReferences)) {
    const label = rawLabel.startsWith('@') ? rawLabel.slice(1) : rawLabel
    if (!/^fig-[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(label)) {
      throw new ManuscriptReferenceError(
        'INVALID_MANUSCRIPT_REFERENCE',
        `Manuscript Artifact reference label is invalid: ${rawLabel}`
      )
    }
    if (!isRecord(rawBinding)) {
      throw new ManuscriptReferenceError(
        'INVALID_MANUSCRIPT_REFERENCE',
        `Manuscript Artifact reference ${label} must be a mapping.`
      )
    }

    const artifactId = requiredString(rawBinding['artifact-id'], `${label}.artifact-id`, 512)
    const versionId = requiredString(rawBinding['version-id'], `${label}.version-id`, 512)
    const checksum = requiredString(rawBinding.checksum, `${label}.checksum`, 64).toLowerCase()
    if (!SHA256.test(checksum)) {
      throw new ManuscriptReferenceError(
        'INVALID_MANUSCRIPT_REFERENCE',
        `Manuscript Artifact reference ${label}.checksum must be a raw SHA-256 hex digest.`
      )
    }
    bindings.set(label, {
      label,
      artifactId,
      versionId,
      checksum
    })
  }
  return bindings
}

const referencedLabels = (body: string): string[] => {
  const labels: string[] = []
  const seen = new Set<string>()
  FIGURE_REFERENCE.lastIndex = 0
  for (const match of body.matchAll(FIGURE_REFERENCE)) {
    const label = match[1]
    if (!label || seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels
}

const insertCaptionIdentity = (
  body: string,
  references: readonly ResolvedManuscriptReference[]
): string => {
  let result = body
  for (const reference of references) {
    const escapedLabel = reference.label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const image = new RegExp(
      `(!\\[[^\\]]*\\])(\\([^\\n)]*\\))(\\{[^}\\n]*#${escapedLabel}(?:\\s|\\}))`,
      'u'
    )
    result = result.replace(image, (match, alt: string, target: string, attributes: string) => {
      if (alt.includes(`Artifact version ${reference.versionId}`)) return match
      return `${alt} — Artifact version ${reference.versionId} (${reference.artifactId}, SHA-256 ${reference.checksum})${target}${attributes}`
    })
  }
  return result
}

const provenanceSupplement = (references: readonly ResolvedManuscriptReference[]): string => {
  if (references.length === 0) return ''
  return [
    '',
    '## Artifact provenance',
    '',
    '| Figure | Artifact | Version | SHA-256 |',
    '| --- | --- | --- | --- |',
    ...references.map(
      (reference) =>
        `| @${reference.label} | ${reference.artifactId} | ${reference.versionId} | ${reference.checksum} |`
    ),
    ''
  ].join('\n')
}

const renderQmd = (
  frontMatter: FrontMatter,
  body: string,
  bibliography?: ManuscriptBibliography
): string => {
  if (!frontMatter.present) return body
  const value = { ...frontMatter.value }
  delete value['open-science']
  if (bibliography) {
    const existing = value.bibliography
    value.bibliography = Array.isArray(existing)
      ? [bibliography.filename, ...existing]
      : existing === undefined
        ? bibliography.filename
        : [bibliography.filename, existing]
  }
  const serialized = dump(value, { lineWidth: -1, noRefs: true }).trimEnd()
  return `---\n${serialized}\n---\n${body}`
}

const parseBibliographyItemIds = (frontMatter: FrontMatter): string[] => {
  const openScience = frontMatter.value['open-science']
  if (!isRecord(openScience)) return []
  const bibliography = openScience.bibliography
  if (bibliography === undefined) return []
  if (!isRecord(bibliography)) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      'Manuscript front matter open-science.bibliography must be a mapping.'
    )
  }
  const rawItemIds = bibliography['item-ids']
  if (rawItemIds === undefined) return []
  if (!Array.isArray(rawItemIds) || rawItemIds.length === 0 || rawItemIds.length > 1_000) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      'Manuscript bibliography item-ids must be a non-empty array of at most 1000 item ids.'
    )
  }
  const itemIds: string[] = []
  const seen = new Set<string>()
  for (const value of rawItemIds) {
    const itemId = requiredString(value, 'bibliography.item-ids', 512)
    if (seen.has(itemId)) continue
    seen.add(itemId)
    itemIds.push(itemId)
  }
  return itemIds
}

const prepareBibliography = async (
  frontMatter: FrontMatter,
  exportBibtex: ResolveManuscriptReferencesRequest['exportBibtex']
): Promise<ManuscriptBibliography | undefined> => {
  const itemIds = parseBibliographyItemIds(frontMatter)
  if (itemIds.length === 0) return undefined
  if (!exportBibtex) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      'Manuscript bibliography export is unavailable.'
    )
  }
  const exported = await exportBibtex(itemIds)
  if (
    !isRecord(exported) ||
    typeof exported.content !== 'string' ||
    !exported.content.trim() ||
    !Array.isArray(exported.citationKeys)
  ) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      'Manuscript bibliography export returned no records.'
    )
  }

  const citationKeysByItemId = new Map<string, string>()
  for (const rawCitationKey of exported.citationKeys) {
    if (!isRecord(rawCitationKey)) {
      throw new ManuscriptReferenceError(
        'INVALID_MANUSCRIPT_REFERENCE',
        'Manuscript bibliography citation keys must be mappings.'
      )
    }
    const itemId = requiredString(rawCitationKey.itemId, 'bibliography.citation-keys.item-id', 512)
    const citationKey = requiredString(
      rawCitationKey.citationKey,
      'bibliography.citation-keys.citation-key',
      128
    )
    if (!CITATION_KEY.test(citationKey) || !itemIds.includes(itemId)) {
      throw new ManuscriptReferenceError(
        'INVALID_MANUSCRIPT_REFERENCE',
        'Manuscript bibliography citation keys are invalid.'
      )
    }
    if (citationKeysByItemId.has(itemId)) {
      throw new ManuscriptReferenceError(
        'INVALID_MANUSCRIPT_REFERENCE',
        `Manuscript bibliography item ${itemId} has duplicate citation keys.`
      )
    }
    citationKeysByItemId.set(itemId, citationKey)
  }
  if (itemIds.some((itemId) => !citationKeysByItemId.has(itemId))) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      'Manuscript bibliography export is missing citation keys.'
    )
  }
  const citationKeys: ManuscriptCitationKey[] = itemIds.map((itemId) => ({
    itemId,
    citationKey: citationKeysByItemId.get(itemId)!
  }))
  if (new Set(citationKeys.map(({ citationKey }) => citationKey)).size !== citationKeys.length) {
    throw new ManuscriptReferenceError(
      'INVALID_MANUSCRIPT_REFERENCE',
      'Manuscript bibliography contains duplicate citation keys.'
    )
  }

  return { filename: 'references.bib', content: exported.content, itemIds, citationKeys }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const rewriteCitationKeys = (body: string, bibliography?: ManuscriptBibliography): string => {
  if (!bibliography) return body
  let rewritten = body
  for (const { itemId, citationKey } of bibliography.citationKeys) {
    if (itemId === citationKey) continue
    const citation = new RegExp(
      `(?<![\\w@])@${escapeRegExp(itemId)}(?=\\s*(?:[,.;:!?)\\]}]|$))`,
      'gu'
    )
    rewritten = rewritten.replace(citation, `@${citationKey}`)
  }
  return rewritten
}

const resolveVersionDescriptorsInPages = async (
  resolveVersionDescriptors: ResolveManuscriptReferencesRequest['resolveVersionDescriptors'],
  request: { projectId: string; appSessionId: string; versionIds: string[] }
): Promise<ArtifactVersionDescriptor[]> => {
  const descriptors: ArtifactVersionDescriptor[] = []
  for (
    let index = 0;
    index < request.versionIds.length;
    index += MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS
  ) {
    descriptors.push(
      ...(await resolveVersionDescriptors({
        ...request,
        versionIds: request.versionIds.slice(index, index + MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS)
      }))
    )
  }
  return descriptors
}

const resolveManuscriptReferences = async ({
  projectId,
  appSessionId,
  content,
  resolveVersionDescriptors,
  exportBibtex
}: ResolveManuscriptReferencesRequest): Promise<PrepareManuscriptResult> => {
  const frontMatter = parseFrontMatter(content)
  const bindings = parseBindings(frontMatter)
  const bibliography = await prepareBibliography(frontMatter, exportBibtex)
  const labels = referencedLabels(frontMatter.body)

  for (const label of labels) {
    if (!bindings.has(label)) {
      throw new ManuscriptReferenceError(
        'UNKNOWN_ARTIFACT_REFERENCE',
        `Figure @${label} has no immutable Artifact Version binding.`
      )
    }
  }

  const unresolved = labels.map((label) => bindings.get(label)!)
  if (unresolved.length === 0) {
    const preparedBody = frontMatter.body
    return {
      markdown: preparedBody,
      qmd: renderQmd(frontMatter, rewriteCitationKeys(preparedBody, bibliography), bibliography),
      references: [],
      ...(bibliography ? { bibliography } : {})
    }
  }

  const descriptors = await resolveVersionDescriptorsInPages(resolveVersionDescriptors, {
    projectId,
    appSessionId,
    versionIds: [...new Set(unresolved.map((reference) => reference.versionId))]
  })
  const descriptorById = new Map(
    descriptors.map((descriptor) => [descriptor.versionId, descriptor])
  )
  const references: ResolvedManuscriptReference[] = []

  for (const binding of unresolved) {
    const descriptor = descriptorById.get(binding.versionId)
    if (!descriptor || descriptor.state !== 'finalized') {
      throw new ManuscriptReferenceError(
        'UNKNOWN_ARTIFACT_VERSION',
        `Artifact Version ${binding.versionId} for @${binding.label} is unavailable.`
      )
    }
    if (
      descriptor.artifactId !== binding.artifactId ||
      descriptor.versionId !== binding.versionId ||
      descriptor.checksum !== binding.checksum
    ) {
      throw new ManuscriptReferenceError(
        'STALE_ARTIFACT_VERSION',
        `Artifact Version ${binding.versionId} for @${binding.label} no longer matches its immutable identity.`
      )
    }
    references.push(binding)
  }

  const withCaptions = insertCaptionIdentity(frontMatter.body, references)
  const preparedBody = `${withCaptions.trimEnd()}${provenanceSupplement(references)}`
  return {
    markdown: preparedBody,
    qmd: renderQmd(frontMatter, rewriteCitationKeys(preparedBody, bibliography), bibliography),
    references,
    ...(bibliography ? { bibliography } : {})
  }
}

export { ManuscriptReferenceError, resolveManuscriptReferences }
export type { ResolveManuscriptReferencesRequest }

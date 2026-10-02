import {
  DepositProviderError,
  fetchWithTimeout,
  performMutation,
  responseJson,
  type ArtifactDepositLineage,
  type ArtifactDepositPreview,
  type ArtifactDepositPreviewDraft,
  type ArtifactDepositSource,
  type DepositEnvironment,
  type DepositProvider,
  type ProviderPublishedDeposit
} from './deposit-provider'

type JsonObject = Record<string, unknown>

const SANDBOX_BASE = 'https://sandbox.zenodo.org/api'
const PRODUCTION_BASE = 'https://zenodo.org/api'
const DEFAULT_TIMEOUT_MS = 30_000

const object = (value: unknown, context: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DepositProviderError(`${context} returned an invalid object`)
  }
  return value as JsonObject
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const positiveId = (value: unknown, context: string): string => {
  const candidate = typeof value === 'number' ? String(value) : text(value)
  if (!candidate || !/^[1-9]\d*$/u.test(candidate)) {
    throw new DepositProviderError(`${context} returned an invalid record ID`)
  }
  return candidate
}

const normalizeOrcid = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const bare = value.replace(/^https?:\/\/orcid\.org\//iu, '').trim()
  if (!/^\d{4}-\d{4}-\d{4}-[\dX]{4}$/u.test(bare)) {
    throw new DepositProviderError(`Invalid ORCID: ${value}`)
  }
  return bare
}

const creatorName = (name: string): string => {
  const parts = name.trim().split(/\s+/u)
  if (parts.length < 2) return name.trim()
  return `${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}`
}

export const toZenodoMetadata = (source: ArtifactDepositSource): JsonObject => {
  if (!source.contributors.length) {
    throw new DepositProviderError('Zenodo deposit requires at least one contributor.')
  }
  const licenseId = source.license?.id ?? source.license?.name
  if (!licenseId) {
    throw new DepositProviderError('Zenodo deposit requires a license identifier or name.')
  }
  return {
    title: source.session.title.trim(),
    description: source.session.description.trim(),
    upload_type: 'dataset',
    publication_date: source.artifact.createdAt.slice(0, 10),
    version: `v${source.artifact.versionNumber}`,
    access_right: 'open',
    creators: source.contributors.map((contributor) => ({
      name: creatorName(contributor.name),
      ...(normalizeOrcid(contributor.orcid) ? { orcid: normalizeOrcid(contributor.orcid) } : {}),
      ...(contributor.affiliations?.length
        ? { affiliation: contributor.affiliations.join('; ') }
        : {})
    })),
    related_identifiers: source.relatedIdentifiers.map((related) => ({
      identifier: related.identifier,
      relation: related.relation,
      ...(related.resourceType ? { resource_type: related.resourceType } : {})
    })),
    license: { id: licenseId },
    notes: `Open Science artifact version ${source.artifact.versionId}; crate sha256:${source.crate.checksum}`
  }
}

const endpointBase = (environment: DepositEnvironment): string =>
  environment === 'sandbox' ? SANDBOX_BASE : PRODUCTION_BASE

const previewDraft = (input: {
  source: ArtifactDepositSource
  environment: DepositEnvironment
  lineage?: ArtifactDepositLineage
}): ArtifactDepositPreviewDraft => {
  const base = endpointBase(input.environment)
  const endpoints: ArtifactDepositPreviewDraft['endpoints'] = input.lineage
    ? [
        {
          purpose: 'new-version',
          method: 'POST',
          url: `${base}/deposit/depositions/${input.lineage.providerRecordId}/actions/newversion`,
          urlKind: 'fixed'
        },
        {
          purpose: 'upload-file',
          method: 'PUT',
          url: '<draft.links.bucket>/<url-encoded-filename>',
          urlKind: 'provider-resolved'
        },
        {
          purpose: 'publish',
          method: 'POST',
          url: '<draft.links.publish>',
          urlKind: 'provider-resolved'
        }
      ]
    : [
        {
          purpose: 'create-draft',
          method: 'POST',
          url: `${base}/deposit/depositions`,
          urlKind: 'fixed'
        },
        {
          purpose: 'upload-file',
          method: 'PUT',
          url: '<draft.links.bucket>/<url-encoded-filename>',
          urlKind: 'provider-resolved'
        },
        {
          purpose: 'publish',
          method: 'POST',
          url: '<draft.links.publish>',
          urlKind: 'provider-resolved'
        }
      ]
  return {
    schemaVersion: 1,
    provider: 'zenodo',
    environment: input.environment,
    artifact: input.source.artifact,
    metadata: {
      title: input.source.session.title,
      description: input.source.session.description,
      version: `v${input.source.artifact.versionNumber}`,
      contributors: input.source.contributors,
      relatedIdentifiers: input.source.relatedIdentifiers,
      ...(input.source.license ? { license: input.source.license } : {})
    },
    providerMetadata: toZenodoMetadata(input.source),
    files: [
      {
        filename: input.source.crate.filename,
        sizeBytes: input.source.crate.sizeBytes,
        checksum: input.source.crate.checksum,
        contentType: 'application/zip'
      }
    ],
    endpoints,
    warnings: [
      'Zenodo resolves the file bucket and publish URLs from the created draft. Those provider-resolved endpoints are shown exactly as they will be resolved before the upload and publish mutations.'
    ],
    ...(input.lineage ? { lineage: input.lineage } : {})
  }
}

const depositDraft = (
  raw: unknown,
  context: string
): {
  id: string
  conceptRecordId?: string
  bucket: string
  publish: string
  latestDraft?: string
  conceptDoi?: string
} => {
  const record = object(raw, context)
  const links = object(record.links, `${context} links`)
  const id = positiveId(record.id, context)
  const bucket = text(links.bucket)
  const publish = text(links.publish)
  const latestDraft = text(links.latest_draft)
  const conceptRecordId =
    record.conceptrecid == null ? undefined : positiveId(record.conceptrecid, context)
  return {
    id,
    ...(conceptRecordId ? { conceptRecordId } : {}),
    ...(bucket ? { bucket } : {}),
    ...(publish ? { publish } : {}),
    ...(latestDraft ? { latestDraft } : {}),
    ...(text(record.conceptdoi) ? { conceptDoi: text(record.conceptdoi) } : {})
  } as {
    id: string
    conceptRecordId?: string
    bucket: string
    publish: string
    latestDraft?: string
    conceptDoi?: string
  }
}

export const parseZenodoDeposit = (raw: unknown): ProviderPublishedDeposit => {
  const record = object(raw, 'Zenodo deposit')
  const metadata = record.metadata == null ? undefined : object(record.metadata, 'Zenodo metadata')
  const versionDoi = text(record.doi) ?? (metadata ? text(metadata.doi) : undefined)
  const conceptDoi = text(record.conceptdoi) ?? (metadata ? text(metadata.conceptdoi) : undefined)
  if (!versionDoi) throw new DepositProviderError('Zenodo response did not include a version DOI')
  if (!conceptDoi) throw new DepositProviderError('Zenodo response did not include a concept DOI')
  const links = record.links == null ? undefined : object(record.links, 'Zenodo links')
  return {
    providerRecordId: positiveId(record.id, 'Zenodo deposit'),
    ...(record.conceptrecid == null
      ? {}
      : { providerConceptRecordId: positiveId(record.conceptrecid, 'Zenodo deposit') }),
    conceptDoi,
    versionDoi,
    ...(links && text(links.record_html) ? { landingUrl: text(links.record_html)! } : {})
  }
}

const authHeaders = (token: string, contentType: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/json',
  'content-type': contentType
})

const jsonRequest = async (input: {
  fetchImpl: typeof fetch
  url: string
  method: 'GET' | 'POST'
  token: string
  body?: unknown
  timeoutMs: number
  signal?: AbortSignal
  context: string
}): Promise<unknown> => {
  const response = await fetchWithTimeout(
    input.fetchImpl,
    input.url,
    {
      method: input.method,
      headers: authHeaders(input.token, 'application/json'),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
    },
    input.timeoutMs,
    input.signal
  )
  return responseJson(response, input.token, input.context)
}

const createDraft = async (input: {
  fetchImpl: typeof fetch
  base: string
  token: string
  preview: ArtifactDepositPreview
  timeoutMs: number
  signal?: AbortSignal
}): Promise<unknown> =>
  jsonRequest({
    ...input,
    url: `${input.base}/deposit/depositions`,
    method: 'POST',
    body: { metadata: input.preview.providerMetadata, prereserve_doi: true },
    context: 'Zenodo draft creation'
  })

const latestDraftUrl = async (input: {
  fetchImpl: typeof fetch
  raw: unknown
  token: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<{ url: string; raw: unknown }> => {
  const created = depositDraft(input.raw, 'Zenodo new-version response')
  if (!created.latestDraft) {
    throw new DepositProviderError('Zenodo new-version response did not include links.latest_draft')
  }
  const raw = await jsonRequest({
    fetchImpl: input.fetchImpl,
    url: created.latestDraft,
    method: 'GET',
    token: input.token,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    context: 'Zenodo latest draft lookup'
  })
  return { url: created.latestDraft, raw }
}

export const createZenodoDepositProvider = (
  options: {
    fetchImpl?: typeof fetch
    requestTimeoutMs?: number
    sandboxBaseUrl?: string
    productionBaseUrl?: string
  } = {}
): DepositProvider & { id: 'zenodo' } => {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const bases: Record<DepositEnvironment, string> = {
    sandbox: options.sandboxBaseUrl ?? SANDBOX_BASE,
    production: options.productionBaseUrl ?? PRODUCTION_BASE
  }
  return {
    id: 'zenodo',
    preview: (input) => previewDraft(input),
    execute: async (input) => {
      const { preview, source, token, signal } = input
      const base = bases[preview.environment]
      const previewChecksum = preview.previewChecksum
      const reconciliationBase = {
        provider: 'zenodo' as const,
        environment: preview.environment,
        previewChecksum
      }
      const draft = await performMutation(
        { ...reconciliationBase, operation: 'create-draft' },
        async () => {
          const draftRaw = preview.lineage
            ? await latestDraftUrl({
                fetchImpl,
                raw: await jsonRequest({
                  fetchImpl,
                  url: `${base}/deposit/depositions/${preview.lineage.providerRecordId}/actions/newversion`,
                  method: 'POST',
                  token,
                  timeoutMs,
                  signal,
                  context: 'Zenodo new-version creation'
                }),
                token,
                timeoutMs,
                signal
              })
            : {
                url: `${base}/deposit/depositions`,
                raw: await createDraft({
                  fetchImpl,
                  base,
                  token,
                  preview,
                  timeoutMs,
                  signal
                })
              }
          const draft = depositDraft(draftRaw.raw, 'Zenodo draft')
          if (!draft.bucket || !draft.publish) {
            throw new DepositProviderError('Zenodo draft did not include upload and publish links')
          }
          if (
            preview.lineage?.conceptDoi &&
            draft.conceptDoi &&
            draft.conceptDoi !== preview.lineage.conceptDoi
          ) {
            throw new DepositProviderError(
              'Zenodo draft concept DOI does not match the artifact lineage'
            )
          }
          return draft
        }
      )

      await performMutation(
        {
          ...reconciliationBase,
          operation: 'upload-file',
          providerRecordId: draft.id
        },
        async () => {
          const response = await fetchWithTimeout(
            fetchImpl,
            `${draft.bucket}/${encodeURIComponent(preview.files[0].filename)}`,
            {
              method: 'PUT',
              headers: authHeaders(token, preview.files[0].contentType),
              body: source.crate.bytes as BodyInit
            },
            timeoutMs,
            signal
          )
          await responseJson(response, token, 'Zenodo file upload')
        }
      )

      return performMutation(
        {
          ...reconciliationBase,
          operation: 'publish',
          providerRecordId: draft.id
        },
        async () => {
          const published = await jsonRequest({
            fetchImpl,
            url: draft.publish,
            method: 'POST',
            token,
            timeoutMs,
            signal,
            context: 'Zenodo publish'
          })
          const result = parseZenodoDeposit(published)
          if (preview.lineage?.conceptDoi && result.conceptDoi !== preview.lineage.conceptDoi) {
            throw new DepositProviderError('Zenodo publication changed the artifact concept DOI')
          }
          return result
        }
      )
    },
    reconcile: async (input) => {
      const { preview, outcome, token, signal } = input
      const base = bases[preview.environment]
      const query = outcome.providerRecordId
        ? `${base}/deposit/depositions/${outcome.providerRecordId}`
        : `${base}/deposit/depositions?q=${encodeURIComponent(
            `"crate sha256:${preview.files[0].checksum}"`
          )}&size=10`
      const raw = await jsonRequest({
        fetchImpl,
        url: query,
        method: 'GET',
        token,
        timeoutMs,
        signal,
        context: 'Zenodo reconciliation'
      })
      const candidates = (() => {
        if (Array.isArray(raw)) return raw
        const root = object(raw, 'Zenodo reconciliation')
        if (root.id != null) return [root]
        const hits = root.hits == null ? undefined : object(root.hits, 'Zenodo reconciliation hits')
        return hits && Array.isArray(hits.hits) ? hits.hits : []
      })()
      for (const candidate of candidates) {
        const record = object(candidate, 'Zenodo record')
        const metadata = object(record.metadata, 'Zenodo record metadata')
        if (
          text(metadata.notes) !==
          `Open Science artifact version ${preview.artifact.versionId}; crate sha256:${preview.files[0].checksum}`
        ) {
          continue
        }
        const files = Array.isArray(record.files) ? record.files : []
        const fileMatches = files.some((file) => {
          const fileObject = object(file, 'Zenodo file')
          return (
            text(fileObject.key) === preview.files[0].filename &&
            Number(fileObject.size) === preview.files[0].sizeBytes
          )
        })
        if (!fileMatches) continue
        try {
          const publication = parseZenodoDeposit(record)
          if (preview.lineage && publication.conceptDoi !== preview.lineage.conceptDoi) {
            return {
              state: 'pending',
              detail: 'Matching Zenodo record has a different concept DOI.'
            }
          }
          return { state: 'published', publication }
        } catch {
          return { state: 'pending', detail: 'Matching Zenodo record has no published DOI yet.' }
        }
      }
      return {
        state: 'pending',
        detail: 'No matching published Zenodo record is visible yet.'
      }
    }
  }
}

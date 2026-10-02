import {
  DepositProviderError,
  fetchWithTimeout,
  performMutation,
  responseJson,
  type ArtifactDepositPreviewDraft,
  type ArtifactDepositSource,
  type DepositEnvironment,
  type DepositProvider,
  type ProviderPublishedDeposit
} from './deposit-provider'

type JsonObject = Record<string, unknown>

const SANDBOX_BASE = 'https://api.test.osf.io/v2'
const PRODUCTION_BASE = 'https://api.osf.io/v2'
const DEFAULT_TIMEOUT_MS = 30_000

const object = (value: unknown, context: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DepositProviderError(`${context} returned an invalid object`)
  }
  return value as JsonObject
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const base = (environment: DepositEnvironment): string =>
  environment === 'sandbox' ? SANDBOX_BASE : PRODUCTION_BASE

const relatedDescription = (source: ArtifactDepositSource): string => {
  if (!source.relatedIdentifiers.length) return source.session.description
  return [
    source.session.description,
    '',
    'Related identifiers:',
    ...source.relatedIdentifiers.map((related) => `- ${related.identifier} (${related.relation})`)
  ].join('\n')
}

export const toOsfRegistration = (source: ArtifactDepositSource): JsonObject => {
  if (!source.contributors.length) {
    throw new DepositProviderError('OSF deposit requires at least one contributor.')
  }
  const description = relatedDescription(source)
  const license = source.license?.id ?? source.license?.name
  return {
    title: source.session.title,
    description,
    ...(license ? { license } : {}),
    registration_responses: {
      title: source.session.title,
      description,
      ...(license ? { license } : {})
    },
    contributors: source.contributors.map((contributor) => ({
      name: contributor.name,
      ...(contributor.orcid ? { orcid: contributor.orcid } : {}),
      ...(contributor.affiliations?.length ? { affiliations: contributor.affiliations } : {})
    }))
  }
}

const previewDraft = (input: {
  source: ArtifactDepositSource
  environment: DepositEnvironment
}): ArtifactDepositPreviewDraft => {
  const api = base(input.environment)
  return {
    schemaVersion: 1,
    provider: 'osf',
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
    providerMetadata: toOsfRegistration(input.source),
    files: [
      {
        filename: input.source.crate.filename,
        sizeBytes: input.source.crate.sizeBytes,
        checksum: input.source.crate.checksum,
        contentType: 'application/zip'
      }
    ],
    endpoints: [
      {
        purpose: 'create-project',
        method: 'POST',
        url: `${api}/nodes/`,
        urlKind: 'fixed'
      },
      {
        purpose: 'upload-file',
        method: 'POST',
        url: '<project.links.files>/osfstorage/',
        urlKind: 'provider-resolved'
      },
      {
        purpose: 'create-registration',
        method: 'POST',
        url: '<project.links.registrations>',
        urlKind: 'provider-resolved'
      }
    ],
    warnings: [
      'OSF resolves file and registration URLs from the created project. The exact resolved URLs are shown before upload and registration.'
    ]
  }
}

const headers = (token: string, contentType: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.api+json',
  'content-type': contentType
})

const jsonRequest = async (input: {
  fetchImpl: typeof fetch
  url: string
  method: 'GET' | 'POST' | 'PUT'
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
      headers: headers(input.token, 'application/vnd.api+json'),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
    },
    input.timeoutMs,
    input.signal
  )
  return responseJson(response, input.token, input.context)
}

const dataObject = (raw: unknown, context: string): JsonObject => {
  const envelope = object(raw, context)
  return object(envelope.data, `${context} data`)
}

const links = (raw: unknown, context: string): JsonObject => {
  const record = object(raw, context)
  return object(record.links, `${context} links`)
}

const registrationTitle = (record: JsonObject): string | undefined => {
  const attributes =
    record.attributes == null ? undefined : object(record.attributes, 'OSF registration attributes')
  const responses =
    attributes?.registration_responses == null
      ? undefined
      : object(attributes.registration_responses, 'OSF registration responses')
  return (
    (attributes ? text(attributes.title) : undefined) ??
    (responses ? text(responses.title) : undefined)
  )
}

export const parseOsfDeposit = (raw: unknown): ProviderPublishedDeposit => {
  const record = dataObject(raw, 'OSF registration')
  const attributes =
    record.attributes == null ? undefined : object(record.attributes, 'OSF registration attributes')
  const linkObject =
    record.links == null ? undefined : object(record.links, 'OSF registration links')
  const doi =
    (attributes ? text(attributes.doi) : undefined) ??
    (linkObject ? text(linkObject.doi) : undefined)
  if (!doi) throw new DepositProviderError('OSF registration response did not include a DOI')
  const id = text(record.id)
  if (!id) throw new DepositProviderError('OSF registration response did not include an ID')
  return {
    providerRecordId: id,
    conceptDoi: doi,
    versionDoi: doi,
    ...(linkObject && text(linkObject.html) ? { landingUrl: text(linkObject.html)! } : {})
  }
}

export const createOsfDepositProvider = (
  options: {
    fetchImpl?: typeof fetch
    requestTimeoutMs?: number
    sandboxBaseUrl?: string
    productionBaseUrl?: string
  } = {}
): DepositProvider & { id: 'osf' } => {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const bases: Record<DepositEnvironment, string> = {
    sandbox: options.sandboxBaseUrl ?? SANDBOX_BASE,
    production: options.productionBaseUrl ?? PRODUCTION_BASE
  }
  return {
    id: 'osf',
    preview: (input) => previewDraft(input),
    execute: async (input) => {
      const { preview, source, token, signal } = input
      const api = bases[preview.environment]
      const registration = preview.providerMetadata
      const project = await performMutation(
        {
          provider: 'osf',
          environment: preview.environment,
          operation: 'create-project',
          previewChecksum: preview.previewChecksum
        },
        async () => {
          const project = dataObject(
            await jsonRequest({
              fetchImpl,
              url: `${api}/nodes/`,
              method: 'POST',
              token,
              timeoutMs,
              signal,
              context: 'OSF project creation',
              body: {
                data: {
                  type: 'nodes',
                  attributes: {
                    title: preview.metadata.title,
                    description: relatedDescription(source),
                    category: 'project',
                    public: false
                  }
                }
              }
            }),
            'OSF project'
          )
          const projectId = text(project.id)
          const projectLinks =
            project.links == null ? undefined : object(project.links, 'OSF project links')
          const filesUrl = projectLinks ? text(projectLinks.files) : undefined
          const registrationsUrl = projectLinks ? text(projectLinks.registrations) : undefined
          if (!projectId || !filesUrl || !registrationsUrl) {
            throw new DepositProviderError(
              'OSF project response did not include file and registration links'
            )
          }
          return { projectId, filesUrl, registrationsUrl }
        }
      )
      const { projectId, filesUrl, registrationsUrl } = project

      const file = await performMutation(
        {
          provider: 'osf',
          environment: preview.environment,
          operation: 'upload-file',
          previewChecksum: preview.previewChecksum,
          providerRecordId: projectId
        },
        async () => {
          const fileRaw = await jsonRequest({
            fetchImpl,
            url: `${filesUrl.replace(/\/$/u, '')}/osfstorage/`,
            method: 'POST',
            token,
            timeoutMs,
            signal,
            context: 'OSF file registration',
            body: {
              data: {
                type: 'files',
                attributes: { name: preview.files[0].filename, kind: 'file' }
              }
            }
          })
          const uploadUrl = text(links(dataObject(fileRaw, 'OSF file'), 'OSF file').upload)
          if (!uploadUrl) {
            throw new DepositProviderError('OSF file response did not include an upload URL')
          }
          return uploadUrl
        }
      )
      await performMutation(
        {
          provider: 'osf',
          environment: preview.environment,
          operation: 'upload-file',
          previewChecksum: preview.previewChecksum,
          providerRecordId: projectId
        },
        async () => {
          const response = await fetchWithTimeout(
            fetchImpl,
            file,
            {
              method: 'PUT',
              headers: headers(token, preview.files[0].contentType),
              body: source.crate.bytes as BodyInit
            },
            timeoutMs,
            signal
          )
          await responseJson(response, token, 'OSF file upload')
        }
      )

      return performMutation(
        {
          provider: 'osf',
          environment: preview.environment,
          operation: 'create-registration',
          previewChecksum: preview.previewChecksum,
          providerRecordId: projectId
        },
        async () => {
          const registrationResult = parseOsfDeposit(
            await jsonRequest({
              fetchImpl,
              url: registrationsUrl,
              method: 'POST',
              token,
              timeoutMs,
              signal,
              context: 'OSF registration creation',
              body: {
                data: {
                  type: 'registrations',
                  attributes: {
                    registration_choice: 'immediate',
                    ...registration
                  }
                }
              }
            })
          )
          return { ...registrationResult, providerConceptRecordId: projectId }
        }
      )
    },
    reconcile: async ({ preview, outcome, token, signal }) => {
      if (outcome.operation !== 'create-registration' || !outcome.providerRecordId) {
        return { state: 'not-found' as const }
      }
      const raw = await jsonRequest({
        fetchImpl,
        url: `${bases[outcome.environment]}/nodes/${encodeURIComponent(outcome.providerRecordId)}/registrations/`,
        method: 'GET',
        token,
        timeoutMs,
        signal,
        context: 'OSF registration reconciliation'
      })
      const envelope = object(raw, 'OSF registration list')
      const candidates = Array.isArray(envelope.data) ? envelope.data : []
      if (!candidates.length) {
        return {
          state: 'pending',
          detail: 'OSF has not exposed a registration for the project yet.'
        }
      }
      for (const candidate of candidates) {
        const record = object(candidate, 'OSF registration')
        if (registrationTitle(record) !== preview.metadata.title) continue
        try {
          return { state: 'published', publication: parseOsfDeposit({ data: record }) }
        } catch {
          // A matching registration can exist before OSF makes its DOI available.
        }
      }
      return { state: 'pending', detail: 'OSF registration is not published yet.' }
    }
  }
}

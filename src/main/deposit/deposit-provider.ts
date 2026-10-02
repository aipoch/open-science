import { createHash } from 'node:crypto'

import { redactSensitiveText } from '../diagnostic-redaction'

export type DepositProviderId = 'zenodo' | 'osf'
export type DepositEnvironment = 'sandbox' | 'production'
export type DepositOperation =
  'create-draft' | 'upload-file' | 'publish' | 'create-project' | 'create-registration'

export type ArtifactDepositReference = {
  projectId: string
  sessionId: string
  artifactId: string
  versionId: string
}

export type ArtifactDepositContributor = {
  name: string
  orcid?: string
  affiliations?: string[]
}

export type ArtifactDepositRelatedIdentifier = {
  identifier: string
  relation: string
  resourceType?: string
}

export type ArtifactDepositLicense = {
  id?: string
  name?: string
  url?: string
}

export type ArtifactDepositSource = {
  artifact: ArtifactDepositReference & {
    versionNumber: number
    filename: string
    checksum: string
    sizeBytes: number
    contentType?: string
    createdAt: string
  }
  session: {
    title: string
    description: string
  }
  contributors: ArtifactDepositContributor[]
  license?: ArtifactDepositLicense
  relatedIdentifiers: ArtifactDepositRelatedIdentifier[]
  crate: {
    filename: string
    checksum: string
    sizeBytes: number
    bytes: Uint8Array
  }
}

export type ArtifactDepositFile = {
  filename: string
  sizeBytes: number
  checksum: string
  contentType: 'application/zip'
}

export type ArtifactDepositEndpoint = {
  purpose:
    | 'create-draft'
    | 'new-version'
    | 'upload-file'
    | 'publish'
    | 'create-project'
    | 'create-registration'
  method: 'GET' | 'POST' | 'PUT'
  url: string
  urlKind: 'fixed' | 'provider-resolved'
}

export type ArtifactDepositLineage = {
  providerRecordId: string
  providerConceptRecordId?: string
  conceptDoi: string
}

export type ArtifactDepositMetadata = {
  title: string
  description: string
  version: string
  contributors: ArtifactDepositContributor[]
  relatedIdentifiers: ArtifactDepositRelatedIdentifier[]
  license?: ArtifactDepositLicense
}

export type ArtifactDepositPreviewDraft = {
  schemaVersion: 1
  provider: DepositProviderId
  environment: DepositEnvironment
  artifact: ArtifactDepositSource['artifact']
  metadata: ArtifactDepositMetadata
  providerMetadata: Record<string, unknown>
  files: [ArtifactDepositFile]
  endpoints: ArtifactDepositEndpoint[]
  warnings: string[]
  lineage?: ArtifactDepositLineage
}

export type ArtifactDepositPreview = ArtifactDepositPreviewDraft & {
  previewChecksum: string
}

export type DepositApprovalDecision =
  | { outcome: 'approved'; previewChecksum: string }
  | { outcome: 'cancelled' | 'rejected'; reason?: string }

export type ProviderPublishedDeposit = {
  providerRecordId: string
  providerConceptRecordId?: string
  conceptDoi: string
  versionDoi: string
  landingUrl?: string
}

export type ArtifactPublication = {
  schemaVersion: 1
  status: 'published'
  provider: DepositProviderId
  environment: DepositEnvironment
  artifact: ArtifactDepositSource['artifact']
  crate: ArtifactDepositFile
  providerRecordId: string
  providerConceptRecordId?: string
  conceptDoi: string
  versionDoi: string
  landingUrl?: string
  depositedAt: string
}

export type DepositReconciliationRequest = {
  provider: DepositProviderId
  environment: DepositEnvironment
  operation: DepositOperation
  previewChecksum: string
  providerRecordId?: string
}

export type DepositReconciliation =
  | { state: 'published'; publication: ProviderPublishedDeposit }
  | { state: 'pending' | 'not-found'; detail?: string }

export type DepositProvider = {
  id: DepositProviderId
  preview(input: {
    source: ArtifactDepositSource
    environment: DepositEnvironment
    lineage?: ArtifactDepositLineage
  }): ArtifactDepositPreviewDraft
  execute(input: {
    preview: ArtifactDepositPreview
    source: ArtifactDepositSource
    token: string
    signal?: AbortSignal
  }): Promise<ProviderPublishedDeposit>
  reconcile(input: {
    preview: ArtifactDepositPreview
    outcome: DepositReconciliationRequest
    token: string
    signal?: AbortSignal
  }): Promise<DepositReconciliation>
}

export class ArtifactDepositSourceNotFoundError extends Error {
  constructor(readonly reference: ArtifactDepositReference) {
    super(
      `Artifact Version ${reference.versionId} was not found in project ${reference.projectId}; deposit was not started.`
    )
    this.name = 'ArtifactDepositSourceNotFoundError'
  }
}

export class DepositApprovalRequiredError extends Error {
  constructor() {
    super('Deposit requires an explicit approval for the exact previewed payload.')
    this.name = 'DepositApprovalRequiredError'
  }
}

export class DepositPreviewStaleError extends Error {
  constructor(detail = 'The artifact version or crate changed after preview.') {
    super(detail)
    this.name = 'DepositPreviewStaleError'
  }
}

export class DepositCredentialMissingError extends Error {
  constructor(provider: DepositProviderId, environment: DepositEnvironment) {
    super(`No ${provider} ${environment} credential is available; deposit was not started.`)
    this.name = 'DepositCredentialMissingError'
  }
}

export class DepositLineageMismatchError extends Error {
  constructor(expectedConceptDoi: string, actualConceptDoi: string) {
    super(
      `Zenodo returned concept DOI ${actualConceptDoi}, expected ${expectedConceptDoi}; publication was not recorded.`
    )
    this.name = 'DepositLineageMismatchError'
  }
}

export class DepositOutcomeUnknownError extends Error {
  constructor(readonly reconciliation: DepositReconciliationRequest) {
    super(
      `Deposit ${reconciliation.operation} outcome is unknown; do not retry. Reconcile provider state first.`
    )
    this.name = 'DepositOutcomeUnknownError'
  }
}

export class DepositProviderError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = 'DepositProviderError'
  }
}

const sortedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortedValue(child)])
  )
}

export const canonicalDepositJson = (value: unknown): string => JSON.stringify(sortedValue(value))

export const depositPreviewChecksum = (preview: ArtifactDepositPreviewDraft): string =>
  createHash('sha256').update(canonicalDepositJson(preview), 'utf8').digest('hex')

export const completeDepositPreview = (
  preview: ArtifactDepositPreviewDraft
): ArtifactDepositPreview => ({
  ...preview,
  previewChecksum: depositPreviewChecksum(preview)
})

export const depositPreviewWithoutChecksum = (
  preview: ArtifactDepositPreview
): ArtifactDepositPreviewDraft => {
  const draft: ArtifactDepositPreviewDraft &
    Partial<Pick<ArtifactDepositPreview, 'previewChecksum'>> = { ...preview }
  delete draft.previewChecksum
  return draft
}

export const redactDepositError = (
  error: unknown,
  token?: string,
  httpStatus?: number
): DepositProviderError => {
  const raw = error instanceof Error ? error.message : String(error)
  const withoutToken = token ? raw.split(token).join('[redacted]') : raw
  return new DepositProviderError(redactSensitiveText(withoutToken), httpStatus)
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')

const isUnknownMutationOutcome = (error: unknown): boolean =>
  isAbortError(error) ||
  (error instanceof TypeError && /fetch|network|socket|connection/i.test(error.message)) ||
  (error instanceof DepositProviderError &&
    (error.httpStatus === undefined || error.httpStatus < 400 || error.httpStatus >= 500))

export const mutationUnknownError = (input: {
  provider: DepositProviderId
  environment: DepositEnvironment
  operation: DepositOperation
  previewChecksum: string
  providerRecordId?: string
}): DepositOutcomeUnknownError => new DepositOutcomeUnknownError(input)

export const performMutation = async <T>(
  reconciliation: Omit<DepositReconciliationRequest, 'providerRecordId'> & {
    providerRecordId?: string
  },
  operation: () => Promise<T>
): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (isUnknownMutationOutcome(error)) {
      const {
        provider,
        environment,
        operation: operationName,
        previewChecksum,
        providerRecordId
      } = reconciliation
      throw mutationUnknownError({
        provider,
        environment,
        operation: operationName,
        previewChecksum,
        providerRecordId
      })
    }
    throw error
  }
}

export const responseJson = async (
  response: Response,
  token: string | undefined,
  context: string
): Promise<unknown> => {
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw redactDepositError(
      new Error(`${context} failed with HTTP ${response.status}${body ? `: ${body}` : ''}`),
      token,
      response.status
    )
  }
  try {
    return await response.json()
  } catch {
    throw redactDepositError(new Error(`${context} returned invalid JSON`), token, response.status)
  }
}

export const fetchWithTimeout = async (
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> => {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('deposit request timed out')),
    timeoutMs
  )
  const abortFromCaller = (): void => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abortFromCaller()
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      const aborted = new Error(
        reason instanceof Error ? reason.message : 'deposit request aborted',
        { cause: error }
      )
      aborted.name = 'AbortError'
      throw aborted
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

import { usesExtendedSearchProtocol } from '../../shared/web-tools'
import { createHash, randomUUID } from 'node:crypto'
import { redactSensitiveText } from '@aipoch/diagnostics'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { PersistedToolActivity } from '../../shared/session-message-contract'
import {
  packageWebActivityEvidenceSchema,
  packageWebEvidenceSchema,
  packageWebSnapshotSchema,
  type PackageWebActivityEvidence,
  type PackageWebEvidence,
  type PackageWebSnapshot,
  type PackageWebOmission,
  type WebEvidenceComponent,
  type WebPolicyDecision
} from '../../shared/session-package-web'
import {
  fetchInputSchema,
  searchInputSchema,
  parseWebResult,
  type WebResult,
  type WebSearchAttempt
} from '../../shared/web-tools'

const components = ['query_history', 'source_manifest', 'provider_excerpt', 'fetch_body'] as const
export type HostWebDataPolicy = {
  version: string
  components: Record<Exclude<WebEvidenceComponent, 'model_synthesis'>, WebPolicyDecision>
}
export type WebPolicyIdentity = {
  origin: 'provider-search' | 'independent-fetch'
  providerId?: string
  providerAuthMode?: 'anonymous' | 'api_key' | 'platform' | 'managed'
  recordedPolicyVersion?: string
}
export type WebPolicyResolver = (identity: WebPolicyIdentity) => HostWebDataPolicy
// No provider or independently fetched public page has approved redistribution rights by default.
export const UNKNOWN_WEB_SHARING_POLICY: HostWebDataPolicy = Object.freeze({
  version: 'web-sharing-unconfirmed-v1',
  components: Object.freeze({
    query_history: 'unknown',
    source_manifest: 'unknown',
    provider_excerpt: 'unknown',
    fetch_body: 'unknown'
  })
})
export const resolveUnknownWebPolicy: WebPolicyResolver = () => UNKNOWN_WEB_SHARING_POLICY
const EXA_POLICY_VERSION = 'exa-anonymous-reviewed-2026-11-17'

const isReviewedAnonymousExa = (identity: WebPolicyIdentity): boolean =>
  identity.origin === 'provider-search' &&
  identity.providerId === 'exa' &&
  identity.providerAuthMode === 'anonymous' &&
  identity.recordedPolicyVersion === EXA_POLICY_VERSION

/** Only the reviewed anonymous Exa operation and independent fetch grant portable attribution. */
export const resolveReviewedWebPolicy: WebPolicyResolver = (identity) => {
  const exa = isReviewedAnonymousExa(identity)
  if (!exa && identity.origin !== 'independent-fetch') return UNKNOWN_WEB_SHARING_POLICY
  return {
    version: exa ? EXA_POLICY_VERSION : 'independent-fetch-attribution-2026-11-17',
    components: {
      query_history: 'allow',
      source_manifest: 'allow',
      provider_excerpt: 'unknown',
      fetch_body: 'unknown'
    }
  }
}

export type WebSnapshotInput = {
  snapshotId: string
  invocationId: string
  originalUrl?: string
  finalUrl?: string
  fetchedAt: string
  contentType: string
  extractorVersion: string
  extractionMethod: 'main_content' | 'semantic_dom' | 'plain_text'
  extractionQuality: 'normal' | 'degraded'
  title?: string
  text: string
  sha256: string
}
export type WebPackageActivity = PersistedToolActivity & { messageBranchId?: string }
export type PrepareWebEvidenceOptions = {
  resolvePolicy?: WebPolicyResolver
  existingEvidence?: PackageWebEvidence
  loadSnapshot?: (
    snapshotId: string,
    activity: WebPackageActivity
  ) => Promise<WebSnapshotInput | undefined>
}
export type WebEvidenceProjection = {
  session: PersistedChatSession
  webEvidence?: PackageWebEvidence
  omissions: PackageWebOmission[]
  /** Private export plan; never serialize into the package or diagnostics. */
  plan: WebEvidenceProjectionPlan
}
export type WebEvidenceProjectionPlan = {
  packets: ReadonlyMap<string, PackageWebActivityEvidence>
  restrictedText: ReadonlyMap<string, readonly string[]>
  shortContentCopies: ReadonlyMap<string, readonly RegExp[]>
  unidentifiedActivityIds: ReadonlySet<string>
}
export class WebEvidencePolicyError extends Error {
  constructor() {
    super('Web execution evidence is restricted by its sharing policy')
    this.name = 'WebEvidencePolicyError'
  }
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const clone = <T>(value: T): T => structuredClone(value)
const text = (value: string, limit: number): string => redactSensitiveText(value).slice(0, limit)
const safeUrl = (value: string | undefined): string | undefined => {
  if (!value || redactSensitiveText(value) !== value) return undefined
  const schema = packageWebActivityEvidenceSchema.shape.requestUrl
  return schema.safeParse(value).success ? value : undefined
}
const summarize = (omissions: readonly PackageWebOmission[]): PackageWebOmission[] => {
  const result = new Map<string, PackageWebOmission>()
  for (const omission of omissions) {
    const key = `${omission.component}:${omission.reason}`
    const existing = result.get(key)
    result.set(key, {
      ...omission,
      count: Math.min(100000, (existing?.count ?? 0) + omission.count)
    })
  }
  return [...result.values()]
}
const knownActivity = (activity: PersistedToolActivity): boolean =>
  activity.appOwned === true &&
  /^mcp__(?:open_science_web|open-science-web)__web_(?:search|fetch)$/.test(
    activity.providerToolName ?? ''
  )
// Failed requests still contain private copy that may also occur in derived attachments.
const privateRequest = (value: unknown): { query?: string; url?: string } => {
  let input = value
  if (typeof input === 'string' && input.length <= 16000) {
    try {
      input = JSON.parse(input)
    } catch {
      return {}
    }
  }
  if (!record(input)) return {}
  const query = searchInputSchema.safeParse({ query: input.query })
  const url = fetchInputSchema.safeParse({ url: input.url })
  return {
    ...(query.success ? { query: query.data.query } : {}),
    ...(url.success && url.data.url ? { url: url.data.url } : {})
  }
}
const projectWebDetails = <T extends PersistedToolActivity>(
  activity: T,
  packet?: PackageWebActivityEvidence
): T => {
  const next = clone(activity)
  delete next.rawInput
  delete next.rawOutput
  delete next.toolContent
  delete next.terminalOutput
  delete next.toolLocations
  if (packet) next.packageWebEvidence = clone(packet)
  else delete next.packageWebEvidence
  if (next.webInvocation) {
    delete next.webInvocation.retryEligible
    delete next.webInvocation.searchDispatches
    delete next.webInvocation.searchAttempts
  }
  return next
}
const findResult = (value: unknown, depth = 0): WebResult | undefined => {
  if (depth > 20) return undefined
  const parsed = parseWebResult(value)
  if (parsed) return parsed
  if (typeof value === 'string' && value.length <= 128 * 1024 && /^[\s]*[[{]/.test(value)) {
    try {
      return findResult(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }
  const children = Array.isArray(value) ? value : record(value) ? Object.values(value) : []
  for (const item of children) {
    const found = findResult(item, depth + 1)
    if (found) return found
  }
  return undefined
}
const policyIdentity = (value: WebResult | PackageWebActivityEvidence): WebPolicyIdentity =>
  'schema' in value && value.schema === 'open-science.package-web.v1'
    ? { ...value.provenance, recordedPolicyVersion: value.provenance.policyVersion }
    : {
        origin:
          (value as WebResult).operation === 'search' ? 'provider-search' : 'independent-fetch',
        providerId: (value as WebResult).provider?.id,
        providerAuthMode: (value as WebResult).provider?.auth_mode,
        recordedPolicyVersion: (value as WebResult).provider?.data_policy_version
      }
// Previous packages describe their own provenance. Check the recorded execution before
// carrying Exa's attribution policy forward to their query and source manifest.
const corroboratesExaAttribution = (packet: PackageWebActivityEvidence): boolean => {
  const isExaDispatch = ({
    provider,
    execution
  }: Pick<WebSearchAttempt, 'provider' | 'execution'>): boolean =>
    execution === 'direct_search' &&
    provider.id === 'exa' &&
    provider.auth_mode === 'anonymous' &&
    provider.data_policy_version === EXA_POLICY_VERSION
  const lastDispatch = packet.dispatches?.at(-1)
  const latest = packet.attempts?.at(-1) ?? lastDispatch
  if (!latest || !isExaDispatch(latest)) return false
  if (lastDispatch && (lastDispatch.index !== latest.index || !isExaDispatch(lastDispatch)))
    return false
  return packet.sources.every(({ attemptIndex }) => {
    const attempt = packet.attempts?.find(({ index }) => index === attemptIndex)
    const dispatch = packet.dispatches?.find(({ index }) => index === attemptIndex)
    return (
      !!attempt &&
      attempt.status === 'ok' &&
      attempt.search_executed === true &&
      isExaDispatch(attempt) &&
      (!lastDispatch || (!!dispatch && isExaDispatch(dispatch)))
    )
  })
}
const projectSessionActivities = (
  session: PersistedChatSession,
  project: <T extends PersistedToolActivity>(activity: T) => T
): PersistedChatSession => {
  const result = clone(session)
  result.activities = result.activities?.map(project)
  if (result.conversationGraph)
    result.conversationGraph.activities = result.conversationGraph.activities.map(project)
  return result
}
const omitLocalModelService = <T extends { model_service_id?: string }>(entry: T): T => {
  const portable = clone(entry)
  // A sender's local service identity is neither portable provenance nor execution authority.
  delete portable.model_service_id
  return portable
}
const sessionProjection = (
  session: PersistedChatSession,
  packets: ReadonlyMap<string, PackageWebActivityEvidence>,
  plan: WebEvidenceProjectionPlan
): PersistedChatSession => {
  return projectSessionActivities(session, (activity) => {
    if (!knownActivity(activity)) {
      // External tools can echo a Web result. Project their output without reclassifying
      // the activity or changing its identity, arguments, or portable evidence.
      if (!plan.restrictedText.size && !packets.size) return activity
      const output = Object.fromEntries(
        Object.entries(activity).filter(([key]) =>
          ['rawOutput', 'toolContent', 'terminalOutput'].includes(key)
        )
      )
      return { ...activity, ...projectWebDerivedValue(output, plan, true) }
    }
    const packet = packets.get(activity.executionInvocationId ?? '')
    return projectWebDetails(activity, packet && { ...packet, activityId: activity.id })
  })
}

/** Builds independent portable evidence; input execution records and source hashes are immutable. */
export async function prepareWebEvidence(
  session: PersistedChatSession,
  options: PrepareWebEvidenceOptions = {}
): Promise<WebEvidenceProjection> {
  const resolver = options.resolvePolicy ?? resolveUnknownWebPolicy
  const packets = new Map<string, PackageWebActivityEvidence>()
  const restrictedText = new Map<string, string[]>()
  const shortContentCopies = new Map<string, RegExp[]>()
  const words = new Intl.Segmenter(undefined, { granularity: 'word' })
  const rememberShortContent = (id: string, content: string | undefined): void => {
    if (!content || content.length >= 32) return
    const phrase = content.trim()
    if (!phrase) return
    const wordCount = [...words.segment(phrase)].filter((word) => word.isWordLike).length
    const identifier = /\p{L}[_\d]|\d\p{L}/u.test(phrase)
    if (wordCount < 2 && !identifier) return
    // Match a complete content phrase, including JSON-escaped copies in opaque files.
    // Short queries, titles, URLs and isolated common words retain their attribution rules.
    const forms = new Set([phrase, JSON.stringify(phrase).slice(1, -1)])
    const patterns = shortContentCopies.get(id) ?? []
    for (const form of forms) {
      const escaped = form.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&')
      const word = '[\\p{L}\\p{N}_]'
      const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
      const left =
        /^[\p{L}\p{N}_]/u.test(form) && !unspaced.test([...form][0]) ? '(?<!' + word + ')' : ''
      const right =
        /[\p{L}\p{N}_]$/u.test(form) && !unspaced.test([...form].at(-1)!) ? '(?!' + word + ')' : ''
      patterns.push(new RegExp(left + escaped + right, 'gu'))
    }
    shortContentCopies.set(id, patterns)
  }
  const snapshots = new Map<string, PackageWebSnapshot>()
  const unidentified = new Set<string>()
  const unavailableOmissions: PackageWebOmission[] = []
  let snapshotBytes = 0
  let packetBytes = 0
  const sourceActivities: WebPackageActivity[] = [
    ...(session.conversationGraph?.activities ?? []),
    ...(session.activities ?? [])
  ]
  const existing = options.existingEvidence
    ? validatePackageWebEvidence(options.existingEvidence)
    : undefined
  for (const activity of sourceActivities) {
    if (!knownActivity(activity)) continue
    const invocationId = activity.executionInvocationId
    const request = privateRequest(activity.rawInput)
    if (!invocationId) {
      if (!unidentified.has(activity.id)) {
        unidentified.add(activity.id)
        restrictedText.set(activity.id, Object.values(request))
        if (request.query)
          unavailableOmissions.push({ component: 'query_history', reason: 'invalid', count: 1 })
        if (request.url)
          unavailableOmissions.push({ component: 'source_manifest', reason: 'invalid', count: 1 })
        unavailableOmissions.push({
          component: activity.providerToolName?.endsWith('web_search')
            ? 'provider_excerpt'
            : 'fetch_body',
          reason: 'invalid',
          count: 1
        })
      }
      continue
    }
    if (packets.has(invocationId)) continue
    const imported = packageWebActivityEvidenceSchema.safeParse(
      (activity as { packageWebEvidence?: unknown }).packageWebEvidence
    )
    const prior = imported.success
      ? imported.data
      : existing?.activities.find((item) => item.invocationId === invocationId)
    const result = findResult(activity.toolContent) ?? findResult(activity.rawOutput)
    const matching = result?.invocation_id === invocationId ? result : undefined
    const source = prior ?? matching
    const operation =
      source?.operation ?? (activity.providerToolName?.endsWith('web_search') ? 'search' : 'fetch')
    let identity: WebPolicyIdentity = source
      ? policyIdentity(source)
      : {
          origin:
            operation === 'search' ? ('provider-search' as const) : ('independent-fetch' as const)
        }
    const lastDispatch = activity.webInvocation?.searchDispatches?.at(-1)
    if (operation === 'search' && !identity.providerId && lastDispatch)
      identity = {
        origin: 'provider-search',
        providerId: lastDispatch.provider.id,
        providerAuthMode: lastDispatch.provider.auth_mode,
        recordedPolicyVersion: lastDispatch.provider.data_policy_version
      }
    const policy =
      prior?.sourceSchema === 'open-science.web.v2' &&
      isReviewedAnonymousExa(identity) &&
      !corroboratesExaAttribution(prior)
        ? UNKNOWN_WEB_SHARING_POLICY
        : resolver(identity)
    if (
      !policy.version ||
      policy.version.length > 128 ||
      components.some(
        (component) =>
          !['allow', 'deny', 'unknown'].includes(policy.components[component] ?? 'unknown')
      )
    )
      throw new Error('Invalid host Web sharing policy')
    const omissions: PackageWebOmission[] = []
    const projectedText = (
      value: string,
      limit: number,
      component: WebEvidenceComponent
    ): string => {
      const projected = text(value, limit)
      if (projected !== value) omissions.push({ component, reason: 'redacted', count: 1 })
      return projected
    }
    const allow = (component: (typeof components)[number], present = true): boolean => {
      const decision = policy.components[component] ?? 'unknown'
      if (present && decision !== 'allow')
        omissions.push({
          component,
          reason: decision === 'deny' ? 'policy-denied' : 'policy-unknown',
          count: 1
        })
      return decision === 'allow'
    }
    const manifestAllowed = allow('source_manifest')
    const queryValue =
      prior?.query ??
      (matching && 'query' in matching.request ? matching.request.query : undefined) ??
      request.query
    const queryAllowed = allow('query_history', queryValue !== undefined)
    const excerptAllowed = allow(
      'provider_excerpt',
      operation === 'search' &&
        !!(prior?.sources.some((s) => s.snippet) || matching?.sources.some((s) => s.snippet))
    )
    const bodyAllowed = allow(
      'fetch_body',
      operation === 'fetch' &&
        !!(
          prior?.document ||
          matching?.document ||
          prior?.sources.some((source) => source.snippet) ||
          matching?.sources.some((source) => source.snippet)
        )
    )
    const sourceSnippetAllowed = operation === 'search' ? excerptAllowed : bodyAllowed
    const blocked: string[] = []
    if (!queryAllowed && queryValue) blocked.push(queryValue)
    const sourceList =
      prior?.sources ??
      matching?.sources.map((source) => ({
        sourceId: source.source_id,
        url: source.url,
        title: source.title,
        snippet: source.snippet,
        publishedAt: source.published_at,
        evidenceKind: source.evidence_kind,
        attemptIndex: source.attempt_index
      })) ??
      []
    const attempts =
      prior?.attempts ?? matching?.attempts ?? activity.webInvocation?.searchAttempts ?? []
    const dispatches = prior?.dispatches ?? activity.webInvocation?.searchDispatches
    const restricted =
      prior?.sourceSchema === 'open-science.web.v3' || matching?.schema === 'open-science.web.v3'
    const packet: PackageWebActivityEvidence = {
      schema: 'open-science.package-web.v1',
      ...(['open-science.web.v2', 'open-science.web.v3'].includes(prior?.sourceSchema ?? '') ||
      ['open-science.web.v2', 'open-science.web.v3'].includes(matching?.schema ?? '') ||
      !!activity.webInvocation?.searchDispatches?.length
        ? {
            sourceSchema: restricted
              ? ('open-science.web.v3' as const)
              : ('open-science.web.v2' as const),
            minReaderVersion:
              restricted ||
              usesExtendedSearchProtocol(attempts) ||
              usesExtendedSearchProtocol(dispatches)
                ? (3 as const)
                : (2 as const),
            ...(prior?.resultKind || matching?.result_kind
              ? {
                  resultKind: 'restricted_grounded_result' as const,
                  presentationStatus: 'presentation_only' as const
                }
              : {}),
            routing: clone(prior?.routing ?? matching?.routing),
            dispatches: dispatches?.map(omitLocalModelService),
            attempts: attempts.map(omitLocalModelService)
          }
        : {}),
      activityId: activity.id,
      invocationId,
      operation,
      status:
        activity.webInvocation?.searchDispatches?.length && !matching?.attempts && !prior
          ? 'unavailable'
          : (source?.status ?? 'unavailable'),
      provenance: {
        origin: identity.origin,
        policyVersion: policy.version,
        ...(identity.providerId ? { providerId: identity.providerId } : {}),
        ...(identity.providerAuthMode ? { providerAuthMode: identity.providerAuthMode } : {})
      },
      ...(source
        ? {
            retrievedAt: prior?.retrievedAt ?? matching?.retrieved_at,
            durationMs: prior?.durationMs ?? matching?.duration_ms
          }
        : {}),
      ...(queryAllowed && queryValue !== undefined
        ? { query: projectedText(queryValue, 7000, 'query_history') }
        : {}),
      sources: [],
      omissions
    }
    const synthesis = prior?.synthesis ?? matching?.synthesis
    if (synthesis) {
      blocked.push(synthesis.text)
      rememberShortContent(invocationId, synthesis.text)
      omissions.push({ component: 'model_synthesis', reason: 'policy-unknown', count: 1 })
    }
    const requestUrl =
      prior?.requestUrl ??
      (matching && 'url' in matching.request ? matching.request.url : undefined) ??
      request.url
    if (manifestAllowed && safeUrl(requestUrl)) packet.requestUrl = requestUrl
    else if (requestUrl) {
      blocked.push(requestUrl)
      if (manifestAllowed)
        omissions.push({ component: 'source_manifest', reason: 'redacted', count: 1 })
    }
    for (const item of sourceList) {
      if (!manifestAllowed) {
        if (item.url) blocked.push(item.url)
        if (item.title) blocked.push(item.title)
      }
      if (!sourceSnippetAllowed && item.snippet) {
        blocked.push(item.snippet)
        rememberShortContent(invocationId, item.snippet)
      }
      if (manifestAllowed && item.url && !safeUrl(item.url))
        omissions.push({ component: 'source_manifest', reason: 'redacted', count: 1 })
      if (!manifestAllowed && !sourceSnippetAllowed) continue
      packet.sources.push({
        sourceId: item.sourceId,
        ...(item.evidenceKind ? { evidenceKind: item.evidenceKind } : {}),
        ...(item.attemptIndex ? { attemptIndex: item.attemptIndex } : {}),
        ...(manifestAllowed && safeUrl(item.url) ? { url: item.url } : {}),
        ...(manifestAllowed && item.title
          ? { title: projectedText(item.title, 512, 'source_manifest') }
          : {}),
        ...(manifestAllowed && item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        ...(sourceSnippetAllowed && item.snippet
          ? {
              snippet: projectedText(
                item.snippet,
                8000,
                operation === 'search' ? 'provider_excerpt' : 'fetch_body'
              )
            }
          : {})
      })
    }
    const document = prior?.document
    const originalDocument = matching?.document
    if (document || originalDocument) {
      const snapshotId = document?.snapshotId ?? originalDocument?.snapshot_id
      const bodyText = document?.text ?? originalDocument?.text
      const finalUrl = document?.finalUrl ?? originalDocument?.final_url
      if (!bodyAllowed && bodyText) {
        blocked.push(bodyText)
        rememberShortContent(invocationId, bodyText)
      }
      if (!manifestAllowed && finalUrl) blocked.push(finalUrl)
      const projectedExcerpt =
        bodyAllowed && bodyText !== undefined
          ? projectedText(bodyText, 16000, 'fetch_body')
          : undefined
      packet.document = {
        truncated: document?.truncated ?? originalDocument?.truncated ?? true,
        ...(manifestAllowed && safeUrl(finalUrl) ? { finalUrl } : {}),
        ...(manifestAllowed && safeUrl(document?.originalUrl)
          ? { originalUrl: document!.originalUrl }
          : {}),
        ...(bodyAllowed
          ? {
              snapshotId,
              fetchedAt: document?.fetchedAt ?? originalDocument?.fetched_at,
              contentType: document?.contentType ?? originalDocument?.content_type,
              extractionMethod: document?.extractionMethod ?? originalDocument?.extraction_method,
              extractionQuality:
                document?.extractionQuality ?? originalDocument?.extraction_quality,
              extractorVersion: document?.extractorVersion ?? originalDocument?.extractor_version,
              sourceSha256: document?.sourceSha256 ?? originalDocument?.sha256,
              ...(bodyText !== undefined
                ? { text: projectedExcerpt!, projectedSha256: hash(projectedExcerpt!) }
                : {}),
              startLine: document?.startLine ?? originalDocument?.start_line,
              endLine: document?.endLine ?? originalDocument?.end_line,
              totalLines: document?.totalLines ?? originalDocument?.total_lines
            }
          : {})
      }
      if (bodyAllowed && snapshotId && !snapshots.has(snapshotId)) {
        const inherited = existing?.snapshots.find((item) => item.snapshotId === snapshotId)
        let loaded: WebSnapshotInput | undefined
        try {
          loaded = inherited
            ? { ...inherited, sha256: inherited.projectedSha256 }
            : await options.loadSnapshot?.(snapshotId, activity)
        } catch {
          omissions.push({ component: 'fetch_body', reason: 'missing', count: 1 })
        }
        if (loaded) {
          if (
            loaded.snapshotId !== snapshotId ||
            hash(loaded.text) !== loaded.sha256 ||
            (inherited?.sourceSha256 ?? loaded.sha256) !== packet.document?.sourceSha256
          )
            omissions.push({ component: 'fetch_body', reason: 'invalid', count: 1 })
          else {
            const projected = projectedText(loaded.text, 6 * 1024 * 1024, 'fetch_body')
            const snapshot = packageWebSnapshotSchema.parse({
              snapshotId,
              invocationId,
              provenance: packet.provenance,
              sourceSha256: inherited?.sourceSha256 ?? loaded.sha256,
              projectedSha256: hash(projected),
              text: projected,
              truncated: (inherited?.truncated ?? false) || projected !== loaded.text,
              ...(manifestAllowed && safeUrl(loaded.originalUrl)
                ? { originalUrl: loaded.originalUrl }
                : {}),
              ...(manifestAllowed && safeUrl(loaded.finalUrl) ? { finalUrl: loaded.finalUrl } : {}),
              ...(manifestAllowed && loaded.title ? { title: text(loaded.title, 512) } : {}),
              fetchedAt: loaded.fetchedAt,
              contentType: loaded.contentType,
              extractorVersion: loaded.extractorVersion,
              extractionMethod: loaded.extractionMethod,
              extractionQuality: loaded.extractionQuality
            })
            const bytes = Buffer.byteLength(JSON.stringify(snapshot))
            if (snapshotBytes + bytes <= 24 * 1024 * 1024) {
              snapshots.set(snapshotId, snapshot)
              snapshotBytes += bytes
            } else omissions.push({ component: 'fetch_body', reason: 'size-limit', count: 1 })
          }
        } else if (
          !omissions.some((item) => item.component === 'fetch_body' && item.reason === 'missing')
        )
          omissions.push({ component: 'fetch_body', reason: 'missing', count: 1 })
      }
    }
    if (!source)
      omissions.push({
        component: operation === 'search' ? 'provider_excerpt' : 'fetch_body',
        reason: 'invalid',
        count: 1
      })
    const errorCode = prior?.errorCode ?? matching?.error?.code
    if (errorCode) packet.errorCode = errorCode
    if (packetBytes + Buffer.byteLength(JSON.stringify(packet)) > 24 * 1024 * 1024) {
      if (packet.query)
        omissions.push({ component: 'query_history', reason: 'size-limit', count: 1 })
      if (packet.requestUrl || packet.sources.some((source) => source.url || source.title))
        omissions.push({ component: 'source_manifest', reason: 'size-limit', count: 1 })
      if (packet.sources.some((source) => source.snippet))
        omissions.push({ component: 'provider_excerpt', reason: 'size-limit', count: 1 })
      if (packet.document?.text)
        omissions.push({ component: 'fetch_body', reason: 'size-limit', count: 1 })

      delete packet.query
      delete packet.requestUrl
      packet.sources = []
      delete packet.document
    }
    packet.omissions = summarize(omissions)
    packetBytes += Buffer.byteLength(JSON.stringify(packet))
    packets.set(invocationId, packageWebActivityEvidenceSchema.parse(packet))
    restrictedText.set(invocationId, blocked.filter(Boolean))
  }
  // Stored records may outlive a removed branch/activity. Never forward those orphaned bytes
  // merely because there is no surviving row from which to rebuild the sharing projection.
  const orphaned: PackageWebActivityEvidence[] = []
  for (const orphan of existing?.activities ?? []) {
    if (packets.has(orphan.invocationId)) continue
    orphaned.push(orphan)
    rememberShortContent(orphan.invocationId, orphan.document?.text)
    for (const source of orphan.sources) rememberShortContent(orphan.invocationId, source.snippet)
    for (const snapshot of existing!.snapshots)
      if (snapshot.invocationId === orphan.invocationId)
        rememberShortContent(orphan.invocationId, snapshot.text)
    restrictedText.set(
      orphan.invocationId,
      [
        orphan.query,
        orphan.requestUrl,
        orphan.document?.originalUrl,
        orphan.document?.finalUrl,
        orphan.document?.text,
        orphan.synthesis?.text,
        ...orphan.sources.flatMap((source) => [source.url, source.title, source.snippet]),
        ...existing!.snapshots
          .filter((snapshot) => snapshot.invocationId === orphan.invocationId)
          .flatMap((snapshot) => [
            snapshot.originalUrl,
            snapshot.finalUrl,
            snapshot.title,
            snapshot.text
          ])
      ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
    unavailableOmissions.push({
      component: orphan.operation === 'fetch' ? 'fetch_body' : 'provider_excerpt',
      reason: 'invalid',
      count: 1
    })
    if (orphan.query)
      unavailableOmissions.push({ component: 'query_history', reason: 'invalid', count: 1 })
    if (orphan.requestUrl || orphan.sources.length || orphan.document?.finalUrl)
      unavailableOmissions.push({ component: 'source_manifest', reason: 'invalid', count: 1 })
  }
  const omissions = summarize([
    ...unavailableOmissions,
    ...[...packets.values()].flatMap((packet) => packet.omissions)
  ])
  const referenced = new Map(
    [...packets.values()]
      .filter((packet) => packet.document?.snapshotId)
      .map((packet) => [packet.document!.snapshotId!, packet.invocationId])
  )
  const evidence =
    packets.size || omissions.length
      ? {
          version: 1 as const,
          ...([...packets.values()].some((packet) =>
            ['open-science.web.v2', 'open-science.web.v3'].includes(packet.sourceSchema ?? '')
          )
            ? {
                requiredCapabilities: [
                  'web-result-v2' as const,
                  ...([...packets.values()].some(
                    (packet) => packet.sourceSchema === 'open-science.web.v3'
                  )
                    ? ['web-restricted-result-v1' as const]
                    : []),
                  ...([...packets.values()].some(
                    (packet) =>
                      usesExtendedSearchProtocol(packet.attempts) ||
                      usesExtendedSearchProtocol(packet.dispatches)
                  )
                    ? ['web-search-operations-v1' as const]
                    : [])
                ]
              }
            : {}),
          activities: [...packets.values()],
          snapshots: [...snapshots.values()]
            .filter((snapshot) => referenced.has(snapshot.snapshotId))
            .map((snapshot) => ({
              ...snapshot,
              invocationId: referenced.get(snapshot.snapshotId)!
            })),
          omissions
        }
      : undefined
  if (evidence) validatePackageWebEvidence(evidence)
  const derivedPackets = new Map(packets)
  for (const orphan of orphaned)
    derivedPackets.set(orphan.invocationId, {
      schema: 'open-science.package-web.v1',
      activityId: orphan.activityId,
      invocationId: orphan.invocationId,
      operation: orphan.operation,
      status: 'unavailable',
      provenance: {
        origin: orphan.provenance.origin,
        policyVersion: UNKNOWN_WEB_SHARING_POLICY.version
      },
      sources: [],
      omissions: [
        {
          component: orphan.operation === 'fetch' ? 'fetch_body' : 'provider_excerpt',
          reason: 'invalid',
          count: 1
        }
      ]
    })
  const plan = {
    packets: derivedPackets,
    restrictedText,
    shortContentCopies,
    unidentifiedActivityIds: unidentified
  }
  return {
    session: sessionProjection(session, packets, plan),
    ...(evidence ? { webEvidence: evidence } : {}),
    omissions,
    plan
  }
}

/** Projects only recognized Web execution copies, leaving old external tool formats intact. */
export function projectWebDerivedValue<T>(
  value: T,
  plan: WebEvidenceProjectionPlan,
  externalOutput = false
): T {
  const displayTextFields = new Set([
    'content',
    'text',
    'output',
    'rawOutput',
    'terminalOutput',
    'body',
    'notes',
    'summary',
    'description'
  ])
  const visit = (item: unknown, depth: number, displayText = false): unknown => {
    if (depth > 80) throw new Error('Web derived evidence exceeds its nesting limit')
    if (typeof item === 'string') {
      if (/^[\s]*[[{]/.test(item)) {
        try {
          const parsed: unknown = JSON.parse(item)
          const projected = visit(parsed, depth + 1, displayText)
          return JSON.stringify(projected) === JSON.stringify(parsed)
            ? item
            : JSON.stringify(projected)
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
      if (!displayText && !externalOutput) return item
      let safe = externalOutput ? item : redactSensitiveText(item)
      for (const restricted of plan.restrictedText.values())
        for (const fragment of restricted)
          if (fragment.length >= 32 || (displayText && safe.trim() === fragment.trim()))
            safe = safe.split(fragment).join('')
      for (const patterns of plan.shortContentCopies.values())
        for (const pattern of patterns) safe = safe.replace(pattern, '')
      return safe
    }
    if (Array.isArray(item)) return item.map((part) => visit(part, depth + 1, displayText))
    if (!record(item)) return item
    if (
      item.kind === 'tool' &&
      knownActivity(item as unknown as PersistedToolActivity) &&
      typeof item.id === 'string' &&
      plan.unidentifiedActivityIds.has(item.id)
    )
      return projectWebDetails(item as unknown as PersistedToolActivity)
    // Preserve the journal's function-call shape while removing private request arguments.
    if (item.type === 'function' && typeof item.id === 'string' && record(item.function)) {
      const packet = plan.packets.get(item.id)
      if (
        packet &&
        [
          `mcp__open_science_web__web_${packet.operation}`,
          `mcp__open-science-web__web_${packet.operation}`
        ].includes(String(item.function.name))
      )
        return {
          ...item,
          function: {
            ...item.function,
            arguments: JSON.stringify({
              ...(packet.query !== undefined ? { query: packet.query } : {}),
              ...(packet.requestUrl !== undefined ? { url: packet.requestUrl } : {})
            })
          }
        }
    }
    const invocationId = [
      item.invocation_id,
      item.invocationId,
      item.executionInvocationId,
      item.toolCallId
    ].find((id) => typeof id === 'string' && plan.packets.has(id)) as string | undefined
    if (
      invocationId &&
      item.schema !== 'open-science.package-web.v1' &&
      (!externalOutput || parseWebResult(item))
    ) {
      const packet = plan.packets.get(invocationId)!
      if (item.kind === 'tool' && knownActivity(item as unknown as PersistedToolActivity))
        return projectWebDetails(item as unknown as PersistedToolActivity, {
          ...packet,
          activityId: String(item.id)
        })
      return clone(packet)
    }
    return Object.fromEntries(
      Object.entries(item).map(([key, part]) => [
        key,
        visit(part, depth + 1, displayTextFields.has(key))
      ])
    )
  }
  return visit(value, 0) as T
}
export function containsShortWebContent(
  value: string,
  plan: WebEvidenceProjectionPlan,
  id: string
): boolean {
  return plan.shortContentCopies.get(id)?.some((pattern) => value.search(pattern) !== -1) ?? false
}

export function assertWebDerivedTextSafe(value: string, plan: WebEvidenceProjectionPlan): void {
  const projected = projectWebDerivedValue(value, plan)
  if (projected !== value) throw new WebEvidencePolicyError()
  for (const id of plan.shortContentCopies.keys())
    if (containsShortWebContent(value, plan, id)) throw new WebEvidencePolicyError()
  for (const [id, restricted] of plan.restrictedText)
    if (
      restricted.some(
        (item) =>
          (item.length >= 32 || value.includes(id) || value.trim() === item.trim()) &&
          value.includes(item)
      )
    )
      throw new WebEvidencePolicyError()
}

export function validatePackageWebEvidence(value: unknown): PackageWebEvidence {
  const evidence = packageWebEvidenceSchema.parse(value)
  const snapshots = new Map<string, PackageWebSnapshot>()
  for (const snapshot of evidence.snapshots) {
    if (snapshots.has(snapshot.snapshotId) || hash(snapshot.text) !== snapshot.projectedSha256)
      throw new Error('Web snapshot integrity mismatch')
    snapshots.set(snapshot.snapshotId, snapshot)
  }
  const invocations = new Set<string>()
  const activityIds = new Set<string>()
  const references = new Map<string, PackageWebActivityEvidence[]>()
  for (const activity of evidence.activities) {
    if (invocations.has(activity.invocationId)) throw new Error('Duplicate Web invocation identity')
    invocations.add(activity.invocationId)
    if (activityIds.has(activity.activityId)) throw new Error('Duplicate Web activity identity')
    activityIds.add(activity.activityId)
    if (
      activity.provenance.origin !==
        (activity.operation === 'search' ? 'provider-search' : 'independent-fetch') ||
      (activity.operation === 'search' && activity.document)
    )
      throw new Error('Web activity provenance mismatch')
    if (
      (usesExtendedSearchProtocol(activity.attempts) ||
        usesExtendedSearchProtocol(activity.dispatches)) &&
      !evidence.requiredCapabilities?.includes('web-search-operations-v1')
    )
      throw new Error('Web operation protocol reader capability declaration is invalid')
    if (activity.sourceSchema === 'open-science.web.v3') {
      if (
        activity.minReaderVersion !== 3 ||
        !evidence.requiredCapabilities?.includes('web-restricted-result-v1') ||
        activity.resultKind !== 'restricted_grounded_result' ||
        activity.presentationStatus !== 'presentation_only' ||
        activity.sources.length ||
        activity.synthesis ||
        activity.document ||
        activity.requestUrl
      )
        throw new Error('Restricted Web result must contain metadata only')
    } else if (activity.resultKind || activity.presentationStatus)
      throw new Error('Restricted Web result requires v3')
    if (
      activity.sourceSchema === 'open-science.web.v2' ||
      activity.sourceSchema === 'open-science.web.v3'
    ) {
      if (
        activity.minReaderVersion !==
          (activity.sourceSchema === 'open-science.web.v3' ||
          usesExtendedSearchProtocol(activity.attempts) ||
          usesExtendedSearchProtocol(activity.dispatches)
            ? 3
            : 2) ||
        !evidence.requiredCapabilities?.includes('web-result-v2') ||
        !activity.attempts
      )
        throw new Error('Web v2 capability declaration mismatch')
      activity.dispatches?.forEach((dispatch, index) => {
        if (dispatch.index !== index + 1) throw new Error('Web dispatch order mismatch')
      })
      activity.attempts.forEach((attempt, index) => {
        if (attempt.index !== index + 1) throw new Error('Web attempt order mismatch')
      })
      const successful = (index: number | undefined): boolean =>
        activity.attempts!.some(
          (attempt) =>
            attempt.index === index && attempt.status === 'ok' && attempt.search_executed === true
        )
      if (
        activity.sources.some(
          (source) => !successful(source.attemptIndex) || source.evidenceKind === 'page_extract'
        )
      )
        throw new Error('Web source attempt provenance mismatch')
      if (
        activity.synthesis &&
        (!successful(activity.synthesis.attempt_index) ||
          activity.synthesis.attempt_index !== activity.attempts.at(-1)?.index)
      )
        throw new Error('Web synthesis attempt provenance mismatch')
    } else if (
      activity.dispatches ||
      activity.routing ||
      activity.attempts ||
      activity.synthesis ||
      activity.minReaderVersion ||
      activity.sources.some(
        (source) => source.attemptIndex !== undefined || source.evidenceKind === 'provider_citation'
      )
    ) {
      throw new Error('Web v2 fields require explicit source version')
    }
    if (new Set(activity.sources.map((source) => source.sourceId)).size !== activity.sources.length)
      throw new Error('Duplicate Web source identity')
    if (activity.document?.snapshotId) {
      const linked = references.get(activity.document.snapshotId) ?? []
      linked.push(activity)
      references.set(activity.document.snapshotId, linked)
      if (
        !snapshots.has(activity.document.snapshotId) &&
        !activity.omissions.some(
          (omission) =>
            omission.component === 'fetch_body' &&
            ['missing', 'invalid', 'size-limit'].includes(omission.reason)
        )
      )
        throw new Error('Missing Web snapshot evidence')
    }
    if (
      activity.document?.text !== undefined &&
      activity.document.projectedSha256 !== hash(activity.document.text)
    )
      throw new Error('Web excerpt integrity mismatch')
    const snapshot = activity.document?.snapshotId
      ? snapshots.get(activity.document.snapshotId)
      : undefined
    if (
      snapshot &&
      (snapshot.sourceSha256 !== activity.document?.sourceSha256 ||
        JSON.stringify(snapshot.provenance) !== JSON.stringify(activity.provenance))
    )
      throw new Error('Web snapshot provenance mismatch')
  }
  for (const snapshot of snapshots.values()) {
    const linked = references.get(snapshot.snapshotId)
    if (
      !linked?.some((activity) => activity.invocationId === snapshot.invocationId) ||
      snapshot.provenance.origin !== 'independent-fetch'
    )
      throw new Error('Unbound Web snapshot provenance')
  }
  return evidence
}
/** A future top-level version is unavailable evidence, not permission or an unreadable Session. */
export function parsePackageWebEvidence(value: unknown): PackageWebEvidence | undefined {
  if (!record(value) || value.version !== 1) return undefined
  const candidate = clone(value)
  if (Array.isArray(candidate.activities)) {
    const known = candidate.activities.filter(
      (activity) => !record(activity) || activity.schema === 'open-science.package-web.v1'
    )
    if (known.length !== candidate.activities.length && Array.isArray(candidate.snapshots)) {
      const referenced = new Set(
        known.flatMap((activity) =>
          record(activity) && record(activity.document) ? [activity.document.snapshotId] : []
        )
      )
      candidate.snapshots = candidate.snapshots.filter(
        (snapshot) => !record(snapshot) || referenced.has(snapshot.snapshotId)
      )
    }
    candidate.activities = known
  }
  const parsed = packageWebEvidenceSchema.safeParse(candidate)
  if (!parsed.success) {
    if (!parsed.error.issues.every((issue) => issue.code === 'unrecognized_keys'))
      throw parsed.error
    for (const issue of parsed.error.issues) {
      if (issue.code !== 'unrecognized_keys') continue
      let target: unknown = candidate
      for (const part of issue.path)
        target =
          record(target) || Array.isArray(target)
            ? (target as Record<string, unknown>)[String(part)]
            : undefined
      if (record(target)) for (const key of issue.keys) delete target[key]
    }
  }
  return validatePackageWebEvidence(candidate)
}
export function allocateWebEvidenceIdentities(
  evidence: PackageWebEvidence | undefined,
  identities: Record<string, string>,
  createId: () => string = randomUUID
): void {
  if (!evidence) return
  const verified = validatePackageWebEvidence(evidence)
  for (const activity of verified.activities) {
    for (const id of [
      activity.activityId,
      activity.invocationId,
      ...activity.sources.map((source) => source.sourceId),
      activity.document?.snapshotId
    ])
      if (id) identities[id] ??= createId()
  }
  for (const snapshot of verified.snapshots) {
    identities[snapshot.snapshotId] ??= createId()
    identities[snapshot.invocationId] ??= createId()
  }
}
export function remapWebEvidence(
  sourceSession: PersistedChatSession,
  mappedSession: PersistedChatSession,
  evidence: PackageWebEvidence | undefined,
  identities: Readonly<Record<string, string>>
): { session: PersistedChatSession; webEvidence?: PackageWebEvidence } {
  const stripInline = <T extends PersistedToolActivity>(activity: T): T =>
    activity.packageWebEvidence ? projectWebDetails(activity) : activity
  if (!evidence) return { session: projectSessionActivities(mappedSession, stripInline) }
  const verified = validatePackageWebEvidence(evidence)
  const mapped = (id: string): string => {
    if (!identities[id]) throw new Error('Missing Web package identity mapping')
    return identities[id]
  }
  const packets = new Map<string, PackageWebActivityEvidence>()
  const activities = verified.activities.map((activity) => {
    const next = clone(activity)
    next.activityId = mapped(activity.activityId)
    next.invocationId = mapped(activity.invocationId)
    next.sources = next.sources.map((source) => ({ ...source, sourceId: mapped(source.sourceId) }))
    if (next.document?.snapshotId) next.document.snapshotId = mapped(next.document.snapshotId)
    packets.set(activity.invocationId, next)
    return next
  })
  const snapshots = verified.snapshots.map((snapshot) => ({
    ...clone(snapshot),
    snapshotId: mapped(snapshot.snapshotId),
    invocationId: mapped(snapshot.invocationId)
  }))
  const sourceActivities = [
    ...(sourceSession.conversationGraph?.activities ?? []),
    ...(sourceSession.activities ?? [])
  ]
  const sourceByMappedId = new Map(
    sourceActivities.map((activity) => [identities[activity.id] ?? activity.id, activity])
  )
  const session = projectSessionActivities(mappedSession, (activity) => {
    const original = sourceByMappedId.get(activity.id)
    const packet = original?.executionInvocationId
      ? packets.get(original.executionInvocationId)
      : undefined
    if (
      !packet ||
      !original ||
      !knownActivity(original) ||
      packet.activityId !== activity.id ||
      !original.providerToolName?.endsWith(`__web_${packet.operation}`)
    )
      return stripInline(activity)
    return {
      ...projectWebDetails(stripInline(activity), packet),
      executionInvocationId: packet.invocationId
    }
  })
  return {
    session,
    webEvidence: validatePackageWebEvidence({ ...verified, activities, snapshots })
  }
}

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { PersistedToolActivity } from '../../shared/session-message-contract'
import type { WebResult } from '../../shared/web-tools'
import type { WebEvidenceComponent, WebPolicyDecision } from '../../shared/session-package-web'
import {
  allocateWebEvidenceIdentities,
  assertWebDerivedTextSafe,
  parsePackageWebEvidence,
  prepareWebEvidence,
  projectWebDerivedValue,
  remapWebEvidence,
  resolveReviewedWebPolicy,
  validatePackageWebEvidence,
  type HostWebDataPolicy,
  type WebSnapshotInput
} from './web-evidence'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const now = '2026-11-16T00:00:00.000Z'
const body = 'Complete independent public research body.\nSecond line.'
const snapshot: WebSnapshotInput = {
  snapshotId: 'snapshot-original',
  invocationId: 'fetch-original',
  originalUrl: 'https://example.org/original',
  finalUrl: 'https://example.org/research',
  fetchedAt: now,
  contentType: 'text/plain',
  extractorVersion: 'fixture-v1',
  extractionMethod: 'plain_text',
  extractionQuality: 'normal',
  text: body,
  sha256: hash(body)
}
const fetchResult = (): WebResult => ({
  schema: 'open-science.web.v1',
  invocation_id: 'fetch-original',
  operation: 'fetch',
  status: 'ok',
  request: { url: snapshot.originalUrl },
  retrieved_at: now,
  duration_ms: 5,
  sources: [
    {
      source_id: 'source-original',
      url: snapshot.finalUrl!,
      title: 'Research title',
      evidence_kind: 'page_extract'
    }
  ],
  document: {
    snapshot_id: snapshot.snapshotId,
    final_url: snapshot.finalUrl!,
    fetched_at: now,
    content_type: 'text/plain',
    extraction_method: 'plain_text',
    extraction_quality: 'normal',
    extractor_version: 'fixture-v1',
    sha256: snapshot.sha256,
    text: 'Complete independent public research body.',
    start_line: 1,
    end_line: 1,
    total_lines: 2,
    truncated: true,
    next_cursor: 'private-signed-cursor'
  }
})
const searchResult = (): WebResult => ({
  schema: 'open-science.web.v1',
  invocation_id: 'search-original',
  operation: 'search',
  status: 'ok',
  request: { query: 'private research query' },
  retrieved_at: now,
  duration_ms: 3,
  returned_count: 1,
  provider: { id: 'exa', auth_mode: 'anonymous', data_policy_version: 'exa-unconfirmed' },
  sources: [
    {
      source_id: 'search-source',
      url: 'https://example.org/search',
      title: 'Provider title',
      snippet: 'Provider proprietary excerpt content.',
      evidence_kind: 'provider_excerpt'
    }
  ]
})
const activity = (result: WebResult): PersistedToolActivity => ({
  id: `${result.operation}-activity`,
  kind: 'tool',
  appOwned: true,
  title: `mcp__open_science_web__web_${result.operation}`,
  providerToolName: `mcp__open_science_web__web_${result.operation}`,
  executionInvocationId: result.invocation_id,
  status: 'completed',
  sortIndex: 0,
  eventIds: [],
  createdAt: 1,
  updatedAt: 2,
  webInvocation: { attempt: 1, configGeneration: 'generation', retryEligible: true },
  rawInput: result.request,
  rawOutput: { structuredContent: result },
  toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
})
const session = (...results: WebResult[]): PersistedChatSession => {
  const activities = results.map(activity)
  return {
    id: 'session',
    projectId: 'project',
    title: 'Study',
    cwd: '',
    status: 'idle',
    messages: [],
    activities,
    createdAt: 1,
    updatedAt: 2,
    conversationGraph: (() => {
      const graph = createLinearConversationGraph({
        sessionId: 'session',
        createdAt: 1,
        updatedAt: 2,
        messages: []
      })
      graph.activities = activities.map((activity) => ({
        ...activity,
        agentFrameId: graph.rootFrameId,
        messageBranchId: graph.branches[0].id,
        runtimeSegmentId: graph.runtimeSegments[0].id,
        promptMessageId: 'prompt'
      }))
      return graph
    })()
  }
}
const policy = (
  changes: Partial<Record<WebEvidenceComponent, WebPolicyDecision>> = {}
): HostWebDataPolicy => ({
  version: 'fixture-reviewed-v1',
  components: {
    query_history: 'allow',
    source_manifest: 'allow',
    provider_excerpt: 'allow',
    fetch_body: 'allow',
    ...changes
  }
})

const prepareAllowedFetch = (): ReturnType<typeof prepareWebEvidence> =>
  prepareWebEvidence(session(fetchResult()), {
    resolvePolicy: () => policy(),
    loadSnapshot: async () => snapshot
  })

describe('portable Web evidence policy and provenance', () => {
  it('defaults actual services to unknown and excludes all restricted copies without changing private history', async () => {
    const original = session(searchResult(), fetchResult())
    const before = structuredClone(original)
    const loadSnapshot = vi.fn(async () => snapshot)
    const projected = await prepareWebEvidence(original, { loadSnapshot })
    const serialized = JSON.stringify(projected.session)
    expect(serialized).not.toContain('private research query')
    expect(serialized).not.toContain('Provider proprietary excerpt')
    expect(serialized).not.toContain('https://example.org/')
    expect(serialized).not.toContain('Complete independent public research body')
    expect(serialized).not.toContain('private-signed-cursor')
    expect(serialized).not.toContain('retryEligible')
    expect(loadSnapshot).not.toHaveBeenCalled()
    expect(projected.webEvidence?.snapshots).toEqual([])
    expect(projected.omissions).toContainEqual({
      component: 'source_manifest',
      reason: 'policy-unknown',
      count: 2
    })
    expect(original).toEqual(before)
  })
  it('shares body independently from URL/title manifest without inventing a v1 URL or retaining query', async () => {
    const projected = await prepareWebEvidence(session(fetchResult()), {
      resolvePolicy: () => policy({ source_manifest: 'deny', query_history: 'deny' }),
      loadSnapshot: async () => snapshot
    })
    const packet = projected.webEvidence!.activities[0]
    expect(packet.document).toMatchObject({
      text: fetchResult().document!.text,
      sourceSha256: snapshot.sha256
    })
    expect(packet.document?.finalUrl).toBeUndefined()
    expect(packet.requestUrl).toBeUndefined()
    expect(packet.sources[0]?.url).toBeUndefined()
    expect(projected.webEvidence!.snapshots[0].text).toBe(body)
    expect(projected.webEvidence!.snapshots[0].finalUrl).toBeUndefined()
    expect(JSON.stringify(projected.webEvidence)).not.toContain('https://')
    expect(validatePackageWebEvidence(projected.webEvidence)).toEqual(projected.webEvidence)
  })
  it('separates provider excerpts from manifest and query permissions', async () => {
    const projected = await prepareWebEvidence(session(searchResult()), {
      resolvePolicy: () => policy({ query_history: 'deny', provider_excerpt: 'deny' })
    })
    const packet = projected.webEvidence!.activities[0]
    expect(packet.query).toBeUndefined()
    expect(packet.sources).toEqual([
      {
        sourceId: 'search-source',
        url: 'https://example.org/search',
        title: 'Provider title',
        evidenceKind: 'provider_excerpt'
      }
    ])
    expect(packet.provenance).toMatchObject({
      origin: 'provider-search',
      providerId: 'exa',
      providerAuthMode: 'anonymous',
      policyVersion: 'fixture-reviewed-v1'
    })
    expect(packet.omissions).toContainEqual({
      component: 'provider_excerpt',
      reason: 'policy-denied',
      count: 1
    })
  })
  it('does not promote sender-reported allow decisions on forward export', async () => {
    const allowed = await prepareAllowedFetch()
    const forwarded = await prepareWebEvidence(allowed.session, {
      existingEvidence: allowed.webEvidence
    })
    expect(forwarded.webEvidence!.snapshots).toEqual([])
    expect(forwarded.webEvidence!.activities[0].document?.text).toBeUndefined()
    expect(forwarded.webEvidence!.activities[0].provenance.policyVersion).toBe(
      'web-sharing-unconfirmed-v1'
    )
  })
  it('reprojects allowed imported bodies using current host policy and preserves immutable source hashes', async () => {
    const allowed = await prepareAllowedFetch()
    const forwarded = await prepareWebEvidence(allowed.session, {
      existingEvidence: allowed.webEvidence,
      resolvePolicy: () => policy()
    })
    expect(forwarded.webEvidence!.snapshots[0]).toMatchObject({
      text: body,
      sourceSha256: snapshot.sha256,
      projectedSha256: hash(body)
    })
  })
  it('marks missing body unavailable without loading another source or fetching', async () => {
    const loadSnapshot = vi.fn(async () => undefined)
    const projected = await prepareWebEvidence(session(fetchResult()), {
      resolvePolicy: () => policy(),
      loadSnapshot
    })
    expect(loadSnapshot).toHaveBeenCalledOnce()
    expect(projected.webEvidence!.snapshots).toEqual([])
    expect(projected.omissions).toContainEqual({
      component: 'fetch_body',
      reason: 'missing',
      count: 1
    })
    expect(projected.webEvidence!.activities[0].document?.text).toBeDefined()
  })
  it('rejects body tampering and excerpt tampering while preserving old packages/future extensions', async () => {
    const projected = await prepareAllowedFetch()
    const tampered = structuredClone(projected.webEvidence!)
    tampered.snapshots[0].text += 'tampered'
    expect(() => validatePackageWebEvidence(tampered)).toThrow(/integrity/)
    const excerpt = structuredClone(projected.webEvidence!)
    excerpt.activities[0].document!.text += 'tampered'
    expect(() => validatePackageWebEvidence(excerpt)).toThrow(/integrity/)
    expect(parsePackageWebEvidence(undefined)).toBeUndefined()
    expect(parsePackageWebEvidence({ version: 2, arbitrary: true })).toBeUndefined()
    expect(parsePackageWebEvidence({ ...projected.webEvidence!, futureExtension: true })).toEqual(
      projected.webEvidence
    )
  })
  it('redacts credentials in a separate body projection and hashes projected bytes without changing original hash', async () => {
    const secretBody = 'Research data\napi_key=private-secret-value\nEnd'
    const rawSnapshot = { ...snapshot, text: secretBody, sha256: hash(secretBody) }
    const result = fetchResult()
    result.document!.sha256 = rawSnapshot.sha256
    result.document!.text = secretBody
    const projected = await prepareWebEvidence(session(result), {
      resolvePolicy: () => policy(),
      loadSnapshot: async () => rawSnapshot
    })
    const portable = projected.webEvidence!.snapshots[0]
    expect(portable.text).not.toContain('private-secret-value')
    expect(portable.sourceSha256).toBe(hash(secretBody))
    expect(portable.projectedSha256).toBe(hash(portable.text))
    expect(rawSnapshot.text).toBe(secretBody)
  })
  it('projects structured checkpoint/receipt copies and blocks opaque execution copies even with sensitive override', async () => {
    const result = searchResult()
    const projected = await prepareWebEvidence(session(result))
    const derived = {
      checkpoint: JSON.stringify({
        messages: [
          { invocationId: result.invocation_id, content: [{ text: JSON.stringify(result) }] }
        ]
      }),
      receipt: { result: { structuredContent: result } }
    }
    const safe = projectWebDerivedValue(derived, projected.plan)
    expect(JSON.stringify(safe)).not.toContain('private research query')
    expect(JSON.stringify(safe)).not.toContain('Provider proprietary excerpt')
    expect(() => assertWebDerivedTextSafe(JSON.stringify(derived), projected.plan)).toThrow(
      /sharing policy/
    )
    expect(() =>
      assertWebDerivedTextSafe('An ordinary author-written research note', projected.plan)
    ).not.toThrow()
  })
  it('allocates durable distinct local identities before explicit JSON/activity remapping and never grants live execution', async () => {
    const original = session(fetchResult(), searchResult())
    const projected = await prepareWebEvidence(original, {
      resolvePolicy: () => policy(),
      loadSnapshot: async () => snapshot
    })
    const ids: Record<string, string> = { project: 'local-project', session: 'local-session' }
    let sequence = 0
    allocateWebEvidenceIdentities(projected.webEvidence, ids, () => `local-${++sequence}`)
    const count = sequence
    allocateWebEvidenceIdentities(projected.webEvidence, ids, () => `unused-${++sequence}`)
    expect(sequence).toBe(count)
    const mapped = structuredClone(original)
    for (const a of mapped.activities!) a.id = ids[a.id]
    for (const a of mapped.conversationGraph!.activities) a.id = ids[a.id]
    const imported = remapWebEvidence(original, mapped, projected.webEvidence, ids)
    const packet = imported.session.activities![0].packageWebEvidence!
    expect(packet.invocationId).toBe(ids['fetch-original'])
    expect(packet.document?.snapshotId).toBe(ids['snapshot-original'])
    expect(packet.sources[0].sourceId).toBe(ids['source-original'])
    expect(imported.session.activities![0].toolContent).toBeUndefined()
    expect(imported.session.activities![0].webInvocation?.retryEligible).toBeUndefined()
    expect(imported.webEvidence!.snapshots[0].projectedSha256).toBe(hash(body))
    expect(JSON.stringify(imported)).not.toContain('private-signed-cursor')
  })
  it('preserves legacy external tool activity details', async () => {
    const external = activity(searchResult())
    delete external.appOwned
    external.providerToolName = 'mcp__other__web_search'
    const original = session()
    original.activities = [external]
    const projected = await prepareWebEvidence(original)
    expect(projected.session.activities).toEqual([external])
    expect(projected.webEvidence).toBeUndefined()
  })
  it('preserves unrelated formatted JSON strings inside immutable evidence', async () => {
    const projected = await prepareWebEvidence(session(searchResult()))
    const unrelated = JSON.stringify({ payload: '{ "unrelated": 1 }' }, null, 2)
    expect(projectWebDerivedValue(unrelated, projected.plan)).toBe(unrelated)
    expect(() => assertWebDerivedTextSafe(unrelated, projected.plan)).not.toThrow()
  })
  it('retains an omission-only projection for incomplete host history and removes derived copies', async () => {
    const original = session(searchResult())
    for (const row of [...original.activities!, ...original.conversationGraph!.activities]) {
      delete row.executionInvocationId
      delete row.rawOutput
      delete row.toolContent
    }
    const projected = await prepareWebEvidence(original)
    expect(projected.webEvidence?.activities).toEqual([])
    expect(projected.omissions).toContainEqual({
      component: 'query_history',
      reason: 'invalid',
      count: 1
    })
    expect(projected.session.activities![0].rawInput).toBeUndefined()
    expect(projected.plan.restrictedText.get(original.activities![0].id)).toContain(
      'private research query'
    )
    expect(projectWebDerivedValue(original.activities![0], projected.plan)).not.toHaveProperty(
      'rawInput'
    )
    expect(() =>
      assertWebDerivedTextSafe(JSON.stringify(original.activities![0]), projected.plan)
    ).toThrow()
    expect(original.activities![0].rawInput).toEqual({ query: 'private research query' })
  })
  it('projects failed request journals without changing their function-call shape', async () => {
    const original = session(searchResult())
    for (const row of [...original.activities!, ...original.conversationGraph!.activities]) {
      delete row.rawOutput
      delete row.toolContent
      row.status = 'failed'
    }
    const projected = await prepareWebEvidence(original)
    expect(projected.plan.restrictedText.get('search-original')).toContain('private research query')
    const journal = {
      tool_calls: [
        {
          id: 'search-original',
          type: 'function',
          function: {
            name: 'mcp__open_science_web__web_search',
            arguments: JSON.stringify({ query: 'private research query' })
          }
        }
      ]
    }
    expect(projectWebDerivedValue(journal, projected.plan)).toEqual({
      tool_calls: [
        {
          ...journal.tool_calls[0],
          function: { ...journal.tool_calls[0].function, arguments: '{}' }
        }
      ]
    })
    const external = structuredClone(journal)
    external.tool_calls[0].function.name = 'mcp__external__web_search'
    expect(projectWebDerivedValue(external, projected.plan)).toEqual(external)
    const allowed = await prepareWebEvidence(original, { resolvePolicy: () => policy() })
    expect(projectWebDerivedValue(journal, allowed.plan)).toEqual(journal)
  })
  it('drops unvalidated inline packets when records are absent or do not match', async () => {
    const projected = await prepareAllowedFetch()
    const forged = structuredClone(projected.session)
    for (const row of [...forged.activities!, ...forged.conversationGraph!.activities]) {
      row.packageWebEvidence!.document!.text = 'TAMPERED BODY'
      row.packageWebEvidence!.document!.projectedSha256 = '0'.repeat(64)
    }
    for (const records of [
      undefined,
      { version: 1 as const, activities: [], snapshots: [], omissions: [] }
    ]) {
      const imported = remapWebEvidence(forged, forged, records, {}).session
      expect(JSON.stringify(imported)).not.toContain('TAMPERED BODY')
      expect(imported.activities![0].packageWebEvidence).toBeUndefined()
      expect(imported.activities![0].webInvocation?.retryEligible).not.toBe(true)
    }
  })
  it('drops stored orphan evidence on forward export even when no Web activity survives', async () => {
    const allowed = await prepareAllowedFetch()
    const forwarded = await prepareWebEvidence(session(), { existingEvidence: allowed.webEvidence })
    expect(forwarded.webEvidence).toMatchObject({ activities: [], snapshots: [] })
    expect(forwarded.omissions).toContainEqual({
      component: 'fetch_body',
      reason: 'invalid',
      count: 1
    })
    expect(JSON.stringify(forwarded.webEvidence)).not.toContain(body)
    expect(forwarded.plan.restrictedText.get('fetch-original')).toContain(body)
    const receipt = { invocationId: 'fetch-original', output: body }
    expect(projectWebDerivedValue(receipt, forwarded.plan)).toMatchObject({ status: 'unavailable' })
    expect(() => assertWebDerivedTextSafe(JSON.stringify(receipt), forwarded.plan)).toThrow()
  })
  it('rejects mismatched operation/provenance, unbound bodies, source identity duplicates and undeclared missing bodies', async () => {
    const projected = await prepareAllowedFetch()
    const original = projected.webEvidence!
    const operation = structuredClone(original)
    operation.activities[0].operation = 'search'
    expect(() => validatePackageWebEvidence(operation)).toThrow(/provenance/)
    const provenance = structuredClone(original)
    provenance.snapshots[0].provenance.policyVersion = 'sender-invented'
    expect(() => validatePackageWebEvidence(provenance)).toThrow(/provenance/)
    const unbound = structuredClone(original)
    unbound.activities = []
    expect(() => validatePackageWebEvidence(unbound)).toThrow(/Unbound/)
    const missing = structuredClone(original)
    missing.snapshots = []
    expect(() => validatePackageWebEvidence(missing)).toThrow(/Missing/)
    const duplicate = structuredClone(original)
    duplicate.activities[0].sources.push({ ...duplicate.activities[0].sources[0] })
    expect(() => validatePackageWebEvidence(duplicate)).toThrow(/source identity/)
  })
  it('retains current evidence while safely dropping future packet versions and harmless nested extension fields', async () => {
    const projected = await prepareAllowedFetch()
    const future = structuredClone(projected.webEvidence!) as unknown as Record<string, unknown>
    const activities = future.activities as Array<Record<string, unknown>>
    activities[0].harmlessExtension = true
    activities.push({ schema: 'open-science.package-web.v2', unknown: true })
    expect(parsePackageWebEvidence(future)).toEqual(projected.webEvidence)
  })
  it('accepts host-owned hyphen MCP identity and rejects title-only identity', async () => {
    const original = session(searchResult())
    for (const activity of [...original.activities!, ...original.conversationGraph!.activities])
      activity.providerToolName = 'mcp__open-science-web__web_search'
    expect((await prepareWebEvidence(original)).webEvidence?.activities).toHaveLength(1)
    for (const activity of [...original.activities!, ...original.conversationGraph!.activities])
      delete activity.providerToolName
    expect((await prepareWebEvidence(original)).webEvidence).toBeUndefined()
  })
})

describe('v2 portable provider evidence', () => {
  const native = (): WebResult => ({
    ...searchResult(),
    schema: 'open-science.web.v2',
    provider: {
      id: 'openai',
      auth_mode: 'platform',
      data_policy_version: 'openai-responses-account-2026-11-17'
    },
    routing: {
      mode: 'auto',
      requested_target: 'auto',
      selected_target: 'current_model',
      config_revision: 7
    },
    attempts: [
      {
        index: 1,
        provider: {
          id: 'openai',
          auth_mode: 'platform',
          data_policy_version: 'openai-responses-account-2026-11-17'
        },
        execution: 'model_search',
        model_service_id: 'sender-service-reference',
        model: 'fixture-model',
        protocol: 'responses',
        started_at: now,
        duration_ms: 3,
        status: 'ok',
        search_executed: true,
        usage: { input_tokens: 13, output_tokens: 5, search_requests: 1 }
      }
    ],
    sources: [
      {
        source_id: 'native-citation',
        url: 'https://example.org/native',
        title: 'Native source',
        snippet: 'NATIVE QUOTE MUST NOT SHARE',
        evidence_kind: 'provider_citation',
        attempt_index: 1
      }
    ],
    synthesis: { text: 'Original model synthesis.', kind: 'model_synthesis', attempt_index: 1 }
  })
  it('corroborates Exa attribution before forwarding v2 search metadata', async () => {
    const provider = {
      id: 'exa',
      auth_mode: 'anonymous',
      data_policy_version: 'exa-anonymous-reviewed-2026-11-17'
    } as const
    const result = searchResult()
    const foreign = native().attempts![0]
    const direct = {
      index: 1,
      provider,
      execution: 'direct_search',
      started_at: now
    } as const
    const settled = { ...direct, status: 'ok', search_executed: true, duration_ms: 3 } as const
    result.provider = provider
    const legacy = await prepareWebEvidence(session(result), {
      resolvePolicy: resolveReviewedWebPolicy
    })
    result.schema = 'open-science.web.v2'
    result.attempts = [settled]
    result.sources[0].attempt_index = 1
    const input = session(result)
    const exported = (await prepareWebEvidence(input, { resolvePolicy: resolveReviewedWebPolicy }))
      .webEvidence!
    const forward = async (
      evidence: typeof exported,
      original = input
    ): Promise<(typeof exported)['activities'][number]> =>
      (
        await prepareWebEvidence(original, {
          existingEvidence: evidence,
          resolvePolicy: resolveReviewedWebPolicy
        })
      ).webEvidence!.activities[0]

    const attribution = {
      query: 'private research query',
      sources: [{ url: result.sources[0].url }]
    }
    expect(await forward(legacy.webEvidence!, legacy.session)).toMatchObject(attribution)
    exported.activities[0].dispatches = [direct]
    expect(await forward(exported)).toMatchObject(attribution)

    const wrongDispatch = structuredClone(exported)
    wrongDispatch.activities[0].dispatches![0].provider = foreign.provider
    const wrongSource = structuredClone(exported)
    delete wrongSource.activities[0].dispatches
    wrongSource.activities[0].attempts = [foreign, { ...settled, index: 2 }]
    for (const evidence of [wrongDispatch, wrongSource]) {
      const forwarded = await forward(evidence)
      expect(forwarded.query).toBeUndefined()
      expect(forwarded.sources).toEqual([])
      expect(forwarded.provenance.policyVersion).toBe('web-sharing-unconfirmed-v1')
    }
  })
  it('requires a distinct reader capability for new operation protocols', async () => {
    const result = native()
    result.attempts![0].protocol = 'conversations'
    const projected = await prepareWebEvidence(session(result), {
      resolvePolicy: resolveReviewedWebPolicy
    })
    const evidence = projected.webEvidence!
    expect(evidence.requiredCapabilities).toContain('web-search-operations-v1')
    expect(evidence.activities[0].minReaderVersion).toBe(3)
    expect(validatePackageWebEvidence(evidence)).toEqual(evidence)
    expect(() =>
      validatePackageWebEvidence({ ...evidence, requiredCapabilities: ['web-result-v2'] })
    ).toThrow('operation protocol')
  })
  it('exports restricted results as metadata only with explicit minimum-reader declaration', async () => {
    const result = native()
    result.schema = 'open-science.web.v3'
    result.result_kind = 'restricted_grounded_result'
    result.presentation = {
      status: 'presentation_only',
      handle: 'volatile_handle_12345678',
      expires_at: '2027-01-01T00:00:00.000Z'
    }
    result.sources = []
    delete result.returned_count
    delete result.synthesis
    result.attempts![0].protocol = 'google-generate-content'
    const projected = await prepareWebEvidence(session(result), {
      resolvePolicy: resolveReviewedWebPolicy
    })
    const evidence = projected.webEvidence!
    expect(evidence.requiredCapabilities).toEqual([
      'web-result-v2',
      'web-restricted-result-v1',
      'web-search-operations-v1'
    ])
    expect(evidence.activities[0]).toMatchObject({
      sourceSchema: 'open-science.web.v3',
      minReaderVersion: 3,
      resultKind: 'restricted_grounded_result',
      presentationStatus: 'presentation_only',
      sources: []
    })
    expect(JSON.stringify(projected.session)).not.toContain('volatile_handle')
    expect(validatePackageWebEvidence(evidence)).toEqual(evidence)
    expect(() =>
      validatePackageWebEvidence({
        ...evidence,
        requiredCapabilities: ['web-result-v2', 'web-search-operations-v1']
      })
    ).toThrow('metadata only')
  })
  it('omits old native synthesis and excerpts without erasing private history', async () => {
    const input = session(native())
    const before = structuredClone(input)
    const projected = await prepareWebEvidence(input, { resolvePolicy: resolveReviewedWebPolicy })
    const packet = projected.webEvidence!.activities[0]
    expect(packet.synthesis).toBeUndefined()
    expect(packet.sources).toEqual([])
    expect(packet.attempts![0].model_service_id).toBeUndefined()
    expect(projected.omissions).toContainEqual({
      component: 'model_synthesis',
      reason: 'policy-unknown',
      count: 1
    })
    const echo = 'The run returned Original model synthesis. during analysis.'
    expect(projectWebDerivedValue({ content: echo }, projected.plan).content).toBe(
      'The run returned  during analysis.'
    )
    expect(() => assertWebDerivedTextSafe(echo, projected.plan)).toThrow()
    expect(JSON.stringify(projected.session)).not.toContain('Original model synthesis.')
    expect(JSON.stringify(projected.session)).not.toContain('NATIVE QUOTE MUST NOT SHARE')
    expect(input).toEqual(before)
  })
})

it('removes disallowed model echoes without an invocation marker and detects untagged attachments', async () => {
  const projected = await prepareWebEvidence(session(searchResult()))
  const echoed = 'The model echoed Provider proprietary excerpt content. in an ordinary answer.'
  const safe = projectWebDerivedValue(
    { content: echoed, checkpoint: JSON.stringify({ output: echoed }) },
    projected.plan
  )
  expect(JSON.stringify(safe)).not.toContain('Provider proprietary excerpt content.')
  expect(() => assertWebDerivedTextSafe(echoed, projected.plan)).toThrow()
})

it('never strips common queries from structural identities, roles or unrelated text', async () => {
  const envelope = searchResult()
  envelope.request = { query: 'a' }
  envelope.sources = []
  const projected = await prepareWebEvidence(session(envelope))
  const unrelated = {
    id: 'session-a',
    title: 'Data analysis',
    messages: [{ id: 'answer', role: 'agent', content: 'Data analysis' }]
  }
  expect(projectWebDerivedValue(unrelated, projected.plan)).toEqual(unrelated)
  const external = { rawOutput: { id: 'a', data: [{ role: 'a', amount: 1 }] } }
  expect(projectWebDerivedValue(external, projected.plan, true)).toEqual(external)
  expect(() => assertWebDerivedTextSafe(JSON.stringify(unrelated), projected.plan)).not.toThrow()
})

it('omits a complete short restricted echo from display text while keeping incidental substrings', async () => {
  const result = searchResult()
  result.sources[0].snippet = 'Unique excerpt 123456'
  const projected = await prepareWebEvidence(session(result))
  expect(
    projectWebDerivedValue(
      { messages: [{ role: 'agent', content: 'Unique excerpt 123456' }] },
      projected.plan
    )
  ).toEqual({ messages: [{ role: 'agent', content: '' }] })
  expect(() => assertWebDerivedTextSafe('Unique excerpt 123456', projected.plan)).toThrow()
})

it('exports cancelled dispatch identity as unavailable evidence without inventing a settlement or sender authority', async () => {
  const input = session(searchResult())
  for (const row of [...input.activities!, ...input.conversationGraph!.activities]) {
    delete row.rawOutput
    delete row.toolContent
    row.status = 'failed'
    row.webInvocation = {
      attempt: 1,
      configGeneration: 'private',
      searchDispatches: [
        {
          index: 1,
          provider: {
            id: 'openai',
            auth_mode: 'platform',
            data_policy_version: 'openai-responses-account-2026-11-17'
          },
          execution: 'model_search',
          model_service_id: 'sender-service',
          started_at: now
        }
      ]
    }
  }
  const packet = (await prepareWebEvidence(input)).webEvidence!.activities[0]
  expect(packet).toMatchObject({
    sourceSchema: 'open-science.web.v2',
    status: 'unavailable',
    attempts: [],
    dispatches: [{ index: 1, execution: 'model_search' }]
  })
  expect(packet.dispatches![0].model_service_id).toBeUndefined()
  expect(JSON.stringify(packet)).not.toContain('sender-service')
})

describe('first-release Web sharing policy', () => {
  const exa = {
    origin: 'provider-search' as const,
    providerId: 'exa',
    providerAuthMode: 'anonymous' as const,
    recordedPolicyVersion: 'exa-anonymous-reviewed-2026-11-17'
  }

  it('allows attribution for exact Exa and independent fetch without allowing excerpts or bodies', () => {
    const allowed = {
      query_history: 'allow',
      source_manifest: 'allow',
      provider_excerpt: 'unknown',
      fetch_body: 'unknown'
    }
    expect(resolveReviewedWebPolicy(exa).components).toEqual(allowed)
    expect(resolveReviewedWebPolicy({ origin: 'independent-fetch' }).components).toEqual(allowed)
  })

  it.each([
    { providerId: 'another-provider' },
    { providerAuthMode: 'api_key' as const },
    { recordedPolicyVersion: 'another-version' }
  ])('does not inherit Exa sharing rights when identity differs by %j', (change) => {
    expect(Object.values(resolveReviewedWebPolicy({ ...exa, ...change }).components)).not.toContain(
      'allow'
    )
  })
})

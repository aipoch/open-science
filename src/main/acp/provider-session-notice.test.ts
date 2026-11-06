import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

import type { SessionNotification } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import { normalizeProviderSessionNotice } from './provider-session-notice'
import { toAcpRuntimeEvent } from './runtime-events'

const legacyWarning =
  'Warning: Falling back from WebSockets to HTTPS transport. request timed out\n\n'
const compactedNotice = "*Context compacted to fit the model's context window.*\n\n"
const noticeCapabilities = (enabled: boolean): Record<string, unknown> =>
  enabled ? { _meta: { 'open-science/provider-notice': { version: 1 } } } : {}

const notification = (
  text: string,
  meta?: Record<string, unknown>,
  messageId?: string
): SessionNotification => ({
  sessionId: 'session-notice',
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(meta ? { _meta: meta } : {}),
    ...(messageId ? { messageId } : {})
  }
})

const normalize = (source: SessionNotification, framework?: AgentFrameworkId): AcpRuntimeEvent =>
  normalizeProviderSessionNotice(source, framework, toAcpRuntimeEvent(source, 'event-notice', 42))

// Frozen original @openma/pi-acp 0.1.8 producer branches. No bootstrap rewrite is involved.
const piNoticeProducers = `function retry(event) { switch(event.type) {
      case "auto_retry_start": {
        const seconds = Math.max(1, Math.round(event.delayMs / 1e3));
        return [
          {
            sessionUpdate: "session_info_update",
            _meta: piMeta({
              event: "auto_retry",
              phase: "start",
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              error: event.errorMessage
            })
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: \`
_Retrying (attempt \${event.attempt}/\${event.maxAttempts}, waiting \${seconds}s): \${event.errorMessage}_
\`
            },
            _meta: piMeta({ notice: "auto_retry" })
          }
        ];
      }
} }
const ui = {
    notify(message, type) {
      emit({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: \`
> \${type === "error" ? "\\u26A0 " : type === "warning" ? "! " : ""}\${message}
\`
        },
        _meta: piMeta({ notify: { level: type ?? "info", message } })
      });
    },
};`

describe('provider session notice provenance', () => {
  it.each([undefined, 'info', 'warning', 'error'] as const)(
    'bridges the original Pi retry and notify producers without rewriting the adapter: %s',
    (level) => {
      const updates: SessionNotification['update'][] = []
      runInNewContext(
        `${piNoticeProducers}
         for (const update of retry({ type: 'auto_retry_start', delayMs: 1000,
           attempt: 1, maxAttempts: 3, errorMessage: 'temporary failure' })) emit(update);
         ui.notify('transport advisory', level);`,
        {
          piMeta: (pi: unknown) => ({ pi }),
          emit: (update: SessionNotification['update']) => updates.push(update),
          level
        },
        { timeout: 1000 }
      )
      expect(updates).toHaveLength(3)
      expect(updates[0]).toMatchObject({
        sessionUpdate: 'session_info_update',
        _meta: { pi: { event: 'auto_retry', phase: 'start' } }
      })
      expect(updates[1]._meta).toEqual({ pi: { notice: 'auto_retry' } })
      expect(updates[2]._meta).toEqual({
        pi: { notify: { level: level ?? 'info', message: 'transport advisory' } }
      })
      const sources = updates.slice(1).map((update) => ({ sessionId: 'session-notice', update }))
      const events = sources.map((source) => normalize(source, 'pi'))
      const json = normalize(notification('{"question":null}'), 'pi')
      const collect = (values: AcpRuntimeEvent[]): string =>
        values
          .filter((event) => event.kind === 'message')
          .map((event) => event.text)
          .join('')
      expect(JSON.parse(collect([...events, json]))).toEqual({ question: null })
      expect(events[0]).toMatchObject({
        kind: 'system',
        status: 'provider-notice',
        level: 'warning'
      })
      expect(events[1]).toMatchObject({
        kind: 'system',
        status: 'provider-notice',
        level: level ?? 'info'
      })
      for (const source of sources) {
        // These producers have no canonical marker. Identical words without their provenance
        // are model content, even when ordinary Pi model metadata is present.
        const model = { ...source, update: { ...source.update, _meta: { pi: { model: 'p/m' } } } }
        const modelEvent = toAcpRuntimeEvent(model, 'pi-model', 42)
        expect(normalizeProviderSessionNotice(model, 'pi', modelEvent)).toBe(modelEvent)
        for (const framework of [
          'codex',
          'codebuddy',
          'claude-code',
          'opencode',
          undefined
        ] as const)
          expect(normalize(source, framework).kind).toBe('message')
      }
    }
  )

  it.each([
    { pi: { notice: 'unknown' } },
    { pi: { notice: 'auto_retry', failure: 'fatal' } },
    { pi: { notice: 'auto_retry' }, failure: true },
    { pi: { notify: { level: 'fatal', message: 'failure' } } },
    { pi: { notify: { level: 'warning' } } },
    { pi: { notify: { level: 'warning', message: 1 } } },
    { pi: { notify: { level: 'warning', message: 'failure', stopped: true } } },
    { pi: { notify: { level: 'error', message: 'failure' }, cancelled: true } },
    { pi: { event: 'failure', kind: 'auth_required', message: 'failure' } },
    { pi: { event: 'auto_retry', phase: 'end', success: false, error: 'failure' } },
    { pi: { event: 'assistant_message', stopReason: 'aborted' } }
  ])('preserves unknown and terminal Pi metadata %j', (meta) => {
    const source = notification('Provider or model text', meta)
    const event = toAcpRuntimeEvent(source, 'pi-unknown', 42)
    expect(normalizeProviderSessionNotice(source, 'pi', event)).toBe(event)
  })

  it('gives canonical metadata precedence over the Pi bridge and preserves identified content', () => {
    for (const marker of [{ version: 2, level: 'warning' }, false]) {
      const source = notification('Pi notice', {
        pi: { notice: 'auto_retry' },
        'open-science/provider-notice': marker
      })
      expect(normalize(source, 'pi').kind).toBe('message')
    }
    expect(
      normalize(
        notification('Pi notice', {
          pi: { notice: 'auto_retry' },
          'open-science/provider-notice': { version: 1, level: 'info' }
        }),
        'pi'
      )
    ).toMatchObject({ kind: 'system', level: 'info' })
    expect(
      normalize(notification('Model text', { pi: { notice: 'auto_retry' } }, 'model'), 'pi').kind
    ).toBe('message')
    for (const pi of [
      { event: 'failure', kind: 'auth_required', message: 'failure' },
      { event: 'auto_retry', phase: 'end', success: false, error: 'failure' },
      { event: 'assistant_message', stopReason: 'aborted' }
    ]) {
      const source: SessionNotification = {
        sessionId: 'session-notice',
        update: { sessionUpdate: 'session_info_update', _meta: { pi } }
      }
      const event = toAcpRuntimeEvent(source, 'pi-terminal', 42)
      expect(normalizeProviderSessionNotice(source, 'pi', event)).toBe(event)
    }
  })

  it.each(
    (
      [
        ['info', 'SDK informational detail', 'info', false],
        ['notice', '**Notice:** SDK informational detail', 'info', false],
        ['suggestion', '**Suggestion:** SDK informational detail', 'info', false],
        ['warning', '**Warning:** SDK informational detail', 'warning', false],
        ['info', 'SDK informational detail', 'info', true],
        ['notice', '**Notice:** SDK informational detail', 'info', true],
        ['suggestion', '**Suggestion:** SDK informational detail', 'info', true],
        ['warning', '**Warning:** SDK informational detail', 'warning', true]
      ] as const
    ).flatMap(([level, expectedText, expectedLevel, preventsContinuation]) =>
      [false, true].map((negotiated) => ({
        level,
        expectedText,
        expectedLevel,
        preventsContinuation,
        negotiated
      }))
    )
  )(
    'preserves Claude SDK $level notices (blocking=$preventsContinuation, negotiated=$negotiated)',
    async ({ level, expectedText, expectedLevel, preventsContinuation, negotiated }) => {
      // Execute the installed adapter's real branch with only its two local inputs. This neither
      // imports the SDK nor creates a session; source-shape changes must trigger test review.
      const require = createRequire(import.meta.url)
      const source = readFileSync(
        require.resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'),
        'utf8'
      )
      const start = source.indexOf('case "informational": {')
      const end = source.indexOf('case "hook_started":', start)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      const produce = runInNewContext(
        `(async function(message, sendUpdate) { switch (message.subtype) { ${source.slice(start, end)} } })`,
        Object.create(null),
        { timeout: 1000 }
      ) as (
        message: {
          subtype: string
          session_id: string
          level: string
          content: string
          prevent_continuation: boolean
        },
        sendUpdate: (notification: SessionNotification) => Promise<void>
      ) => Promise<void>
      const sent: SessionNotification[] = []

      await produce.call(
        { clientCapabilities: noticeCapabilities(negotiated) },
        {
          subtype: 'informational',
          session_id: 'session-producer',
          level,
          content: 'SDK informational detail',
          prevent_continuation: preventsContinuation
        },
        async (notification) => {
          sent.push(notification)
        }
      )

      expect(sent).toEqual([
        {
          sessionId: 'session-producer',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: expectedText },
            ...(negotiated && !preventsContinuation
              ? { _meta: { 'open-science/provider-notice': { version: 1, level: expectedLevel } } }
              : {})
          }
        }
      ])
      const event = normalize(sent[0]!, 'claude-code')
      if (preventsContinuation || !negotiated) {
        expect(event).toMatchObject({ kind: 'message', role: 'assistant', text: expectedText })
        expect(event.status).not.toBe('provider-notice')
        // A preceding partial JSON answer must not hide the SDK's blocking feedback.
        const collected = [normalize(notification('{"question":null}')), event]
          .filter((value) => value.kind === 'message')
          .map((value) => value.text)
          .join('')
        expect(() => JSON.parse(collected)).toThrow(SyntaxError)
      } else
        expect(event).toMatchObject({
          kind: 'system',
          status: 'provider-notice',
          level: expectedLevel,
          text: expectedText
        })
    }
  )

  it.each([
    { typed: false, negotiated: false },
    { typed: false, negotiated: true },
    { typed: true, negotiated: false },
    { typed: true, negotiated: true }
  ])(
    'preserves Claude model fallback routing (typed=$typed, negotiated=$negotiated)',
    async ({ typed, negotiated }) => {
      const require = createRequire(import.meta.url)
      const source = readFileSync(
        require.resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'),
        'utf8'
      )
      const start = source.indexOf('case "model_refusal_fallback": {')
      const end = source.indexOf('case "model_refusal_no_fallback":', start)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      const produce = runInNewContext(
        `(async function(message, sendUpdate, publishSessionFailure, params, session) {
          switch(message.subtype) { ${source.slice(start, end)} }
        })`,
        {
          supportsAirSessionFailures: () => typed,
          MAX_INLINE_FAILURE_TITLE_LENGTH: 200
        },
        { timeout: 1000 }
      ) as (...args: unknown[]) => Promise<void>
      const sent: SessionNotification[] = []
      const failures: unknown[][] = []
      const synced: unknown[][] = []
      await produce.call(
        {
          clientCapabilities: noticeCapabilities(negotiated),
          syncModelAfterRefusalFallback: async (...args: unknown[]) => {
            synced.push(args)
          }
        },
        {
          subtype: 'model_refusal_fallback',
          session_id: 'session-notice',
          original_model: 'first',
          fallback_model: 'second',
          direction: 'retry'
        },
        async (value: SessionNotification) => {
          sent.push(value)
        },
        async (...args: unknown[]) => {
          failures.push(args)
        },
        { sessionId: 'session-notice' },
        {}
      )
      expect(synced).toHaveLength(1)
      expect(failures).toHaveLength(typed ? 1 : 0)
      expect(sent).toHaveLength(typed ? 0 : 1)
      if (!typed) {
        const notice = normalize(sent[0]!, 'claude-code')
        expect(notice.kind).toBe(negotiated ? 'system' : 'message')
        if (!negotiated) {
          expect(sent[0]!.update._meta).toBeUndefined()
          return
        }
        expect(notice).toMatchObject({ status: 'provider-notice', level: 'warning' })
        const modelCopy = notification(
          sent[0]!.update.sessionUpdate === 'agent_message_chunk' &&
            sent[0]!.update.content.type === 'text'
            ? sent[0]!.update.content.text
            : ''
        )
        expect(normalize(modelCopy, 'claude-code').kind).toBe('message')
        const answer = [notice, normalize(notification('{"question":null}'), 'claude-code')]
          .filter((event) => event.kind === 'message')
          .map((event) => event.text)
          .join('')
        expect(JSON.parse(answer)).toEqual({ question: null })
      }
    }
  )

  it.each([false, true])(
    'scopes Claude fast-mode markers to negotiated callers: %s',
    async (negotiated) => {
      const require = createRequire(import.meta.url)
      const source = readFileSync(
        require.resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'),
        'utf8'
      )
      const start = source.indexOf('    async syncFastModeState(')
      const end = source.indexOf('    async getOrCreateSession(', start)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      // Isolate the actual method. Eligibility wording helpers are unrelated to notice routing.
      const producer = runInNewContext(
        `({ ${source.slice(start, end)} })`,
        {
          FAST_MODE_CONFIG_ID: 'fast',
          normalizeFastModeDisabledReason: (reason: string) => reason,
          FAST_MODE_UNAVAILABLE_EXPLANATIONS: { network_error: 'network unavailable' }
        },
        { timeout: 1000 }
      ) as {
        syncFastModeState: (...args: unknown[]) => Promise<void>
      }
      const sent: SessionNotification[] = []
      const session = { configOptions: [{ id: 'fast' }], fastModeEnabled: true }
      await producer.syncFastModeState.call(
        {
          clientCapabilities: noticeCapabilities(negotiated),
          client: {
            sessionUpdate: async (value: SessionNotification) => {
              sent.push(value)
            }
          },
          refreshFastModeOption: () => undefined
        },
        'session-notice',
        session,
        'off',
        'network_error'
      )
      expect(session.fastModeEnabled).toBe(false)
      expect(sent).toHaveLength(2)
      expect(sent[1]!.update.sessionUpdate).toBe('config_option_update')
      const notice = normalize(sent[0]!, 'claude-code')
      if (!negotiated) {
        expect(sent[0]!.update._meta).toBeUndefined()
        expect(notice.kind).toBe('message')
        return
      }
      expect(notice).toMatchObject({ kind: 'system', status: 'provider-notice', level: 'warning' })
      const answer = [notice, normalize(notification('{"question":null}'), 'claude-code')]
        .filter((event) => event.kind === 'message')
        .map((event) => event.text)
        .join('')
      expect(JSON.parse(answer)).toEqual({ question: null })
    }
  )

  // Frozen protocol shape from the verified CodeBuddy 2.138.0 createHookMessage ->
  // convertHistoryItemToAcp reproduction. No downloaded CLI or network is needed in CI.
  const codeBuddyHook = (status: string): SessionNotification =>
    notification(
      'Hook diagnostic',
      {
        'codebuddy.ai/messageId': 'hook-message',
        'codebuddy.ai/hook': {
          event: 'UserPromptSubmit',
          status,
          exitCode: status === 'success' ? 0 : 1
        }
      },
      'hook-message'
    )

  it.each(['success', 'warning'])(
    'separates captured CodeBuddy %s hooks from JSON without guessing the body',
    (status) => {
      const source = codeBuddyHook(status)
      const before = structuredClone(source)
      const notice = normalize(source, 'codebuddy')
      expect(notice).toMatchObject({
        kind: 'system',
        status: 'provider-notice',
        level: status === 'success' ? 'info' : 'warning'
      })
      const answer = [notice, normalize(notification('{"question":null}'), 'codebuddy')]
        .filter((event) => event.kind === 'message')
        .map((event) => event.text)
        .join('')
      expect(JSON.parse(answer)).toEqual({ question: null })
      expect(source).toEqual(before)
      expect(normalize(notification('Hook diagnostic'), 'codebuddy').kind).toBe('message')
    }
  )

  it.each([
    ['error hook', { status: 'error' }],
    ['blocked hook', { status: 'blocked' }],
    ['unknown status', { status: 'pending' }],
    ['stopped hook', { status: 'warning', stopped: true }],
    ['explicit stopped field', { status: 'success', stopped: false }],
    ['blocking hook', { status: 'warning', blocking: [{ reason: 'Denied' }] }],
    ['explicit blocking field', { status: 'success', blocking: [] }],
    ['malformed hook', 'warning']
  ])('preserves CodeBuddy %s instead of swallowing a failure', (_name, hook) => {
    const source = notification(
      'Hook diagnostic',
      {
        'codebuddy.ai/messageId': 'hook-message',
        'codebuddy.ai/hook': hook
      },
      'hook-message'
    )
    expect(normalize(source, 'codebuddy').kind).toBe('message')
  })

  it.each([
    'codebuddy.ai/businessFailed',
    'codebuddy.ai/contentFilterNotice',
    'codebuddy.ai/isCompactInternal',
    'codebuddy.ai/compact-limit-reached',
    'codebuddy.ai/compact-cancelled',
    'codebuddy.ai/cancelReason',
    'codebuddy.ai/terminationReason',
    'codebuddy.ai/errorMessage'
  ])('preserves CodeBuddy terminal metadata %s on a hook-shaped message', (key) => {
    const source = codeBuddyHook('warning')
    source.update._meta = { ...source.update._meta, [key]: true }
    expect(normalize(source, 'codebuddy').kind).toBe('message')
  })

  it('requires CodeBuddy producer identity and gives canonical metadata precedence', () => {
    const source = codeBuddyHook('warning')
    for (const framework of ['codex', 'claude-code', 'opencode', 'pi', undefined] as const)
      expect(normalize(source, framework).kind).toBe('message')
    for (const messageId of ['', undefined, 'other']) {
      const mismatch = structuredClone(source)
      if (mismatch.update.sessionUpdate === 'agent_message_chunk')
        mismatch.update.messageId = messageId
      expect(normalize(mismatch, 'codebuddy').kind).toBe('message')
    }
    const malformed = structuredClone(source)
    malformed.update._meta = {
      ...source.update._meta,
      'open-science/provider-notice': { version: 2, level: 'warning' }
    }
    expect(normalize(malformed, 'codebuddy').kind).toBe('message')
    const canonical = structuredClone(source)
    canonical.update._meta = {
      ...source.update._meta,
      'open-science/provider-notice': { version: 1, level: 'info' }
    }
    expect(normalize(canonical, 'codebuddy')).toMatchObject({ kind: 'system', level: 'info' })
  })

  it('classifies only the captured unscoped Codex fallback as a provider notice', () => {
    const result = normalize(notification(legacyWarning), 'codex')
    expect(result).toMatchObject({
      id: 'event-notice',
      timestamp: 42,
      sessionId: 'session-notice',
      kind: 'system',
      level: 'warning',
      status: 'provider-notice'
    })
    for (const field of ['role', 'messageId', 'raw', 'image'])
      expect(result).not.toHaveProperty(field)
  })

  it('bridges only the pinned unscoped Codex compaction banner', () => {
    expect(normalize(notification(compactedNotice), 'codex')).toMatchObject({
      kind: 'system',
      status: 'provider-notice',
      level: 'info'
    })
    for (const source of [
      notification(compactedNotice, undefined, 'model-message'),
      notification(compactedNotice, { codex: { phase: 'final_answer' } }),
      notification(compactedNotice + 'model answer'),
      notification(compactedNotice.trim())
    ]) {
      const original = toAcpRuntimeEvent(source, 'original', 42)
      expect(normalizeProviderSessionNotice(source, 'codex', original)).toBe(original)
    }
    expect(normalize(notification(compactedNotice), 'claude-code').kind).toBe('message')
  })

  it('accepts the SDK nullable metadata without treating unknown metadata as legacy provenance', () => {
    const source = notification(compactedNotice)
    source.update._meta = null
    expect(normalize(source, 'codex')).toMatchObject({ kind: 'system', level: 'info' })
    source.update._meta = { future: true }
    expect(normalize(source, 'codex').kind).toBe('message')
  })

  it.each([
    ['info', undefined],
    ['warning', undefined],
    ['error', undefined],
    ['warning', 'opencode']
  ] as const)(
    'classifies canonical %s notices using provenance (framework: %s)',
    (level, framework) => {
      const result = normalize(
        notification('Provider diagnostics', {
          'open-science/provider-notice': { version: 1, level }
        }),
        framework
      )
      expect(result).toMatchObject({ kind: 'system', level, status: 'provider-notice' })
      for (const field of ['role', 'messageId', 'raw', 'image'])
        expect(result).not.toHaveProperty(field)
    }
  )

  it.each([
    ['ordinary unscoped JSON', 'codex', '{"question":null}'],
    ['ordinary unscoped Claude JSON', 'claude-code', '{"question":null}'],
    ['different warning', 'codex', 'Warning: request timed out\n\n'],
    ['multiline model answer', 'codex', legacyWarning + 'Model answer'],
    ['changed terminator', 'codex', legacyWarning.trim()],
    ['Claude same warning', 'claude-code', legacyWarning],
    ['OpenCode same warning', 'opencode', legacyWarning],
    ['CodeBuddy same warning', 'codebuddy', legacyWarning],
    ['unknown framework same warning', undefined, legacyWarning],
    ['identified Codex message', 'codex', legacyWarning, 'model-message']
  ] as const)(
    'preserves %s without guessing its source',
    (_name, framework, text, messageId?: string) => {
      const source = notification(text, undefined, messageId)
      const original = toAcpRuntimeEvent(source, 'event-original', 42)
      expect(normalizeProviderSessionNotice(source, framework, original)).toBe(original)
    }
  )

  it.each([
    {},
    { 'open-science/provider-notice': true },
    { 'open-science/provider-notice': { version: 1 } },
    { 'open-science/provider-notice': { version: 2, level: 'warning' } },
    { 'open-science/provider-notice': { version: '1', level: 'warning' } },
    { 'open-science/provider-notice': { version: 1, level: 'fatal' } },
    { claudeCode: { isInformational: true, level: 'warning' } }
  ])('retains model text with unknown or malformed metadata %j', (meta) => {
    const source = notification('Warning: model text', meta)
    const original = toAcpRuntimeEvent(source, 'event-original', 42)
    expect(normalizeProviderSessionNotice(source, 'claude-code', original)).toBe(original)
  })

  it('preserves user content and textual copies of the marker', () => {
    const source = notification('Model answer', {
      'open-science/provider-notice': { version: 1, level: 'warning' }
    })
    const user: SessionNotification = {
      sessionId: source.sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Model answer' },
        _meta: { 'open-science/provider-notice': { version: 1, level: 'warning' } }
      }
    }
    const userEvent = toAcpRuntimeEvent(user, 'event-user', 42)
    expect(normalizeProviderSessionNotice(user, 'claude-code', userEvent)).toBe(userEvent)
    const quoted = notification(
      'Warning: {"open-science/provider-notice":{"version":1,"level":"warning"}}'
    )
    const quotedEvent = toAcpRuntimeEvent(quoted, 'event-quote', 42)
    expect(normalizeProviderSessionNotice(quoted, undefined, quotedEvent)).toBe(quotedEvent)
  })

  it('does not guess a legacy fallback when a canonical marker has an unknown version', () => {
    const source = notification(legacyWarning, {
      'open-science/provider-notice': { version: 2, level: 'warning' }
    })
    const original = toAcpRuntimeEvent(source, 'event-unknown-version', 42)
    expect(normalizeProviderSessionNotice(source, 'codex', original)).toBe(original)
  })

  it('preserves image content even when its metadata contains the canonical notice marker', () => {
    const source: SessionNotification = {
      sessionId: 'session-notice',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', mimeType: 'image/png', data: 'AQID' },
        _meta: { 'open-science/provider-notice': { version: 1, level: 'warning' } }
      }
    }
    const original = toAcpRuntimeEvent(source, 'event-image', 42)

    expect(normalizeProviderSessionNotice(source, undefined, original)).toBe(original)
    expect(original.image).toMatchObject({ mimeType: 'image/png', data: 'AQID', byteLength: 3 })
  })

  it('bounds informational text and leaves the protocol notification unchanged', () => {
    const source = notification('x'.repeat(3000), {
      'open-science/provider-notice': { version: 1, level: 'warning' }
    })
    const before = structuredClone(source)
    const result = normalize(source, 'claude-code')
    expect(result.text?.length).toBeLessThanOrEqual(2000)
    expect(source).toEqual(before)
  })

  it('preserves existing structured OpenCode compaction failure semantics', () => {
    const source: SessionNotification = {
      sessionId: 'session-notice',
      update: {
        sessionUpdate: 'session_info_update',
        _meta: {
          'opencode/compaction': {
            messageId: 'compact-one',
            reason: 'auto',
            status: 'failed'
          }
        }
      }
    }
    const original = toAcpRuntimeEvent(source, 'event-compaction', 42)
    expect(normalizeProviderSessionNotice(source, 'opencode', original)).toBe(original)
    expect(original).toMatchObject({ kind: 'compaction', level: 'error', status: 'failed' })
  })
})

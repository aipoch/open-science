import { describe, expect, it } from 'vitest'

import { describePromptError } from '../main/acp/prompt-error'
import {
  IMAGE_REPLAY_UNSUPPORTED_MESSAGE,
  PROVIDER_RESOURCE_NOT_FOUND_PREFIX,
  RESUME_MODEL_INCOMPATIBLE_MESSAGE,
  RESUME_RECONNECT_FAILED_MESSAGE,
  RESUME_TIMED_OUT_MESSAGE,
  RESUME_UNSUPPORTED_MESSAGE,
  RESUME_WORKSPACE_MISSING_MESSAGE,
  isReportableRunFailure
} from './run-error-classification'

// This module is only the SECONDARY, text-based tier: it recognizes the app's OWN crafted strings so
// their report button is hidden even without the structural `providerError` flag. Ordinary provider
// errors are suppressed by that flag (set at the ACP layer), NOT here — so at this text tier they read
// as reportable, and this suite asserts exactly that boundary.
describe('isReportableRunFailure (text tier)', () => {
  it('reports an empty or whitespace-only failure (nothing explains it)', () => {
    expect(isReportableRunFailure(undefined)).toBe(true)
    expect(isReportableRunFailure(null)).toBe(true)
    expect(isReportableRunFailure('')).toBe(true)
    expect(isReportableRunFailure('   ')).toBe(true)
  })

  it('reports an opaque / internal ACP-layer failure', () => {
    expect(isReportableRunFailure('Agent session could not be created.')).toBe(true)
    expect(isReportableRunFailure('Agent session did not return a workspace.')).toBe(true)
    expect(isReportableRunFailure('Permission response failed')).toBe(true)
    expect(isReportableRunFailure('Run failed: connection reset')).toBe(true)
    // An unrecognized resume cause keeps the generic fallback and stays reportable.
    expect(isReportableRunFailure('Agent session resume failed: something odd')).toBe(true)
  })

  it('does not report an app-crafted, actionable failure (exact-match set)', () => {
    for (const message of [
      RESUME_WORKSPACE_MISSING_MESSAGE,
      RESUME_TIMED_OUT_MESSAGE,
      RESUME_UNSUPPORTED_MESSAGE,
      RESUME_RECONNECT_FAILED_MESSAGE,
      RESUME_MODEL_INCOMPATIBLE_MESSAGE,
      IMAGE_REPLAY_UNSUPPORTED_MESSAGE
    ]) {
      expect(isReportableRunFailure(message)).toBe(false)
    }
  })

  it('does NOT recognize provider error TEXT at this tier — the structural flag suppresses those', () => {
    // These come from the model/provider and are hidden by `providerError`/`errorReportable=false`, set
    // structurally at the ACP layer. The text tier must NOT try to recognize them (that heuristic was
    // fragile and swallowed genuine app errors), so here — text only — they read as reportable.
    for (const providerText of [
      'HTTP 401 Unauthorized',
      '{"error":{"type":"authentication_error"}}',
      'Invalid API key',
      '429 Too Many Requests',
      'insufficient_quota',
      'Internal error: Overloaded: service is busy',
      '503 Service Unavailable'
    ]) {
      expect(isReportableRunFailure(providerText)).toBe(true)
    }
  })

  it('does not swallow an ordinary app error that merely mentions a provider word', () => {
    // The text tier only matches the app's own exact strings, so an internal failure that happens to
    // contain a provider-ish word or number is never mistaken for an expected failure.
    expect(isReportableRunFailure('EACCES: permission denied opening workspace')).toBe(true)
    expect(isReportableRunFailure('Failed to parse rate limit configuration')).toBe(true)
    expect(isReportableRunFailure('Record 503 could not be decoded')).toBe(true)
    expect(isReportableRunFailure('Billing planner initialization failed')).toBe(true)
    expect(isReportableRunFailure('Scheduler crashed while overloaded with tasks')).toBe(true)
  })

  it('recognizes a request-size overflow (its own recovery path) as expected', () => {
    expect(isReportableRunFailure('Request too large (max 32MB)')).toBe(false)
    expect(isReportableRunFailure('maximum context length exceeded')).toBe(false)
  })

  it('recognizes the provider resource-not-found message built by describePromptError', () => {
    // Drift guard: feed describePromptError's REAL output through the classifier so the shared prefix
    // constant and the produced message can never diverge silently. This one IS text-recognized because
    // it is the app's OWN reworded string (a model-config problem the user fixes in Settings).
    const error = Object.assign(
      new Error(
        'Internal error: Not Found: {"error":{"message":"model xyz not found","type":"resource_not_found"}}'
      ),
      { code: -32603, data: { errorName: 'APIError' }, name: 'RequestError' }
    )
    const produced = describePromptError(error, { model: 'xyz' })
    expect(produced.startsWith(PROVIDER_RESOURCE_NOT_FOUND_PREFIX)).toBe(true)
    expect(isReportableRunFailure(produced)).toBe(false)
  })
})

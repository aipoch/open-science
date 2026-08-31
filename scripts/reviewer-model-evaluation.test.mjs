import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  REVIEWER_REGRESSION_SCENARIOS,
  evaluateReviewerModelCapture,
  renderReviewerModelEvaluation,
  sealReviewerModelCapture
} from './reviewer-model-evaluation.mjs'

const fixtureUrl = new URL('../test/fixtures/reviewer-model-evaluation.json', import.meta.url)

describe('Reviewer enhancement regression gate', () => {
  it('routes every required shipping scenario through the executable protocol gate', () => {
    expect(REVIEWER_REGRESSION_SCENARIOS.map(({ id }) => id)).toEqual([
      'image-trace-only',
      'rendered-image-contradiction',
      'targeted-source-pages',
      'earlier-turn-abstention',
      'fabricated-current-turn-reference',
      'user-stop',
      'plan-completion',
      'tabular-values',
      'opaque-binary-generation'
    ])
    expect(REVIEWER_REGRESSION_SCENARIOS.map(({ testFiles }) => testFiles)).toEqual(
      Array(9).fill(['src/main/reviewer/reviewer-regression-gate.integration.test.ts'])
    )
    expect(JSON.stringify(REVIEWER_REGRESSION_SCENARIOS)).not.toMatch(
      /archive search|context drift|session-level|format-specific MCP/i
    )
  })

  it('scores the captured model gate without hiding bounded extra reads', async () => {
    const capture = JSON.parse(await readFile(fixtureUrl, 'utf8'))
    const result = evaluateReviewerModelCapture(capture)

    expect(result.semanticAccuracy).toBe(1)
    expect(result.evidenceRouteAccuracy).toBe(1)
    expect(result.providerUsage).toEqual({
      inputTokens: 38_425,
      cachedTokens: 34_624,
      outputTokens: 3_159
    })
    expect(result.totalLatencyMs).toBe(259_519)
    expect(result.extraContentReads).toEqual({ observed: 0, allowed: 1, withinBound: true })
    expect(result.rows.find(({ fixtureId }) => fixtureId === 'image-method-result')).toMatchObject({
      extraContentReads: 0,
      note: expect.stringMatching(/disclosed/i)
    })

    const report = renderReviewerModelEvaluation(capture, result)
    expect(report).toContain('100.0%')
    expect(report).toContain('38,425')
    expect(report).toContain('259,519 ms')
    expect(report).toContain('0 / 1')
    expect(report).not.toContain('.scratch')
  })

  it('fails closed when raw output is absent or a captured run is changed', async () => {
    const capture = JSON.parse(await readFile(fixtureUrl, 'utf8'))
    const missingRaw = structuredClone(capture)
    delete missingRaw.runs[0].raw
    expect(() => evaluateReviewerModelCapture(missingRaw)).toThrow(/raw\.checks/)

    const tampered = structuredClone(capture)
    tampered.runs[0].latencyMs += 1
    expect(() => evaluateReviewerModelCapture(tampered)).toThrow(/sha256/)
  })

  it('seals newly captured runs and then recomputes scores from raw checks and routes', async () => {
    const capture = JSON.parse(await readFile(fixtureUrl, 'utf8'))
    const unsealed = structuredClone(capture)
    delete unsealed.runs[0].sha256
    const resealed = sealReviewerModelCapture(unsealed)

    expect(() => evaluateReviewerModelCapture(resealed)).not.toThrow()
  })
})

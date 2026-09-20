import { describe, expect, it } from 'vitest'
import { validateArtifactSaveSource } from './save-request'
import { LOCAL_RESOURCE_BUDGETS, PendingRequestBudget } from '../resource-budget'

describe('Artifact payload admission', () => {
  it('bounds per-session and process counts and bytes, and releases rejected/cancelled payloads exactly once', () => {
    const limits = {
      ...LOCAL_RESOURCE_BUDGETS,
      artifactSaveSessionRequests: 2,
      artifactSaveProcessRequests: 3,
      artifactSaveSessionPayloadBytes: 10,
      artifactSaveProcessPayloadBytes: 15
    }
    const budget = new PendingRequestBudget(limits)
    const first = budget.acquire('one')
    first.addBytes(6)
    const second = budget.acquire('one')
    second.addBytes(4)
    expect(() => second.addBytes(1)).toThrow('ARTIFACT_SAVE_RESOURCE_LIMIT')
    expect(() => budget.acquire('one')).toThrow('ARTIFACT_SAVE_RESOURCE_LIMIT')
    const third = budget.acquire('two')
    third.addBytes(5)
    expect(() => third.addBytes(1)).toThrow('ARTIFACT_SAVE_RESOURCE_LIMIT')
    expect(() => budget.acquire('three')).toThrow('ARTIFACT_SAVE_RESOURCE_LIMIT')
    second.release()
    second.release()
    first.release()
    third.release()
    const replacement = budget.acquire('one')
    replacement.addBytes(10)
    replacement.release()
  })

  it('keeps explicit production limits and accepts the full 32 MiB decoded inline budget', () => {
    expect(LOCAL_RESOURCE_BUDGETS).toMatchObject({
      artifactSaveSessionRequests: 16,
      artifactSaveProcessRequests: 64,
      artifactSaveSessionPayloadBytes: 128 * 1024 ** 2,
      artifactSaveProcessPayloadBytes: 512 * 1024 ** 2
    })
    const content = Buffer.alloc(LOCAL_RESOURCE_BUDGETS.artifactInlineBytes).toString('base64')
    expect(() =>
      validateArtifactSaveSource({ kind: 'inline', content, encoding: 'base64' })
    ).not.toThrow()
    expect(() =>
      validateArtifactSaveSource({
        kind: 'inline',
        content: content.slice(0, -4) + 'AAAA',
        encoding: 'base64'
      })
    ).toThrow(/budget/)
  })

  it.each(['a', '====', 'a===', 'YQ=!', 'YQ==\n', 'YR=='])(
    'rejects malformed wire encoding %j before file I/O',
    (content) => {
      expect(() =>
        validateArtifactSaveSource({ kind: 'inline', content, encoding: 'base64' })
      ).toThrow(/encoding/)
    }
  )
})

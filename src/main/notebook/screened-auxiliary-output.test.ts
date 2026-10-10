import { expect, it, vi } from 'vitest'
import { screenAuxiliaryOutput } from './screened-auxiliary-output'

it.each(['plain', 'uri', 'base64'] as const)(
  'rejects %s configured credentials before optional recorded evidence is saved',
  async (encoding) => {
    const secret = 'fixture-key/+123'
    const value =
      encoding === 'plain'
        ? secret
        : encoding === 'uri'
          ? encodeURIComponent(secret)
          : Buffer.from(secret).toString('base64')
    const save = vi.fn()
    const screened = screenAuxiliaryOutput(save, [secret])
    // Exercise both textual structured-state evidence and binary inline transport.
    for (const binary of [false, true]) {
      const text = JSON.stringify({ states: [{ value: { credential: value } }] })
      expect(
        await screened({
          filename: 'project-recording.json',
          source: {
            kind: 'inline',
            content: binary ? Buffer.from(text).toString('base64') : text,
            ...(binary ? { encoding: 'base64' as const } : {})
          }
        })
      ).toEqual({ status: 'failed', code: 'invalid-output' })
    }
    expect(save).not.toHaveBeenCalled()
  }
)

it('preserves the original publication guard and outcome for safe evidence', async () => {
  const output = {
    filename: 'project-recording.json',
    source: { kind: 'inline' as const, content: '{"states":[]}' },
    publication: { beforeWrite: vi.fn() }
  }
  const result = { status: 'failed' as const, code: 'artifact-save-failed' as const }
  const save = vi.fn(async () => result)
  expect(await screenAuxiliaryOutput(save, ['', 'fixture-key'])(output)).toBe(result)
  expect(save).toHaveBeenCalledWith(output)
})

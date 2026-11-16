import { describe, expect, it } from 'vitest'

import {
  getLabServerUrlError,
  joinLabBaseUrl,
  labModelId,
  labModelLabel,
  labModelSummaries,
  labModelWireId,
  labProviderApiEndpoints,
  labProtocolsToEndpoints
} from './lab'

describe('Lab shared contract', () => {
  it('requires https for a non-loopback server and allows loopback http for development', () => {
    expect(getLabServerUrlError('')).toBe('server-url-missing')
    expect(getLabServerUrlError('lab.example.com')).toBe('server-url-invalid')
    expect(getLabServerUrlError('http://lab.example.com')).toBe('server-url-insecure')
    expect(getLabServerUrlError('https://lab.example.com')).toBeUndefined()
    expect(getLabServerUrlError('http://127.0.0.1:8080')).toBeUndefined()
  })

  it('rejects query strings, fragments and embedded credentials', () => {
    expect(getLabServerUrlError('https://lab.example.com/?foo=1')).toBe('server-url-query')
    expect(getLabServerUrlError('https://lab.example.com/#x')).toBe('server-url-query')
    expect(getLabServerUrlError('https://user:pass@lab.example.com')).toBe('server-url-credentials')
    expect(getLabServerUrlError('https://lab.example.com/?token=1')).toBe('server-url-credentials')
  })

  it('namespaces model ids without changing the wire id', () => {
    expect(labModelId('research-default')).toBe('lab:research-default')
    expect(labModelId('lab:research-default')).toBe('lab:research-default')
    expect(labModelWireId('lab:research-default')).toBe('research-default')
    expect(labModelWireId('research-default')).toBe('research-default')
    expect(labModelLabel('lab:research-default')).toBe('research-default')
  })

  it('maps bootstrap protocols to the two gateway routes only', () => {
    expect(labProtocolsToEndpoints({ id: 'a', protocol: 'openai' })).toEqual(['chat-completions'])
    expect(labProtocolsToEndpoints({ id: 'a', protocols: ['openai', 'openai-response'] })).toEqual([
      'chat-completions',
      'responses'
    ])
    expect(labProtocolsToEndpoints({ id: 'a', protocols: ['anthropic'] })).toEqual([])
    expect(
      labProviderApiEndpoints([
        { id: 'a', protocol: 'openai' },
        { id: 'b', protocol: 'openai-response' }
      ])
    ).toEqual(['chat-completions', 'responses'])
  })

  it('joins the server address and the bootstrap model base url', () => {
    expect(joinLabBaseUrl('https://lab.example.com/', '/v1')).toBe('https://lab.example.com/v1')
    expect(joinLabBaseUrl('https://lab.example.com', 'v1')).toBe('https://lab.example.com/v1')
    expect(joinLabBaseUrl('https://lab.example.com', 'https://lab.example.com/v1')).toBe(
      'https://lab.example.com/v1'
    )
    expect(() => joinLabBaseUrl('https://lab.example.com', 'https://gw.example.com/v1')).toThrow(
      'must stay on the configured deployment'
    )
  })

  it('drops disabled or unavailable bootstrap models from the status summary', () => {
    const models = labModelSummaries([
      { id: 'a', name: 'A', protocol: 'openai', available: true },
      { id: 'b', name: 'B', protocol: 'openai', enabled: false },
      { id: 'c', name: 'C', protocol: 'openai-response', available: false }
    ])
    expect(models.map((model) => model.id)).toEqual(['lab:a'])
    expect(models[0]?.protocols).toEqual(['chat-completions'])
  })
})

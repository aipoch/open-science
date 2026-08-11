import { describe, expect, it } from 'vitest'

import {
  StructuredOutputError,
  prepareStructuredOutputSchema,
  validateStructuredOutputValue
} from './structured-output'

describe('structured output validator profile', () => {
  it('accepts Draft 2020-12 local schemas and preserves JSON values', () => {
    const contract = prepareStructuredOutputSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { item: { type: 'string' } },
      type: 'object',
      properties: {
        values: { type: 'array', items: { $ref: '#/$defs/item' } },
        nullable: { type: 'null' }
      },
      required: ['values'],
      additionalProperties: false
    })
    const value = { values: ['α', 'β'], nullable: null }

    expect(validateStructuredOutputValue(contract, value)).toEqual(value)
    expect(contract).toMatchObject({ dialect: '2020-12', profile: 'ajv-8-draft-2020-12-v1' })
    expect(contract.schemaDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    [{ $ref: 'https://example.test/schema' }, 'unsupported_schema'],
    [{ format: 'email' }, 'unsupported_schema'],
    [{ pattern: '^secret' }, 'unsupported_schema'],
    [{ patternProperties: { '^x': {} } }, 'unsupported_schema'],
    [{ $vocabulary: {} }, 'unsupported_schema'],
    [{ unknownKeyword: true }, 'unsupported_schema']
  ])('rejects unsafe or unknown schema %j', (schema, code) => {
    expect(() => prepareStructuredOutputSchema(schema)).toThrowError(
      expect.objectContaining({ code })
    )
  })

  it('rejects non-JSON and oversized structures before Ajv', () => {
    const contract = prepareStructuredOutputSchema({ type: 'array', items: { type: 'number' } })
    expect(() => validateStructuredOutputValue(contract, [1, Number.NaN])).toThrow(
      StructuredOutputError
    )
    const sparse = Array(2)
    sparse[1] = 1
    expect(() => validateStructuredOutputValue(contract, sparse)).toThrow(StructuredOutputError)
  })

  it('returns only a bounded safe validation error', () => {
    const contract = prepareStructuredOutputSchema({
      type: 'object',
      required: ['answer'],
      additionalProperties: false,
      properties: { answer: { type: 'number' } }
    })
    try {
      validateStructuredOutputValue(contract, { leaked: 'secret' })
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({
        code: 'structured_output_validation_failed',
        keyword: 'required',
        instancePath: '',
        property: 'answer'
      })
      expect(JSON.stringify(error)).not.toContain('secret')
      expect(JSON.stringify(error)).not.toContain('schemaPath')
    }
  })
})

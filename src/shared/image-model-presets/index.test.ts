import { describe, expect, it } from 'vitest'
import { IMAGE_MODEL_PRESET_ADAPTERS } from '../image-model-settings'
import {
  getImageModelPreset,
  imageEditSpatialReference,
  IMAGE_MODEL_PRESETS,
  validateImageModelOptions,
  type ImageOptionsValidation
} from './index'

const official = (
  options?: unknown,
  operation: 'generate' | 'edit' = 'generate'
): ImageOptionsValidation => validateImageModelOptions('minimax-h3/official', operation, options)

describe('image model presets', () => {
  it('covers every configurable preset without inferring capabilities from model aliases', () => {
    expect(Object.keys(IMAGE_MODEL_PRESETS).sort()).toEqual(
      Object.keys(IMAGE_MODEL_PRESET_ADAPTERS).sort()
    )
    for (const [id, adapter] of Object.entries(IMAGE_MODEL_PRESET_ADAPTERS)) {
      expect(getImageModelPreset(id)).toMatchObject({ id, adapter })
    }
    expect(validateImageModelOptions('openai-images/generic', 'generate')).toEqual({
      ok: true,
      options: {}
    })
    expect(validateImageModelOptions('openai-images/generic', 'edit')).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_OPTION'
    })
    expect(
      validateImageModelOptions('openai-images/generic', 'generate', { size: '1024x1024' }).ok
    ).toBe(false)
    for (const id of ['unknown', 'MiniMax-H3-Image', 'toString', '__proto__']) {
      expect(getImageModelPreset(id)).toBeUndefined()
      expect(validateImageModelOptions(id, 'generate')).toMatchObject({
        ok: false,
        code: 'NOT_CONFIGURED'
      })
    }
  })

  it('accepts documented official sizes and ratios without injecting conflicting defaults', () => {
    for (const options of [
      {},
      { size: 'auto', area: '4K', aspect_ratio: '16:9' },
      { size: '1024x640' },
      { size: '5000x4000' },
      { size: '1536x512' },
      { size: '1001x1001' },
      { aspect_ratio: '300:100' },
      { disable_prompt_enhanced: true, size: '1024x1024' },
      { disable_prompt_enhanced: true, aspect_ratio: '1:3', area: '2K' },
      { output_format: 'jpg', output_compression: 0 },
      { output_compression: 100 }
    ]) {
      expect(official(options)).toEqual({ ok: true, options })
    }
    expect(official({ size: '1024x1024' }, 'edit')).toEqual({
      ok: true,
      options: { size: '1024x1024' }
    })
  })

  it.each(['generate', 'edit'] as const)(
    'rejects a transparent JPG before %s dispatch',
    (operation) => {
      expect(
        official({ output_format: 'jpg', background: 'transparent' }, operation)
      ).toMatchObject({
        ok: false,
        code: 'UNSUPPORTED_OPTION',
        option: 'background'
      })
    }
  )

  it('rejects official range errors, conflicts and generation-only options during edit', () => {
    for (const options of [
      { size: '1024x639' },
      { size: '5001x4000' },
      { size: '1537x512' },
      { size: '0x1024' },
      { size: '1024X1024' },
      { size: '1e3x1024' },
      { size: '9007199254740992x1' },
      { size: '1024x1024', area: '4K' },
      { size: '1024x1024', aspect_ratio: 'auto' },
      { aspect_ratio: '301:200' },
      { aspect_ratio: '4:1' },
      { aspect_ratio: '1:0' },
      { area: '8K' },
      { disable_prompt_enhanced: true },
      { disable_prompt_enhanced: true, aspect_ratio: 'auto' },
      { output_format: 'png', output_compression: 95 },
      { output_compression: -1 },
      { output_compression: 101 },
      { output_compression: 1.5 },
      { disable_prompt_enhanced: 'false' }
    ]) {
      expect(official(options), JSON.stringify(options)).toMatchObject({
        ok: false,
        code: 'UNSUPPORTED_OPTION'
      })
    }
    expect(official({ disable_prompt_enhanced: false }, 'edit')).toMatchObject({
      ok: false,
      option: 'disable_prompt_enhanced'
    })
  })

  it('requires local size and keeps local-only options separate from official parameters', () => {
    for (const operation of ['generate', 'edit'] as const) {
      const local = (options?: unknown): ImageOptionsValidation =>
        validateImageModelOptions('minimax-h3/sglang', operation, options)
      expect(local()).toMatchObject({
        ok: false,
        option: 'size',
        message: expect.stringContaining('required')
      })
      for (const options of [
        { size: '1024x1024', seed: 42, min_generation_area: 1024 },
        { size: '4096x4096', seed: -1, min_generation_area: 16_777_216 }
      ])
        expect(local(options)).toEqual({ ok: true, options })
      for (const extra of [
        { size: 'auto' },
        { area: '4K' },
        { quality: 'high' },
        { seed: 1.5 },
        { seed: Number.MAX_SAFE_INTEGER + 1 },
        { seed: NaN },
        { min_generation_area: 1023 },
        { min_generation_area: 16_777_217 },
        { disable_prompt_enhanced: false },
        { negative_prompt: 'blur' },
        { num_inference_steps: 8 }
      ])
        expect(local({ size: '1024x1024', ...extra }).ok).toBe(false)
    }
    expect(official({ seed: 42 })).toMatchObject({ ok: false, option: 'seed' })
    expect(official({ min_generation_area: 1024 })).toMatchObject({
      ok: false,
      option: 'min_generation_area'
    })
  })

  it('rejects malformed objects and prevents overriding Host-owned transport fields', () => {
    for (const input of [
      null,
      [],
      true,
      'size=auto',
      new Date(),
      { size: null },
      { size: undefined }
    ]) {
      expect(official(input).ok).toBe(false)
    }
    for (const key of [
      'model',
      'prompt',
      'n',
      'response_format',
      'stream',
      'image',
      'images',
      'mask',
      'bbox',
      '__proto__',
      'constructor',
      'toString'
    ]) {
      expect(official(JSON.parse(`{"${key}":"private-value"}`))).toMatchObject({
        ok: false,
        option: key
      })
      expect(JSON.stringify(official({ [key]: 'private-value' }))).not.toContain('private-value')
    }
    const input = Object.freeze({ size: '1024x1024' })
    const result = official(input)
    expect(result).toEqual({ ok: true, options: input })
    if (result.ok) expect(result.options).not.toBe(input)
  })

  it('limits native markup to canonical models and supported source dimensions', () => {
    expect(
      imageEditSpatialReference('openai/gpt-image-2.6', 'gpt-image-2.6-flare', 16_777_216)
    ).toBe('markup')
    expect(
      imageEditSpatialReference('openai/gpt-image-2.6', 'gpt-image-2.6-flare', 16_777_217)
    ).toBe('separate-reference')
    expect(imageEditSpatialReference('openai/gpt-image-2.6', 'relay/gpt', 100_000)).toBe(
      'separate-reference'
    )
    expect(getImageModelPreset('openai-images/generic')?.operations.edit).toBeUndefined()
  })
})

it('validates supplier-specific options without granting generic relays edit capabilities', () => {
  expect(
    validateImageModelOptions('openai/gpt-image-2.6', 'edit', {
      size: '1536x864',
      quality: 'xhigh',
      complexity: 'low',
      background: 'transparent'
    }).ok
  ).toBe(true)
  expect(
    validateImageModelOptions('openai/gpt-image-2.6', 'edit', { output_compression: 90 }).ok
  ).toBe(false)
  expect(
    validateImageModelOptions('openai/gpt-image-2.6', 'edit', { size: '1537x864' })
  ).toMatchObject({
    ok: false,
    option: 'size'
  })
  expect(
    validateImageModelOptions('openai/gpt-image-2.6', 'edit', { size: '4096x2048' })
  ).toMatchObject({
    ok: false,
    option: 'size'
  })
  expect(validateImageModelOptions('qwen/image-3.0', 'edit', { quality: 'high' }).ok).toBe(false)
  expect(
    validateImageModelOptions('qwen/image-3.0', 'edit', { prompt_extend_mode: 'agent' }).ok
  ).toBe(false)
  expect(
    validateImageModelOptions('qwen/image-3.0', 'generate', {
      prompt_extend: false,
      enable_thinking: true
    }).ok
  ).toBe(false)
  expect(
    validateImageModelOptions('qwen/image-3.0', 'generate', { negative_prompt: 'x'.repeat(2001) })
      .ok
  ).toBe(false)
  expect(
    validateImageModelOptions('seedream/5.5', 'edit', { size: '1.5K', background: 'transparent' })
      .ok
  ).toBe(true)
  expect(
    validateImageModelOptions('seedream/5.5', 'edit', {
      output_format: 'jpeg',
      background: 'transparent'
    })
  ).toMatchObject({
    ok: false,
    option: 'background'
  })
  expect(validateImageModelOptions('seedream/5.5', 'edit', { size: '512x512' }).ok).toBe(false)
  expect(validateImageModelOptions('seedream/5.5', 'edit', { size: '4K' }).ok).toBe(false)
  expect(validateImageModelOptions('seedream/5.5', 'generate', { n: 1 }).ok).toBe(false)
})

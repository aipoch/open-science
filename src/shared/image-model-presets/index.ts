import {
  IMAGE_MODEL_PRESET_ADAPTERS,
  type ImageAdapterKind,
  type ImageModelPresetId
} from '../image-model-settings'

export type ImageOperation = 'generate' | 'edit'
export type ImageSpatialReference = 'separate-reference' | 'markup'
export type ImageOptionValue = string | number | boolean
export type ImageOptionSpec = {
  required?: boolean
  // Informational only: filling defaults can make explicit size conflict with area/aspect_ratio.
  default?: ImageOptionValue
} & (
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'text'; maxLength: number }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'boolean' }
  | {
      kind: 'size'
      auto: boolean
      minPixels: number
      maxPixels: number
      maxRatio?: number
      maxEdge?: number
      edgeMultiple?: number
      namedSizes?: readonly string[]
    }
  | { kind: 'aspect-ratio'; maxComponent: number; maxRatio: number }
)
export type ImageOperationSpec = {
  options: Readonly<Record<string, ImageOptionSpec>>
  maxInputBytes: number
  maxInputPixels: number
  minInputEdge?: number
  maxInputEdge?: number
  maxInputRatio?: number
}
export function imageInputExceedsLimits(
  spec: ImageOperationSpec,
  { sizeBytes, width, height }: { sizeBytes?: number; width?: number; height?: number }
): boolean {
  if (sizeBytes !== undefined && sizeBytes > spec.maxInputBytes) return true
  if (width === undefined || height === undefined) return false
  const shortest = Math.min(width, height)
  const longest = Math.max(width, height)
  return (
    width * height > spec.maxInputPixels ||
    (spec.minInputEdge !== undefined && shortest < spec.minInputEdge) ||
    (spec.maxInputEdge !== undefined && longest > spec.maxInputEdge) ||
    (spec.maxInputRatio !== undefined && longest > shortest * spec.maxInputRatio)
  )
}

export type ImageModelPreset = {
  id: ImageModelPresetId
  adapter: ImageAdapterKind
  operations: {
    generate?: ImageOperationSpec
    edit?: ImageOperationSpec
  }
}

// Checked 2026-11-13:
// https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-generations.json
// https://platform.minimax.io/docs/api-reference/image/generation/api/h3-image-edits.json
// https://github.com/MiniMax-AI/MiniMax-H3-Image#request-parameters
const officialOptions: ImageOperationSpec['options'] = {
  size: {
    kind: 'size',
    auto: true,
    minPixels: 655_360,
    maxPixels: 20_000_000,
    maxRatio: 3,
    default: 'auto'
  },
  aspect_ratio: { kind: 'aspect-ratio', maxComponent: 300, maxRatio: 3, default: 'auto' },
  area: { kind: 'enum', values: ['1K', '2K', '4K'], default: '4K' },
  output_format: { kind: 'enum', values: ['jpeg', 'jpg', 'png', 'webp'], default: 'jpeg' },
  output_compression: { kind: 'integer', min: 0, max: 100, default: 95 }
}
const localOptions: ImageOperationSpec['options'] = {
  // SGLang requires explicit size. The 20 MP ceiling is an application resource limit.
  size: { kind: 'size', auto: false, minPixels: 1, maxPixels: 20_000_000, required: true },
  seed: { kind: 'integer', min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
  min_generation_area: { kind: 'integer', min: 1024, max: 16_777_216, default: 4_194_304 }
}
const noInput = { maxInputBytes: 0, maxInputPixels: 0 }
// Application ceilings, not promises that every server/decoder accepts these inputs.
const editInput = { maxInputBytes: 64 * 1024 * 1024, maxInputPixels: 20_000_000 }

// Verified official contracts, 2026-11-14. Generic relays do not inherit these capabilities.
const openaiOptions: ImageOperationSpec['options'] = {
  size: {
    kind: 'size',
    auto: true,
    minPixels: 655360,
    maxPixels: 8294400,
    maxRatio: 3,
    maxEdge: 3840,
    edgeMultiple: 16,
    default: 'auto',
    namedSizes: ['1024x1024', '1536x1024', '1024x1536', '1536x864']
  },
  quality: {
    kind: 'enum',
    values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    default: 'auto'
  },
  complexity: { kind: 'enum', values: ['low', 'medium', 'high'], default: 'high' },
  output_format: { kind: 'enum', values: ['png', 'jpeg', 'webp'], default: 'png' },
  output_compression: { kind: 'integer', min: 0, max: 100, default: 100 },
  background: { kind: 'enum', values: ['auto', 'opaque', 'transparent'], default: 'auto' }
}
const qwenOptions: ImageOperationSpec['options'] = {
  size: { kind: 'size', auto: true, minPixels: 512 * 512, maxPixels: 2048 * 2048, maxRatio: 8 },
  seed: { kind: 'integer', min: 0, max: 2147483647 },
  negative_prompt: { kind: 'text', maxLength: 2000 },
  prompt_extend: { kind: 'boolean', default: true },
  enable_thinking: { kind: 'boolean', default: true },
  watermark: { kind: 'boolean', default: false }
}
const seedreamOptions: ImageOperationSpec['options'] = {
  size: {
    kind: 'size',
    auto: false,
    namedSizes: ['1K', '1.5K', '2K'],
    minPixels: 921600,
    maxPixels: 4624220,
    maxRatio: 16,
    default: '2K'
  },
  output_format: { kind: 'enum', values: ['png', 'jpeg'], default: 'png' },
  background: { kind: 'enum', values: ['auto', 'opaque', 'transparent'], default: 'auto' },
  watermark: { kind: 'boolean', default: true }
}

export const IMAGE_MODEL_PRESETS: Readonly<Record<ImageModelPresetId, ImageModelPreset>> = {
  'minimax-h3/official': {
    id: 'minimax-h3/official',
    adapter: IMAGE_MODEL_PRESET_ADAPTERS['minimax-h3/official'],
    operations: {
      generate: {
        ...noInput,
        options: {
          ...officialOptions,
          disable_prompt_enhanced: { kind: 'boolean', default: false }
        }
      },
      edit: {
        ...editInput,
        minInputEdge: 128,
        maxInputEdge: 8192,
        maxInputRatio: 4,
        options: officialOptions
      }
    }
  },
  'minimax-h3/sglang': {
    id: 'minimax-h3/sglang',
    adapter: IMAGE_MODEL_PRESET_ADAPTERS['minimax-h3/sglang'],
    operations: {
      generate: { ...noInput, options: localOptions },
      edit: { ...editInput, options: localOptions }
    }
  },
  'openai/gpt-image-2.6': {
    id: 'openai/gpt-image-2.6',
    adapter: 'openai-images',
    operations: {
      generate: { ...noInput, options: openaiOptions },
      edit: {
        ...editInput,
        maxInputBytes: 14 * 1024 * 1024,
        options: openaiOptions
      }
    }
  },
  'qwen/image-3.0': {
    id: 'qwen/image-3.0',
    adapter: 'qwen-images',
    operations: {
      generate: {
        ...noInput,
        options: {
          ...qwenOptions,
          prompt_extend_mode: { kind: 'enum', values: ['direct', 'agent'], default: 'direct' }
        }
      },
      edit: {
        ...editInput,
        maxInputBytes: 10 * 1024 * 1024,
        maxInputEdge: 8000,
        maxInputRatio: 10,
        options: qwenOptions
      }
    }
  },
  'seedream/5.5': {
    id: 'seedream/5.5',
    adapter: 'seedream',
    operations: {
      generate: { ...noInput, options: seedreamOptions },
      edit: {
        ...editInput,
        maxInputBytes: 30 * 1024 * 1024,
        minInputEdge: 15,
        maxInputRatio: 16,
        options: seedreamOptions
      }
    }
  },
  'openai-images/generic': {
    id: 'openai-images/generic',
    adapter: IMAGE_MODEL_PRESET_ADAPTERS['openai-images/generic'],
    // A transport-compatible endpoint does not imply model-specific options or edit support.
    operations: { generate: { ...noInput, options: {} } }
  }
}

export function getImageModelPreset(presetId: string): ImageModelPreset | undefined {
  return Object.hasOwn(IMAGE_MODEL_PRESETS, presetId)
    ? IMAGE_MODEL_PRESETS[presetId as ImageModelPresetId]
    : undefined
}

export function imageEditSpatialReference(
  presetId: ImageModelPresetId,
  wireModelId: string,
  sourcePixels: number
): ImageSpatialReference {
  if (
    presetId === 'openai/gpt-image-2.6' &&
    (wireModelId === 'gpt-image-2.6-sunburst' || wireModelId === 'gpt-image-2.6-flare') &&
    sourcePixels <= 16_777_216
  )
    return 'markup'
  return 'separate-reference'
}

export function isImageOptionApplicable(
  spec: ImageOperationSpec,
  key: string,
  options: Readonly<Record<string, ImageOptionValue>>
): boolean {
  if (key === 'aspect_ratio' || key === 'area')
    return options.size === undefined || options.size === 'auto'
  if (key === 'output_compression') {
    const format = options.output_format ?? spec.options.output_format?.default
    return format === 'jpeg' || format === 'jpg' || format === 'webp'
  }
  if (key === 'enable_thinking' || key === 'prompt_extend_mode')
    return options.prompt_extend !== false
  return true
}

export type ImageOptionsValidation =
  | { ok: true; options: Record<string, ImageOptionValue> }
  | {
      ok: false
      code: 'NOT_CONFIGURED' | 'UNSUPPORTED_OPTION'
      message: string
      option?: string
    }

function pair(value: unknown, separator: 'x' | ':'): [number, number] | undefined {
  if (typeof value !== 'string' || value.length > 32) return undefined
  if (!new RegExp(`^[1-9]\\d*${separator}[1-9]\\d*$`).test(value)) return undefined
  const [a, b] = value.split(separator).map(Number)
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) ? [a, b] : undefined
}

function validOption(spec: ImageOptionSpec, value: unknown): value is ImageOptionValue {
  switch (spec.kind) {
    case 'text':
      return typeof value === 'string' && value.length <= spec.maxLength
    case 'boolean':
      return typeof value === 'boolean'
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= spec.min &&
        value <= spec.max
      )
    case 'size': {
      if (typeof value === 'string' && spec.namedSizes?.includes(value)) return true
      if (value === 'auto') return spec.auto
      const dimensions = pair(value, 'x')
      if (!dimensions) return false
      const [width, height] = dimensions
      const pixels = width * height
      return (
        Number.isSafeInteger(pixels) &&
        pixels >= spec.minPixels &&
        pixels <= spec.maxPixels &&
        (spec.maxEdge === undefined || Math.max(width, height) <= spec.maxEdge) &&
        (spec.edgeMultiple === undefined ||
          (width % spec.edgeMultiple === 0 && height % spec.edgeMultiple === 0)) &&
        (spec.maxRatio === undefined ||
          Math.max(width, height) <= Math.min(width, height) * spec.maxRatio)
      )
    }
    case 'aspect-ratio': {
      if (value === 'auto') return true
      const ratio = pair(value, ':')
      return Boolean(
        ratio &&
        Math.max(...ratio) <= spec.maxComponent &&
        Math.max(...ratio) <= Math.min(...ratio) * spec.maxRatio
      )
    }
  }
}

const invalid = (message: string, option?: string): ImageOptionsValidation => ({
  ok: false,
  code: 'UNSUPPORTED_OPTION',
  message,
  ...(option ? { option } : {})
})

// The selected preset, not the wire model name, owns capabilities (relays may use aliases).
// Transport fields such as model, n, stream and response_format are owned by the Host adapter.
export function validateImageModelOptions(
  presetId: string,
  operation: ImageOperation,
  input: unknown = {}
): ImageOptionsValidation {
  const preset = getImageModelPreset(presetId)
  if (!preset)
    return { ok: false, code: 'NOT_CONFIGURED', message: 'Select a supported image model preset.' }
  const spec = Object.hasOwn(preset.operations, operation)
    ? preset.operations[operation]
    : undefined
  if (!spec) return invalid('The selected image model preset does not support this operation.')
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  ) {
    return invalid('Image options must be an object.')
  }
  const options: Record<string, ImageOptionValue> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(spec.options, key))
      return invalid('This option is not supported by the selected preset and operation.', key)
    if (!validOption(spec.options[key], value))
      return invalid('This option does not match the preset constraints.', key)
    options[key] = value
  }
  for (const [key, option] of Object.entries(spec.options)) {
    if (option.required && !Object.hasOwn(options, key))
      return invalid(
        'A required image option is missing. Supply it before sending the request.',
        key
      )
  }
  if (preset.id === 'minimax-h3/official') {
    const explicitSize = options.size !== undefined && options.size !== 'auto'
    if (explicitSize && (options.aspect_ratio !== undefined || options.area !== undefined)) {
      return invalid('Explicit size cannot be combined with aspect_ratio or area.', 'size')
    }
    if (
      options.disable_prompt_enhanced === true &&
      !explicitSize &&
      (options.aspect_ratio === undefined || options.aspect_ratio === 'auto')
    ) {
      return invalid(
        'Disabling prompt enhancement requires explicit size or aspect_ratio.',
        'disable_prompt_enhanced'
      )
    }
  }
  if (
    options.output_compression !== undefined &&
    !isImageOptionApplicable(spec, 'output_compression', options)
  )
    return invalid('Compression requires JPEG or WebP output.', 'output_compression')
  if (options.background === 'transparent' && options.output_format === 'jpeg')
    return invalid('Transparent output requires PNG or WebP.', 'background')
  if (
    preset.id === 'qwen/image-3.0' &&
    options.prompt_extend === false &&
    (options.enable_thinking !== undefined || options.prompt_extend_mode !== undefined)
  ) {
    return invalid('Prompt enhancement options require prompt_extend.', 'prompt_extend')
  }
  return { ok: true, options }
}

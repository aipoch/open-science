import type { ModelRevision } from './ports.js'
import { narrationRuntimeAssets } from './runtime.js'

// Kokoro-82M v1.0 (Apache-2.0). Model and runtime are downloaded only after explicit installation.
const origin =
  'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231'
const WEIGHTS: readonly ModelRevision[] = [
  {
    revision: 'kokoro-82m-v1-q8',
    assets: [
      {
        file: 'config.json',
        url: `${origin}/config.json`,
        size: 44,
        sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f'
      },
      {
        file: 'tokenizer.json',
        url: `${origin}/tokenizer.json`,
        size: 3497,
        sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34'
      },
      {
        file: 'tokenizer_config.json',
        url: `${origin}/tokenizer_config.json`,
        size: 113,
        sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20'
      },
      {
        file: 'model_quantized.onnx',
        url: `${origin}/onnx/model_quantized.onnx`,
        size: 92361116,
        sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'
      }
    ]
  }
]

// Keep every target recognizable after data-root transfer, and the old weight-only revision removable.
const target = `${process.platform}/${process.arch}`
const targets = ['darwin/arm64', 'darwin/x64', 'linux/arm64', 'linux/x64', 'win32/x64']
if (!targets.includes(target)) throw new Error(`Research narration is not supported on ${target}`)
export const RESEARCH_NARRATION_MODELS: readonly ModelRevision[] = [
  ...[target, ...targets.filter((entry) => entry !== target)].map((entry) => ({
    revision: `kokoro-node-v2-${entry.replace('/', '-')}`,
    assets: [
      ...WEIGHTS[0].assets,
      ...narrationRuntimeAssets(entry).map(({ file, url, size, sha256 }) => ({
        file,
        url,
        size,
        sha256
      }))
    ]
  })),
  ...WEIGHTS
]

import type { LocalModelRevision } from './catalog'

// Transport alternatives stay outside the model recipe: its serialized identity is part of the
// parser cache fingerprint. These exact files were downloaded and checked against the catalog.
const alternatives: Readonly<Record<string, readonly string[]>> = {
  'https://huggingface.co/Xenova/table-transformer-detection/resolve/187ac355617c8fee3d69c00d461ecf8eb8a4a5b7/onnx/model.onnx':
    [
      'https://www.modelscope.cn/models/Xenova/table-transformer-detection/resolve/e1f6f6333de70d7567f171aff3ace320f4b95f50/onnx/model.onnx',
      'https://hf-mirror.com/Xenova/table-transformer-detection/resolve/187ac355617c8fee3d69c00d461ecf8eb8a4a5b7/onnx/model.onnx'
    ],
  'https://huggingface.co/Xenova/table-transformer-structure-recognition/resolve/5387550de655512721e1b88e4e42117001ba4813/onnx/model.onnx':
    [
      'https://www.modelscope.cn/models/Xenova/table-transformer-structure-recognition/resolve/07b9faf118b854e99a9ec290376f39b118435ff4/onnx/model.onnx',
      'https://hf-mirror.com/Xenova/table-transformer-structure-recognition/resolve/5387550de655512721e1b88e4e42117001ba4813/onnx/model.onnx'
    ],
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.wasm.min.mjs': [
    'https://unpkg.com/onnxruntime-web@1.29.0/dist/ort.wasm.min.mjs'
  ],
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.mjs': [
    'https://unpkg.com/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.mjs'
  ],
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.wasm': [
    'https://unpkg.com/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.wasm'
  ],
  'https://raw.githubusercontent.com/microsoft/table-transformer/16d124f616109746b7785f03085100f1f6247575/LICENSE':
    [
      'https://cdn.jsdelivr.net/gh/microsoft/table-transformer@16d124f616109746b7785f03085100f1f6247575/LICENSE'
    ],
  'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.29.0/LICENSE': [
    'https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v1.29.0/LICENSE'
  ],
  'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.29.0/ThirdPartyNotices.txt': [
    'https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v1.29.0/ThirdPartyNotices.txt'
  ]
}

export const localModelDownloadSources = (
  asset: LocalModelRevision['assets'][number]
): readonly string[] => [asset.url, ...(alternatives[asset.url] ?? [])]

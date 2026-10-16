export type LocalModelRevision = Readonly<{
  revision: string
  assets: readonly Readonly<{ file: string; url: string; size: number; sha256: string }>[]
}>

// App-reviewed revisions, newest first. Keep older compatible revisions here when adding updates.
// Microsoft Table Transformer (MIT), ONNX conversions by Xenova. Weights are downloaded on demand.
// https://huggingface.co/Xenova/table-transformer-detection
// https://huggingface.co/Xenova/table-transformer-structure-recognition
const WEIGHT_REVISIONS: readonly LocalModelRevision[] = [
  {
    revision: 'table-transformer-fp32-v1',
    assets: [
      {
        file: 'detection.onnx',
        url: 'https://huggingface.co/Xenova/table-transformer-detection/resolve/187ac355617c8fee3d69c00d461ecf8eb8a4a5b7/onnx/model.onnx',
        size: 115694355,
        sha256: '5be82ec9d157814ea8616588398d7baec17aed0780b870f7adf24b280ee1b5aa'
      },
      {
        file: 'structure.onnx',
        url: 'https://huggingface.co/Xenova/table-transformer-structure-recognition/resolve/5387550de655512721e1b88e4e42117001ba4813/onnx/model.onnx',
        size: 115811109,
        sha256: '2c90a63298df61006a45267932f47b345a8b104ce53fd504eacf11aee3c05a41'
      }
    ]
  }
]

// The initial weight-only revision stays recognized for explicit update/removal.
// Runtime bytes match the real-page Node/Electron probe; execution uses one CPU WASM thread.
export const PDF_TABLE_MODEL_REVISIONS: readonly LocalModelRevision[] = [
  {
    revision: 'pdf-figures-tables-v1',
    assets: [
      ...WEIGHT_REVISIONS[0].assets,
      {
        file: 'table-transformer-license.txt',
        url: 'https://raw.githubusercontent.com/microsoft/table-transformer/16d124f616109746b7785f03085100f1f6247575/LICENSE',
        size: 1141,
        sha256: 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'
      },
      {
        file: 'ort.wasm.min.mjs',
        url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.wasm.min.mjs',
        size: 50126,
        sha256: '14a0a63ad1a0fe8127722929fd16fb26c2e5352ea221bc9034d12daf314d0b92'
      },
      {
        file: 'ort-wasm-simd-threaded.mjs',
        url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.mjs',
        size: 24218,
        sha256: '5a15f1fd086b3f6c2baf1f35105b8f502653b567e165cef80028870b39748747'
      },
      {
        file: 'ort-wasm-simd-threaded.wasm',
        url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort-wasm-simd-threaded.wasm',
        size: 13961845,
        sha256: 'ec8580a9d7b9476ceee52e10a7f94124e4dc71a019d666ed6d4726697c109a4d'
      },
      {
        file: 'onnx-license.txt',
        url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.29.0/LICENSE',
        size: 1073,
        sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'
      },
      {
        file: 'onnx-notices.txt',
        url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.29.0/ThirdPartyNotices.txt',
        size: 336906,
        sha256: '53d3fa5821ac016ac24dd35775c996efec86e2ae0841e9a3a5e146c0ae916845'
      }
    ]
  },
  ...WEIGHT_REVISIONS
]

// Qwen3 0.6B (Apache-2.0), pinned ONNX Community conversion verified in the local spike.
export const PDF_TRANSLATION_MODEL_REVISIONS: readonly LocalModelRevision[] = [
  {
    revision: 'qwen3-0-6b-q8-v1',
    assets: [
      {
        file: 'qwen-license.txt',
        url: 'https://huggingface.co/Qwen/Qwen3-0.6B/resolve/c1899de289a04d12100db370d81485cdf75e47ca/LICENSE',
        size: 11343,
        sha256: '832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e'
      },
      {
        file: 'config.json',
        url: 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/da1453100cf3ff33ef56d17983fc7a8648706db6/config.json',
        size: 912,
        sha256: '8a04114ba59cc42b47d804d35d1d5c61d746ae4634f41f796768c6e302d39b9e'
      },
      {
        file: 'generation_config.json',
        url: 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/da1453100cf3ff33ef56d17983fc7a8648706db6/generation_config.json',
        size: 219,
        sha256: '9e9e031ae8bca36eefcdcdd0b35d83c61baa01e31d68d5f5a961c9ca1a4b95bf'
      },
      {
        file: 'special_tokens_map.json',
        url: 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/da1453100cf3ff33ef56d17983fc7a8648706db6/special_tokens_map.json',
        size: 613,
        sha256: '76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd'
      },
      {
        file: 'tokenizer.json',
        url: 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/da1453100cf3ff33ef56d17983fc7a8648706db6/tokenizer.json',
        size: 9117040,
        sha256: 'e7a95fce95bf5b0946d0ddb3f9d7caa030b7e850bbe92b0edb26bcf563e9f3d5'
      },
      {
        file: 'tokenizer_config.json',
        url: 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/da1453100cf3ff33ef56d17983fc7a8648706db6/tokenizer_config.json',
        size: 9705,
        sha256: 'b0a8115cf05a7002cbe2575058c0139c1dee3f06f221c05717c3444947d78b9f'
      },
      {
        file: 'model_quantized.onnx',
        url: 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/da1453100cf3ff33ef56d17983fc7a8648706db6/onnx/model_quantized.onnx',
        size: 617687575,
        sha256: 'ccf8734e59fdf7475b2dc0c117005e267a3a08342c1d951e0a79f0bce57bf62a'
      }
    ]
  }
]

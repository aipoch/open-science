// Qwen3 0.6B (Apache-2.0), pinned ONNX Community conversion verified in the local spike.
const revisions = [
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

/** Pinned model recipe; installation locations and active receipts belong to the caller. */
export const QWEN3_LOCAL_TEXT_GENERATION_MODEL = Object.freeze({
  id: 'qwen3-0.6b-q8',
  runtime: 'transformers-4-2-0-ort-web-1-26-0-dev-20260416-b7804b056c-wasm-v1',
  revisions: Object.freeze(
    revisions.map((revision) =>
      Object.freeze({
        ...revision,
        assets: Object.freeze(revision.assets.map((asset) => Object.freeze(asset)))
      })
    )
  )
})

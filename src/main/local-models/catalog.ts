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

// Generated by npm run build:ocr -- --catalog. Publish first-party assets before release.
export const OCR_MODEL_REVISIONS: readonly LocalModelRevision[] = [
  {
    revision: 'ocr-c94967b48ec9ad35',
    assets: [
      {
        file: 'chi_sim.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz',
        size: 1718768,
        sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c'
      },
      {
        file: 'chi_tra.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_tra@1.0.0/4.0.0_best_int/chi_tra.traineddata.gz',
        size: 1656239,
        sha256: '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743'
      },
      {
        file: 'deu.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/deu@1.0.0/4.0.0_best_int/deu.traineddata.gz',
        size: 1333102,
        sha256: '306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b'
      },
      {
        file: 'eng.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz',
        size: 2952873,
        sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'
      },
      {
        file: 'fra.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/fra@1.0.0/4.0.0_best_int/fra.traineddata.gz',
        size: 707406,
        sha256: 'd611139672b3752c7097e671e4a1d9209dfd37f2aeb081ef6487fba3351e9255'
      },
      {
        file: 'jpn.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn@1.0.0/4.0.0_best_int/jpn.traineddata.gz',
        size: 2030256,
        sha256: '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88'
      },
      {
        file: 'kor.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/kor@1.0.0/4.0.0_best_int/kor.traineddata.gz',
        size: 1572336,
        sha256: '78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126'
      },
      {
        file: 'licenses.txt',
        url: 'https://statics.aipoch.com/open-science/ocr/6b2e0cd346d8076d29aa04dfd88a83e0152c015adf673bf5ce6890f85a46ec98/licenses.txt',
        size: 38017,
        sha256: '6b2e0cd346d8076d29aa04dfd88a83e0152c015adf673bf5ce6890f85a46ec98'
      },
      {
        file: 'ocr-engine.mjs',
        url: 'https://statics.aipoch.com/open-science/ocr/85d4349ccb423595a66257ad0318ecbed8a1b885130bf64135c3e5a9e73e674f/ocr-engine.mjs',
        size: 525077,
        sha256: '85d4349ccb423595a66257ad0318ecbed8a1b885130bf64135c3e5a9e73e674f'
      },
      {
        file: 'ocr-worker.mjs',
        url: 'https://statics.aipoch.com/open-science/ocr/6e7c9ade4e042b5c37c0d81e0032d31472c98138125164964ca5b2af7ccd2df8/ocr-worker.mjs',
        size: 16802,
        sha256: '6e7c9ade4e042b5c37c0d81e0032d31472c98138125164964ca5b2af7ccd2df8'
      },
      {
        file: 'rus.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/rus@1.0.0/4.0.0_best_int/rus.traineddata.gz',
        size: 2679598,
        sha256: 'f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a'
      },
      {
        file: 'spa.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/spa@1.0.0/4.0.0_best_int/spa.traineddata.gz',
        size: 2100190,
        sha256: '40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb'
      },
      {
        file: 'tesseract-core-lstm.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-lstm.wasm',
        size: 2871085,
        sha256: '220e2e87551edccb85519796a170469f8ab2a8055216789e3b8b1ada18b7bc2b'
      },
      {
        file: 'tesseract-core-simd-lstm.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-simd-lstm.wasm',
        size: 2871377,
        sha256: '187d76742dfc0d8929f0b49a619f145bb6370730776c7bd0d3e20c6b2098808d'
      },
      {
        file: 'tesseract-core-simd.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-simd.wasm',
        size: 3469078,
        sha256: 'ca11ee92a02023e4f5083eefd0966fb83b297416da54e997b9f6ce445f719c9b'
      },
      {
        file: 'tesseract-core.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core.wasm',
        size: 3468788,
        sha256: '740f7e466a2f026e1f1e54a2e0d9957e386d8166110d1290224abd3d08986106'
      }
    ]
  }
]
export const OCR_RUNTIME_REVISIONS: readonly LocalModelRevision[] = [
  {
    revision: 'ocr-runtime-78f085ec5fd7663d',
    assets: [
      {
        file: 'licenses.txt',
        url: 'https://statics.aipoch.com/open-science/ocr/6b2e0cd346d8076d29aa04dfd88a83e0152c015adf673bf5ce6890f85a46ec98/licenses.txt',
        size: 38017,
        sha256: '6b2e0cd346d8076d29aa04dfd88a83e0152c015adf673bf5ce6890f85a46ec98'
      },
      {
        file: 'ocr-engine.mjs',
        url: 'https://statics.aipoch.com/open-science/ocr/85d4349ccb423595a66257ad0318ecbed8a1b885130bf64135c3e5a9e73e674f/ocr-engine.mjs',
        size: 525077,
        sha256: '85d4349ccb423595a66257ad0318ecbed8a1b885130bf64135c3e5a9e73e674f'
      },
      {
        file: 'ocr-worker.mjs',
        url: 'https://statics.aipoch.com/open-science/ocr/6e7c9ade4e042b5c37c0d81e0032d31472c98138125164964ca5b2af7ccd2df8/ocr-worker.mjs',
        size: 16802,
        sha256: '6e7c9ade4e042b5c37c0d81e0032d31472c98138125164964ca5b2af7ccd2df8'
      },
      {
        file: 'tesseract-core-lstm.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-lstm.wasm',
        size: 2871085,
        sha256: '220e2e87551edccb85519796a170469f8ab2a8055216789e3b8b1ada18b7bc2b'
      },
      {
        file: 'tesseract-core-simd-lstm.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-simd-lstm.wasm',
        size: 2871377,
        sha256: '187d76742dfc0d8929f0b49a619f145bb6370730776c7bd0d3e20c6b2098808d'
      },
      {
        file: 'tesseract-core-simd.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-simd.wasm',
        size: 3469078,
        sha256: 'ca11ee92a02023e4f5083eefd0966fb83b297416da54e997b9f6ce445f719c9b'
      },
      {
        file: 'tesseract-core.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core.wasm',
        size: 3468788,
        sha256: '740f7e466a2f026e1f1e54a2e0d9957e386d8166110d1290224abd3d08986106'
      }
    ]
  },
  {
    revision: 'ocr-7ed9791930e614a1',
    assets: [
      {
        file: 'chi_sim.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz',
        size: 1718768,
        sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c'
      },
      {
        file: 'eng.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz',
        size: 2952873,
        sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'
      },
      {
        file: 'licenses.txt',
        url: 'https://statics.aipoch.com/open-science/ocr/6702c6b73e37c34c9db7342b2964ff513a8162b086733bd0fd03cda90df4896d/licenses.txt',
        size: 37677,
        sha256: '6702c6b73e37c34c9db7342b2964ff513a8162b086733bd0fd03cda90df4896d'
      },
      {
        file: 'ocr-engine.mjs',
        url: 'https://statics.aipoch.com/open-science/ocr/f8831b545ef7136c6bb8247406ce2ca93d88ecf37e801716f08ed9c1389d5032/ocr-engine.mjs',
        size: 525077,
        sha256: 'f8831b545ef7136c6bb8247406ce2ca93d88ecf37e801716f08ed9c1389d5032'
      },
      {
        file: 'ocr-worker.mjs',
        url: 'https://statics.aipoch.com/open-science/ocr/26269fa529d48a0f249f2ecf16137fd156f0ee1a0e94470fc3f03023046a7be9/ocr-worker.mjs',
        size: 16396,
        sha256: '26269fa529d48a0f249f2ecf16137fd156f0ee1a0e94470fc3f03023046a7be9'
      },
      {
        file: 'tesseract-core-lstm.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-lstm.wasm',
        size: 2871085,
        sha256: '220e2e87551edccb85519796a170469f8ab2a8055216789e3b8b1ada18b7bc2b'
      },
      {
        file: 'tesseract-core-simd-lstm.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-simd-lstm.wasm',
        size: 2871377,
        sha256: '187d76742dfc0d8929f0b49a619f145bb6370730776c7bd0d3e20c6b2098808d'
      },
      {
        file: 'tesseract-core-simd.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-simd.wasm',
        size: 3469078,
        sha256: 'ca11ee92a02023e4f5083eefd0966fb83b297416da54e997b9f6ce445f719c9b'
      },
      {
        file: 'tesseract-core.wasm',
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core.wasm',
        size: 3468788,
        sha256: '740f7e466a2f026e1f1e54a2e0d9957e386d8166110d1290224abd3d08986106'
      }
    ]
  }
]
export const OCR_LANGUAGE_PACK_REVISIONS: Readonly<Record<string, LocalModelRevision>> = {
  eng: {
    revision: 'ocr-language-eng-v1',
    assets: [
      {
        file: 'eng.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz',
        size: 2952873,
        sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'
      }
    ]
  },
  chi_sim: {
    revision: 'ocr-language-chi_sim-v1',
    assets: [
      {
        file: 'chi_sim.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz',
        size: 1718768,
        sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c'
      }
    ]
  },
  chi_tra: {
    revision: 'ocr-language-chi_tra-v1',
    assets: [
      {
        file: 'chi_tra.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_tra@1.0.0/4.0.0_best_int/chi_tra.traineddata.gz',
        size: 1656239,
        sha256: '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743'
      }
    ]
  },
  deu: {
    revision: 'ocr-language-deu-v1',
    assets: [
      {
        file: 'deu.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/deu@1.0.0/4.0.0_best_int/deu.traineddata.gz',
        size: 1333102,
        sha256: '306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b'
      }
    ]
  },
  spa: {
    revision: 'ocr-language-spa-v1',
    assets: [
      {
        file: 'spa.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/spa@1.0.0/4.0.0_best_int/spa.traineddata.gz',
        size: 2100190,
        sha256: '40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb'
      }
    ]
  },
  fra: {
    revision: 'ocr-language-fra-v1',
    assets: [
      {
        file: 'fra.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/fra@1.0.0/4.0.0_best_int/fra.traineddata.gz',
        size: 707406,
        sha256: 'd611139672b3752c7097e671e4a1d9209dfd37f2aeb081ef6487fba3351e9255'
      }
    ]
  },
  jpn: {
    revision: 'ocr-language-jpn-v1',
    assets: [
      {
        file: 'jpn.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn@1.0.0/4.0.0_best_int/jpn.traineddata.gz',
        size: 2030256,
        sha256: '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88'
      }
    ]
  },
  kor: {
    revision: 'ocr-language-kor-v1',
    assets: [
      {
        file: 'kor.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/kor@1.0.0/4.0.0_best_int/kor.traineddata.gz',
        size: 1572336,
        sha256: '78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126'
      }
    ]
  },
  rus: {
    revision: 'ocr-language-rus-v1',
    assets: [
      {
        file: 'rus.traineddata.gz',
        url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/rus@1.0.0/4.0.0_best_int/rus.traineddata.gz',
        size: 2679598,
        sha256: 'f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a'
      }
    ]
  }
}

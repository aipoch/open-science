import { describe, expect, it } from 'vitest'

import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('model format file access coverage', () => {
  it.each([
    [
      'ONNX',
      "import onnx\nmodel = onnx.load('source.onnx')\nonnx.save(model, 'result.onnx')",
      'source.onnx',
      'result.onnx'
    ],
    [
      'safetensors',
      "from safetensors.torch import load_file, save_file\ntensors = load_file('source.safetensors')\nsave_file(tensors, 'result.safetensors')",
      'source.safetensors',
      'result.safetensors'
    ],
    [
      'XGBoost',
      "import xgboost as xgb\nmodel = xgb.Booster()\nmodel.load_model('source.ubj')\nmodel.save_model('result.ubj')",
      'source.ubj',
      'result.ubj'
    ],
    [
      'CatBoost',
      "from catboost import CatBoostClassifier\nmodel = CatBoostClassifier()\nmodel.load_model('source.cbm')\nmodel.save_model('result.cbm')",
      'source.cbm',
      'result.cbm'
    ],
    [
      'Keras',
      "from tensorflow import keras\nmodel = keras.models.load_model('source.keras')\nmodel.save('result.keras')",
      'source.keras',
      'result.keras'
    ]
  ])('captures %s single-file models', async (_format, source, input, output) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [input],
      writes: [output],
      reasonCodes: []
    })
  })

  it('keeps unsafe joblib deserialization conservative while capturing its files', async () => {
    const source =
      "import joblib\nmodel = joblib.load('source.joblib')\njoblib.dump(model, 'result.joblib')"

    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'partial',
      writeState: 'complete',
      externalState: 'partial',
      reads: ['source.joblib'],
      writes: ['result.joblib'],
      reasonCodes: ['source-analysis-unsupported-call']
    })
  })

  it.each([
    [
      'extensionless model methods',
      "import xgboost as xgb\nmodel = xgb.Booster()\nmodel.load_model('source-model')\nmodel.save_model('result-model')"
    ],
    [
      'Transformers directory output',
      "from transformers import AutoModel\nmodel = AutoModel.from_pretrained('source-model')\nmodel.save_pretrained('result-model')"
    ]
  ])('keeps %s conservative', async (_format, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      externalState: 'partial',
      reads: [],
      writes: [],
      reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
    })
  })
})

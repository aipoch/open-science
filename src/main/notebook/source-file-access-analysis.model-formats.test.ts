import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { describe, expect, it } from 'vitest'

import { analyzePythonNotebookSource } from './dependency-analysis-python'
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
      // Known paths do not rule out additional effects of unsupported execution.
      writeState: 'partial',
      externalState: 'partial',
      reads: ['source.joblib'],
      writes: ['result.joblib'],
      reasonCodes: ['source-analysis-unsupported-call']
    })
  })

  it('keeps dynamic joblib estimator paths conservative', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        'import joblib\nmodel_path = resolve_model_path()\nmodel = joblib.load(model_path)\nprint(model.predict(features))'
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: [],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it.each([
    ['literal path', "import torch\nweights = torch.load('source.pt', weights_only=True)"],
    [
      'CPU map location',
      "import torch\nweights = torch.load('source.pt', map_location='cpu', weights_only=True)"
    ],
    ['imported loader', "from torch import load\nweights = load(f='source.pt', weights_only=True)"]
  ])('certifies a safe PyTorch weights-only load: %s', async (_label, source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toEqual({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['source.pt'],
      writes: [],
      reasonCodes: []
    })
  })

  it.each([
    "import torch\nweights = torch.load('source.pt')",
    "import torch\nweights = torch.load('source.pt', weights_only=flag)",
    "import torch\nweights = torch.load('source.pt', map_location=resolve_device, weights_only=True)",
    "import torch\nweights = torch.load('source.pt', weights_only=True, **load_options)"
  ])('keeps non-literal PyTorch deserialization conservative: %s', async (source) => {
    await expect(analyzeNotebookSourceFileAccess('python', source)).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: ['source.pt'],
      writes: [],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it('does not certify a shadowed torch.load binding', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import torch\ntorch = custom_loader\nweights = torch.load('source.pt', weights_only=True)"
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: [],
      writes: []
    })
  })

  it('keeps weights-only loads conservative after a torch loader replacement', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import torch\nsetattr(torch, 'load', custom_loader)\nweights = torch.load('source.pt', weights_only=True)"
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: ['source.pt'],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it('keeps dependency facts conservative after a torch loader replacement', async () => {
    const { facts } = await analyzePythonNotebookSource(
      "import torch\nsetattr(torch, 'load', custom_loader)\nweights = torch.load('source.pt', weights_only=True)"
    )
    expect(facts.state).toBe('unknown')
    if (facts.state === 'unknown') expect(facts.reasons).toContain('external-state')
  })

  it('keeps weights-only loads conservative after same-cell safe-global registration', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import torch\ntorch.serialization.add_safe_globals([CustomTensor])\nweights = torch.load('source.pt', weights_only=True)"
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: ['source.pt'],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it('keeps weights-only loads conservative after deserializer registration', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import torch\ntorch.serialization.register_package(1, tagger, deserializer)\nweights = torch.load('source.pt', weights_only=True)"
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: ['source.pt'],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it('keeps dependency facts conservative after safe-global registration', async () => {
    const { facts } = await analyzePythonNotebookSource(
      "import torch\ntorch.serialization.add_safe_globals([CustomTensor])\nweights = torch.load('source.pt', weights_only=True)"
    )
    expect(facts.state).toBe('unknown')
    if (facts.state === 'unknown') expect(facts.reasons).toContain('external-state')
  })

  it('keeps weights-only loads conservative after global namespace taint', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "import torch\nweights = torch.load('source.pt', weights_only=True)",
        {
          staticStrings: [],
          staticCollections: [],
          localFileWrappers: [],
          pythonTaintedNamespaces: ['*']
        }
      )
    ).resolves.toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial',
      reads: ['source.pt'],
      reasonCodes: expect.arrayContaining(['source-analysis-unsupported-call'])
    })
  })

  it('carries safe-global taint into later cells in the same Python context', async () => {
    const registration = await analyzePythonNotebookSource(
      'import torch\ntorch.serialization.add_safe_globals([CustomTensor])'
    )
    const load = await analyzePythonNotebookSource(
      "import torch\nweights = torch.load('source.pt', weights_only=True)",
      registration.fileAccess?.context
    )

    expect(load.fileAccess).toMatchObject({
      reads: ['source.pt'],
      unresolvedReads: true,
      unsupportedExternalState: true
    })
  })

  it('carries deserializer-hook taint into later cells in the same Python context', async () => {
    const registration = await analyzePythonNotebookSource(
      'import torch\ntorch.serialization.register_package(1, tagger, deserializer)'
    )
    const load = await analyzePythonNotebookSource(
      "import torch\nweights = torch.load('source.pt', weights_only=True)",
      registration.fileAccess?.context
    )

    expect(load.fileAccess).toMatchObject({
      reads: ['source.pt'],
      unresolvedReads: true,
      unsupportedExternalState: true
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

  it('retains a Keras SavedModel directory root as partial output lineage', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "from tensorflow import keras\nmodel = keras.Sequential()\nkeras.models.save_model(model, 'saved-model')"
      )
    ).resolves.toMatchObject({
      externalState: 'partial',
      reads: [],
      writes: ['saved-model'],
      writeState: 'partial'
    })
  })

  it('retains a Keras SavedModel directory root as partial input lineage', async () => {
    await expect(
      analyzeNotebookSourceFileAccess(
        'python',
        "from tensorflow import keras\nrestored = keras.models.load_model('saved-model')"
      )
    ).resolves.toMatchObject({
      externalState: 'partial',
      reads: ['saved-model'],
      writes: [],
      readState: 'partial'
    })
  })
})

configureTestRuntimeMetadata()

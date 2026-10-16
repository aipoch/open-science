import { readFile } from 'node:fs/promises'

// The bundled native ONNX runtime traps during inference under Electron's V8 sandbox.
// Inject the supported WASM backend while retaining local file loading and the same model recipe.
const ort = await import('onnxruntime-web/wasm')
ort.env.wasm.numThreads = 1
// ONNX resolves its WASM module through import(); Windows drive paths are not module URLs.
// Its Node binary loader converts file:// strings to URL objects before fs.readFileSync.
ort.env.wasm.wasmPaths = new URL('./', import.meta.resolve('onnxruntime-web/wasm')).href
const createSession = ort.InferenceSession.create.bind(ort.InferenceSession)
ort.InferenceSession.create = async (model, options) =>
  createSession(typeof model === 'string' ? new Uint8Array(await readFile(model)) : model, options)
globalThis[Symbol.for('onnxruntime')] = ort
const { AutoModelForCausalLM, AutoTokenizer, env } = await import('@huggingface/transformers')

env.allowRemoteModels = false
env.allowLocalModels = true
env.useFSCache = false
env.useBrowserCache = false
env.useWasmCache = false
// Inference never downloads weights or contacts any provider.
globalThis.fetch = async () => {
  throw new Error('Network access is disabled for local translation.')
}

export { AutoModelForCausalLM, AutoTokenizer }

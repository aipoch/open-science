import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// The bundled native ONNX runtime traps during inference under Electron's V8 sandbox.
// Inject the supported WASM backend while retaining local file loading and the same model recipe.
const ort = await import('onnxruntime-web/wasm')
ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = fileURLToPath(new URL('./', import.meta.resolve('onnxruntime-web/wasm')))
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
let model
let tokenizer
let directory
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  let request
  try {
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error('Request limit exceeded.')
    request = JSON.parse(line)
    if (directory && directory !== request.directory) throw new Error('Model revision changed.')
    if (!model) {
      directory = request.directory
      tokenizer = await AutoTokenizer.from_pretrained(directory, { local_files_only: true })
      model = await AutoModelForCausalLM.from_pretrained(directory, {
        local_files_only: true,
        subfolder: '',
        dtype: 'q8',
        device: 'auto',
        session_options: { executionProviders: ['wasm'] }
      })
    }
    const inputs = tokenizer.apply_chat_template(
      [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.prompt }
      ],
      { tokenize: true, return_dict: true, add_generation_prompt: true, enable_thinking: false }
    )
    const inputTokens = inputs.input_ids.dims.at(-1)
    if (inputTokens > 4096) throw new Error('Input token limit exceeded.')
    const result = await model.generate({ ...inputs, max_new_tokens: 2048, do_sample: false })
    const generated = result.slice(null, [inputTokens, null])
    const text = tokenizer.batch_decode(generated, { skip_special_tokens: true })[0].trim()
    if (Buffer.byteLength(text) > request.outputLimitBytes)
      throw new Error('Output limit exceeded.')
    const outputTokens = generated.dims.at(-1)
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        text,
        stopReason: outputTokens >= 2048 ? 'max_tokens' : 'end_turn',
        usage: { inputTokens, outputTokens }
      }) + '\n'
    )
  } catch {
    process.stdout.write(JSON.stringify({ id: request?.id, error: 'inference-failed' }) + '\n')
  }
}
await model?.dispose()

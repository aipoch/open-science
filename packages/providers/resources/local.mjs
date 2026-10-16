/* eslint-disable @typescript-eslint/explicit-function-return-type */
// A generator owns one immutable model revision. Calls are sequential; the host owns scheduling.
export const createLocalTextGenerator = (runtime, directory) => {
  let model
  let tokenizer
  let active
  let closed = false
  let closing
  const execute = async (request) => {
    if (
      !Number.isSafeInteger(request.outputLimitBytes) ||
      request.outputLimitBytes < 1 ||
      typeof request.systemPrompt !== 'string' ||
      typeof request.prompt !== 'string'
    )
      throw new Error('Invalid local text request.')
    request.signal?.throwIfAborted()
    if (!model) {
      tokenizer = await runtime.AutoTokenizer.from_pretrained(directory, { local_files_only: true })
      model = await runtime.AutoModelForCausalLM.from_pretrained(directory, {
        local_files_only: true,
        subfolder: '',
        dtype: 'q8',
        device: 'auto',
        session_options: { executionProviders: ['wasm'] }
      })
    }
    request.signal?.throwIfAborted()
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
    request.signal?.throwIfAborted()
    const outputTokens = generated.dims.at(-1)
    return {
      text,
      stopReason: outputTokens >= 2048 ? 'max_tokens' : 'end_turn',
      usage: { inputTokens, outputTokens }
    }
  }
  return {
    run(request) {
      if (closed) return Promise.reject(new Error('Local text generator is closed.'))
      if (active) return Promise.reject(new Error('Local text generator is busy.'))
      active = execute(request).finally(() => {
        active = undefined
      })
      return active
    },
    dispose() {
      closed = true
      closing ??= (async () => {
        await active?.catch(() => undefined)
        await model?.dispose()
        model = undefined
        tokenizer = undefined
      })()
      return closing
    }
  }
}

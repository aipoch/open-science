import { expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const load = (): Promise<{
  createLocalTextGenerator: (runtime: unknown, directory: string) => Generator
}> => import(pathToFileURL(resolve(__dirname, '../resources/local.mjs')).href)
type Generator = {
  run(request: {
    systemPrompt: string
    prompt: string
    outputLimitBytes: number
    signal?: AbortSignal
  }): Promise<unknown>
  dispose(): Promise<void>
}
type Model = {
  generate: ReturnType<typeof vi.fn<() => Promise<{ slice: () => { dims: number[] } }>>>
  dispose: ReturnType<typeof vi.fn>
}
type Tokenizer = {
  apply_chat_template: ReturnType<typeof vi.fn<() => { input_ids: { dims: number[] } }>>
  batch_decode: ReturnType<typeof vi.fn>
}
type Runtime = {
  AutoTokenizer: { from_pretrained: ReturnType<typeof vi.fn> }
  AutoModelForCausalLM: { from_pretrained: ReturnType<typeof vi.fn> }
}
const setup = async (): Promise<{
  model: Model
  tokenizer: Tokenizer
  runtime: Runtime
  generator: Generator
}> => {
  const model = {
    generate: vi.fn(async () => ({ slice: () => ({ dims: [1, 2] }) })),
    dispose: vi.fn()
  }
  const tokenizer = {
    apply_chat_template: vi.fn(() => ({ input_ids: { dims: [1, 3] } })),
    batch_decode: vi.fn(() => [' text '])
  }
  const runtime = {
    AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
    AutoModelForCausalLM: { from_pretrained: vi.fn(async () => model) }
  }
  return {
    model,
    tokenizer,
    runtime,
    generator: (await load()).createLocalTextGenerator(runtime, '/approved/model')
  }
}
const request = { systemPrompt: 'system', prompt: 'hello', outputLimitBytes: 32 }
it('owns one model/tokenizer revision and releases it exactly once', async () => {
  const { generator, runtime, model } = await setup()
  expect(await generator.run(request)).toEqual({
    text: 'text',
    stopReason: 'end_turn',
    usage: { inputTokens: 3, outputTokens: 2 }
  })
  await generator.run(request)
  expect(runtime.AutoModelForCausalLM.from_pretrained).toHaveBeenCalledOnce()
  expect(runtime.AutoModelForCausalLM.from_pretrained).toHaveBeenCalledWith(
    '/approved/model',
    expect.objectContaining({
      local_files_only: true,
      session_options: { executionProviders: ['wasm'] }
    })
  )
  await Promise.all([generator.dispose(), generator.dispose()])
  expect(model.dispose).toHaveBeenCalledOnce()
  await expect(generator.run(request)).rejects.toThrow('closed')
})
it('rejects overlapping runs and drains inference before disposal', async () => {
  const { generator, model } = await setup()
  let finish!: () => void
  model.generate.mockImplementationOnce(async () => {
    await new Promise<void>((r) => {
      finish = r
    })
    return { slice: () => ({ dims: [1, 2] }) }
  })
  const run = generator.run(request)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await expect(generator.run(request)).rejects.toThrow('busy')
  const close = generator.dispose()
  expect(model.dispose).not.toHaveBeenCalled()
  finish()
  await run
  await close
  expect(model.dispose).toHaveBeenCalledOnce()
})
it('keeps input/output bounds and cancellation in the inference owner', async () => {
  const { generator, tokenizer } = await setup()
  await expect(generator.run({ ...request, outputLimitBytes: 1 })).rejects.toThrow('Output limit')
  tokenizer.apply_chat_template.mockReturnValue({ input_ids: { dims: [1, 4097] } })
  await expect(generator.run(request)).rejects.toThrow('Input token limit')
  await expect(generator.run({ ...request, signal: AbortSignal.abort() })).rejects.toThrow()
  await generator.dispose()
})

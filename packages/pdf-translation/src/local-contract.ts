export type PdfTranslationLocalTarget = Readonly<{ modelId: string; revision: string }>
export type LocalRequest = {
  target: PdfTranslationLocalTarget
  systemPrompt: string
  prompt: string
  signal: AbortSignal
  outputLimitBytes: number
}
export type LocalResult = {
  text: string
  stopReason: 'end_turn' | 'max_tokens'
  usage: { inputTokens: number; outputTokens: number; cacheTokens: number }
}
export type PdfTranslationLocalRuntime = {
  acquireTarget(): Promise<PdfTranslationLocalTarget>
  run(request: LocalRequest): Promise<LocalResult>
  release(target: PdfTranslationLocalTarget): Promise<void>
  shutdown(): Promise<void>
}

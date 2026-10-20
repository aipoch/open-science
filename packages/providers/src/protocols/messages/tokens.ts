/* eslint-disable @typescript-eslint/no-require-imports */
import type { Tiktoken as Tokenizer } from 'js-tiktoken/lite' with { 'resolution-mode': 'import' }
const {
  Tiktoken
}: typeof import('js-tiktoken/lite', {
  with: { 'resolution-mode': 'import' }
}) = require('js-tiktoken/lite')
// js-tiktoken provides CJS exports but labels its declarations ESM-only.
const o200kBase: typeof import('js-tiktoken/ranks/o200k_base', {
  with: { 'resolution-mode': 'import' }
}).default = require('js-tiktoken/ranks/o200k_base')

type Json = Record<string, unknown>
let tokenizer: Tokenizer | undefined
export const countMessagesInputTokens = (body: Json): number => {
  tokenizer ??= new Tiktoken(o200kBase)
  return tokenizer.encode(
    JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })
  ).length
}

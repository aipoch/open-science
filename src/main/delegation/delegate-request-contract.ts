import type { JsonSchema } from './structured-output'

export type DurableDelegateRequest = Readonly<{
  task: string
  name: string
  profile?: string
  inputs?: readonly string[]
  outputSchema?: JsonSchema
}>

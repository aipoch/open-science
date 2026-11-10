import { z } from 'zod'
import type { DiscoveredInterpreter } from '@aipoch/environment/contracts'

export const computePythonSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('managed') }),
  z.strictObject({ kind: z.literal('custom'), pythonPath: z.string().min(1).max(4096) })
])
export type ComputePythonSelection = z.infer<typeof computePythonSelectionSchema>
export const computeAccountOperationSchema = z.strictObject({
  operationId: z.string().min(1).max(128),
  revision: z.number().int().nonnegative()
})
export type ComputeAccountOperation = z.infer<typeof computeAccountOperationSchema>
export const computePythonSelectSchema = computeAccountOperationSchema.extend({
  selection: computePythonSelectionSchema
})
export type ComputePythonSelect = z.infer<typeof computePythonSelectSchema>
export type ComputePythonFailure =
  'cancelled' | 'runtime-stale' | 'disabled' | 'recovery' | 'dependency' | 'install' | 'storage'
export type ComputePythonResult = { revision: number; runtimeError?: ComputePythonFailure }
export type ComputePythonSnapshot = {
  selection: ComputePythonSelection
  revision: number
  candidates: DiscoveredInterpreter[]
}

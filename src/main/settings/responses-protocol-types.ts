// Responses payload schemas are provider-extensible at this protocol seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

export type ResponsesBridgeNamespacedTool = {
  namespace: string
  name: string
  description?: string
  parameters: JsonObject
  strict?: boolean
}

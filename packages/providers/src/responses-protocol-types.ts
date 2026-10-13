// Responses payload schemas are provider-extensible at this protocol seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

// One shared object per upstream reply. Identity, rather than equal reasoning text, determines
// which message/tool output items can be assembled back into the same assistant message.
export type ResponsesReplyReasoning = Readonly<{ text: string }>

export type ResponsesBridgeNamespacedTool = {
  namespace: string
  name: string
  description?: string
  parameters: JsonObject
  strict?: boolean
}

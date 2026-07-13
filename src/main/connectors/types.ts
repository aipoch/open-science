export type ConnectorCredentials = { ncbiEmail?: string; ncbiApiKey?: string }

export type ToolContext = {
  fetchJson(url: string): Promise<unknown>
  fetchText(url: string): Promise<string>
  // POST a JSON body and parse the JSON response — for GraphQL / POST-only APIs (e.g. gnomAD).
  postJson(url: string, body: unknown): Promise<unknown>
  credentials: ConnectorCredentials
}

// One connector tool = a request-mapper (url) + response-parser (parse), or a run() escape hatch.
export type ToolDescriptor = {
  id: string
  connector: string
  description: string
  input: Record<string, unknown> // JSON Schema for the tool args (also used by docs)
  required?: string[]
  format?: 'json' | 'text'
  url?: (args: Record<string, unknown>) => string
  parse?: (raw: unknown, args: Record<string, unknown>) => unknown
  run?: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>
}

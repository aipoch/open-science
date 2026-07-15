export type ConnectorCredentials = { ncbiEmail?: string; ncbiApiKey?: string }

export type ToolContext = {
  fetchJson(url: string): Promise<unknown>
  fetchText(url: string): Promise<string>
  // GET JSON plus the response headers — for APIs that report totals/pagination in headers rather than
  // the body (e.g. PRIDE Archive's `total_records`), which fetchJson alone would drop.
  fetchJsonWithHeaders(url: string): Promise<{ body: unknown; headers: Headers }>
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
  // Human-readable shape of the returned value, shown as a "Returns:" block in the skill doc so an
  // agent knows the result structure without running a probe cell. Free-form (prose or a shape sketch).
  returns?: string
  // A concrete, copy-runnable `host.mcp(...)` call for the skill doc, using realistic argument values
  // (e.g. real PMIDs) instead of the schema-derived placeholders. Just the call — general guidance
  // (result is reusable across cells, shape lives in Returns) belongs in the shared conventions
  // template, not repeated here. When omitted, the doc renders a bare call built from `input`.
  example?: string
  required?: string[]
  format?: 'json' | 'text'
  url?: (args: Record<string, unknown>) => string
  parse?: (raw: unknown, args: Record<string, unknown>) => unknown
  run?: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>
}

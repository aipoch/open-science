/** Configuration is resolved by the caller; the core does not own credential storage. */
export type ConnectorCredentials = Readonly<Record<string, string | undefined>>

export type ToolContext = {
  // For providers that own streaming/retry policy. The provider must pass its call signal.
  // Host-owned diagnostic policy. Without it, providers suppress untrusted error text.
  redactDiagnosticText?: (value: string) => string
  rawFetch?: typeof fetch
  signal?: AbortSignal
  fetchJson(url: string): Promise<unknown>
  // Disable automatic retries for APIs whose polling interval exceeds the call budget.
  fetchText(url: string, accept?: string, options?: { retry?: false }): Promise<string>
  // GET JSON plus the response headers — for APIs that report totals/pagination in headers rather than
  // the body (e.g. PRIDE Archive's `total_records`), which fetchJson alone would drop.
  // Opt into reading selected HTTP error bodies and inspect status before treating them as success.
  // Unlisted statuses still throw; response size limits, deadlines, and cancellation still apply.
  fetchJsonWithHeaders(
    url: string,
    options?: { allowHttpStatuses?: readonly number[] }
  ): Promise<{ body: unknown; headers: Headers; status: number }>
  // POST a JSON body and parse the JSON response. Set retry:false for submissions where a
  // lost response leaves the provider job outcome unknown and replaying could create a duplicate.
  // Opt into undefined for HTTP 204; other statuses still require valid JSON, including HTTP 200.
  postJson(
    url: string,
    body: unknown,
    options?: { retry?: false; allowNoContent?: true }
  ): Promise<unknown>
  // Submit multipart data once and parse JSON; never retry a potentially created job.
  postForm(url: string, body: FormData): Promise<unknown>
  // Submit multipart data once and return the raw response; useful for APIs whose JSON is
  // technically non-standard (for example, Enrichr may emit bare Infinity values).
  postFormText?: (url: string, body: FormData) => Promise<string>
  // Submit URL-encoded form data once and return the raw response.
  postUrlEncodedText?: (url: string, body: URLSearchParams) => Promise<string>
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
  // Optional caller-facing example text. Interpreted by documentation adapters, never executed.
  example?: string
  required?: string[]
  // Code-only dispatch metadata. It is not part of the generated tool schema or persisted state.
  credentialKeys?: readonly string[]
  /** Optional credential collection policy; the host owns prompting and reauthorization. */
  optionalCredential?: { id: string; key: string; retryStatus: number }
  requiredCredential?: string
  format?: 'json' | 'text'
  // Whole-call deadline, including retries, waits and all requests in run(). Overrides the engine default.
  totalTimeoutMs?: number
  // Raw response-body budget. Overrides the engine default for tools with unusually small or large payloads.
  maxResponseBytes?: number
  url?: (args: Record<string, unknown>) => string
  parse?: (raw: unknown, args: Record<string, unknown>) => unknown
  run?: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>
}

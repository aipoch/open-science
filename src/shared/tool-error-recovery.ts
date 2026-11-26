// The MCP SDK reports schema and lookup failures as bare errors. Agents read those as a broken tool
// and route around it, so each failure class gets one explicit next step.
export const TOOL_ARGUMENT_RECOVERY =
  'Correct only the reported arguments and call the same tool again. Do not switch to another tool or route because of this error.'
export const TOOL_NAME_RECOVERY =
  'Call only tools listed in your current tool list, using their exact names. Do not guess a different name.'

// Anchored to the SDK's McpError prefix so tool output that merely quotes these phrases (for
// example a traceback from a failed cell) is left unchanged.
const RECOVERY = [
  {
    pattern: /^MCP error -32602: Input validation error: Invalid arguments for tool /u,
    text: TOOL_ARGUMENT_RECOVERY
  },
  { pattern: /^MCP error -32602: Tool \S+ (?:not found|disabled)$/u, text: TOOL_NAME_RECOVERY },
  {
    pattern: /^MCP error -32602: Output validation error: /u,
    text: 'The tool ran but returned an invalid result. Do not repeat the call; report the failure to the user.'
  }
] as const

type ToolResult = { isError?: unknown; content?: unknown }
type TextItem = { type: 'text'; text: string }

const isTextItem = (item: unknown): item is TextItem =>
  typeof item === 'object' &&
  item !== null &&
  (item as TextItem).type === 'text' &&
  typeof (item as TextItem).text === 'string'

// Keeps the original error text first so existing failure classifiers keep matching it.
const withToolErrorRecovery = <Result>(result: Result): Result => {
  const { isError, content } = (result ?? {}) as ToolResult
  if (isError !== true || !Array.isArray(content)) return result
  const index = content.findIndex(isTextItem)
  if (index < 0) return result
  const text = (content[index] as TextItem).text
  const recovery = RECOVERY.find(({ pattern }) => pattern.test(text))
  if (!recovery || text.includes(recovery.text)) return result
  const next = [...content]
  next[index] = { ...(content[index] as TextItem), text: `${text}\n${recovery.text}` }
  return { ...result, content: next }
}

type RequestHandler = (request: { method?: unknown }, extra: unknown) => unknown
type RequestHandlerHost = {
  setRequestHandler: (schema: unknown, handler: RequestHandler) => void
}

// Wraps the tools/call handler an MCP server registers after this call. Pass the SDK McpServer
// before its first registerTool so the handler is installed through the wrapped method.
export const installToolErrorRecovery = <Server extends { server: object }>(
  server: Server
): Server => {
  const protocol = server.server as RequestHandlerHost
  const setRequestHandler = protocol.setRequestHandler.bind(protocol)
  protocol.setRequestHandler = (schema, handler) =>
    setRequestHandler(schema, async (request, extra) => {
      const result = await handler(request, extra)
      return request.method === 'tools/call' ? withToolErrorRecovery(result) : result
    })
  return server
}

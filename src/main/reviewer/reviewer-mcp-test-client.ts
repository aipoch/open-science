export type SubmittedReviewerCheck = {
  status: 'pass' | 'warn' | 'fail'
  claim: string
  evidence: string
  sourceFindingId?: string
  artifactVersionId?: string
  locator?: {
    blockRef: { messageId?: string; activityId?: string; blockIndex: number }
    contentHash: string
  }
}

type ToolResult = {
  content?: Array<{ text?: string }>
  isError?: boolean
}

type JsonRpcResponse = {
  result?: ToolResult
  error?: { message?: string }
}

type FrozenBlock = {
  blockIndex: number
  kind: 'message' | 'activity'
  sourceId: string
  contentHash: string
}

const MCP_ACCEPT = 'application/json, text/event-stream'

const parseMcpSseBody = (body: string): JsonRpcResponse => {
  const dataLine = body.split('\n').find((line) => line.startsWith('data:'))
  const json = dataLine ? dataLine.slice('data:'.length).trim() : body.trim()
  return json ? (JSON.parse(json) as JsonRpcResponse) : {}
}

export const callSubmitFindingsAfterReadingEvidence = async (
  mcpBaseUrl: string,
  token: string,
  checks: SubmittedReviewerCheck[]
): Promise<void> => {
  const baseHeaders = {
    'content-type': 'application/json',
    accept: MCP_ACCEPT,
    authorization: `Bearer ${token}`
  }
  const initResponse = await fetch(mcpBaseUrl, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0' }
      }
    })
  })
  if (!initResponse.ok) throw new Error(`MCP initialize failed: ${initResponse.status}`)

  const initJson = parseMcpSseBody(await initResponse.text())
  const sessionId = initResponse.headers.get('mcp-session-id')
  if (!sessionId || !initJson.result) throw new Error('MCP initialize did not return a session id')

  const headers = { ...baseHeaders, 'mcp-session-id': sessionId }
  await fetch(mcpBaseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  })

  let nextId = 2
  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const response = await fetch(mcpBaseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    })
    if (!response.ok) throw new Error(`${name} call failed: ${response.status}`)
    const payload = parseMcpSseBody(await response.text())
    if (payload.error) throw new Error(`${name} error: ${payload.error.message ?? 'unknown'}`)
    if (payload.result?.isError) {
      throw new Error(payload.result.content?.[0]?.text ?? `${name} returned an error`)
    }
    return payload.result ?? {}
  }

  const turn = await callTool('read_turn', {})
  const blocks = JSON.parse(turn.content?.[0]?.text ?? '[]') as FrozenBlock[]
  const blocksByIndex = new Map(blocks.map((block) => [block.blockIndex, block]))
  const activityIds = new Set(
    checks.flatMap((check) => {
      const block = check.locator ? blocksByIndex.get(check.locator.blockRef.blockIndex) : undefined
      return block?.kind === 'activity' ? [block.sourceId] : []
    })
  )
  for (const activityId of activityIds) {
    await callTool('query_execution_log', { activityId })
  }
  for (const artifactVersionId of new Set(
    checks.flatMap((check) => (check.artifactVersionId ? [check.artifactVersionId] : []))
  )) {
    await callTool('read_artifact', { id: artifactVersionId })
  }

  const scopedChecks = checks.map((check) => {
    if (!check.locator) return check
    const block = blocksByIndex.get(check.locator.blockRef.blockIndex)
    if (!block) return check
    return {
      ...check,
      locator: {
        blockRef: { blockIndex: block.blockIndex },
        contentHash: block.contentHash
      }
    }
  })
  await callTool('submit_findings', { checks: scopedChecks })
}

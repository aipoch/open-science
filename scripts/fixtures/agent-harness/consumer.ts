import {
  openAgentSession,
  type AgentModel,
  type AgentSessionOptions,
  type AgentSessionInspection,
  type AgentStore
} from '@aipoch/agent-harness'
import { loadMcpTools } from '@aipoch/agent-harness/mcp'
import { createChatCompletionsModel } from '@aipoch/agent-harness/chat-completions'
import { createResponsesModel } from '@aipoch/agent-harness/responses'
import { createMessagesModel } from '@aipoch/agent-harness/messages'

declare const model: AgentModel
declare const store: AgentStore
const options: AgentSessionOptions = {
  sessionId: 'consumer',
  model,
  store,
  maxSteps: 2,
  maxOutputTokens: 64
}
const session = await openAgentSession(options)
const inspection: AgentSessionInspection = await session.inspect({ requestsFrom: 0 })
void inspection.requestCount
await session.dispose()
void [loadMcpTools, createChatCompletionsModel, createResponsesModel, createMessagesModel]

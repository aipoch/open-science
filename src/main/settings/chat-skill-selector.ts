import type { SkillSelectorUsageObservation } from '../agent-framework'
import { createLogger } from '../logger'
import type { OfficialVendorId } from '../../shared/provider-registry'
import type { CustomReasoningEffortTransport } from '../../shared/reasoning-effort'
import { normalizeOpenAiChatModelStepUsage } from './openai-chat-usage'
import { resolveChatReasoningTransport } from './reasoning-transport'
import {
  boundedSkillSelectorCatalog,
  renderSkillSelectorCatalog,
  resolveSelectedSkills,
  selectExplicitConnectorSkills
} from './skill-selector-routing'

// The selector deliberately accepts provider JSON without widening the rest of the settings layer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

type ChatSkillSelectorTarget = {
  url: string
  key?: string
  model?: string
  vendorId?: OfficialVendorId
  reasoningEffortTransport?: CustomReasoningEffortTransport
}

export type ChatSkillSelectorCandidate = {
  name: string
  description: string
  path: string
  source?: 'connector'
}

export type ChatSkillSelectorInput = Pick<ChatSkillSelectorCandidate, 'name' | 'path'>

const log = createLogger('acp-bridge')

const parseSelectionContent = (content: unknown): JsonObject | undefined => {
  if (typeof content !== 'string') return undefined
  const withoutThinking = content.trim().replace(/^<think>[\s\S]*?<\/think>\s*/i, '')
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(withoutThinking)
  try {
    const parsed = JSON.parse((fenced?.[1] ?? withoutThinking).trim()) as JsonObject
    return Array.isArray(parsed?.skill_names) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function selectChatSkills(input: {
  text: string
  catalog: ChatSkillSelectorCandidate[]
  target: ChatSkillSelectorTarget
  fetchImpl: typeof fetch
  timeoutMs: number
  signal?: AbortSignal
  observeUsage?: (observation: SkillSelectorUsageObservation) => void
}): Promise<ChatSkillSelectorInput[]> {
  const { text, catalog, target, fetchImpl, signal, observeUsage } = input
  if (!text.trim() || catalog.length === 0 || signal?.aborted) return []
  const explicit = selectExplicitConnectorSkills(text, catalog)
  if (explicit.length > 0) return explicit
  const selectorCatalog = boundedSkillSelectorCatalog(catalog)
  if (selectorCatalog.length === 0) return []

  const timeout = new AbortController()
  let timedOut = false
  const abortFromCaller = (): void => timeout.abort(signal?.reason)
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    timeout.abort()
  }, input.timeoutMs)
  timer.unref?.()
  try {
    const reasoningTransport = resolveChatReasoningTransport(
      target.vendorId,
      target.model,
      'none',
      target.reasoningEffortTransport
    )
    const request = (withTool: boolean): Promise<Response> =>
      fetchImpl(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(target.key ? { authorization: `Bearer ${target.key}` } : {})
        },
        body: JSON.stringify({
          model: target.model,
          stream: false,
          temperature: 0,
          max_tokens: 512,
          ...(reasoningTransport.reasoningEffort
            ? { reasoning_effort: reasoningTransport.reasoningEffort }
            : {}),
          ...(reasoningTransport.thinking ? { thinking: reasoningTransport.thinking } : {}),
          ...(reasoningTransport.reasoning ? { reasoning: reasoningTransport.reasoning } : {}),
          messages: [
            {
              role: 'system',
              content:
                (withTool
                  ? 'You are a Skill routing classifier. Select only the Skills needed to execute the current user request. Do not perform the task. Call select_skills exactly once. If function calling is unavailable, return exactly one JSON object in the form {"skill_names":[]} with no prose.'
                  : 'You are a Skill routing classifier. Select only the Skills needed to execute the current user request. Do not perform the task. Return exactly one JSON object in the form {"skill_names":[]} with no prose.') +
                ' Use only catalog names. Return an empty list when no Skill applies.\n\nSkill catalog:\n' +
                renderSkillSelectorCatalog(selectorCatalog)
            },
            { role: 'user', content: text }
          ],
          ...(withTool
            ? {
                tools: [
                  {
                    type: 'function',
                    function: {
                      name: 'select_skills',
                      description:
                        'Select zero to three applicable Skills from the provided catalog.',
                      parameters: {
                        type: 'object',
                        properties: {
                          skill_names: {
                            type: 'array',
                            maxItems: 3,
                            items: { type: 'string' }
                          }
                        },
                        required: ['skill_names'],
                        additionalProperties: false
                      }
                    }
                  }
                ],
                tool_choice: { type: 'function', function: { name: 'select_skills' } }
              }
            : {})
        }),
        signal: timeout.signal
      })
    const decode = async (
      response: Response
    ): Promise<{ selected: ChatSkillSelectorInput[]; mode: 'function' | 'json' } | undefined> => {
      if (!response.ok) return undefined
      const completion = (await response.json()) as JsonObject
      const usage = normalizeOpenAiChatModelStepUsage(completion.usage)
      if (usage) {
        observeUsage?.({
          usage,
          ...(typeof completion.id === 'string' ? { sourceInvocationId: completion.id } : {})
        })
      }
      const message = completion.choices?.[0]?.message
      const calls = message?.tool_calls
      const call = Array.isArray(calls)
        ? calls.find((candidate) => candidate?.function?.name === 'select_skills')
        : undefined
      let args: JsonObject | undefined
      let mode: 'function' | 'json' = 'function'
      if (typeof call?.function?.arguments === 'string') {
        try {
          args = JSON.parse(call.function.arguments) as JsonObject
        } catch {
          args = undefined
        }
      } else {
        args = parseSelectionContent(message?.content)
        mode = 'json'
      }
      if (!Array.isArray(args?.skill_names)) return undefined
      return { selected: resolveSelectedSkills(args.skill_names, selectorCatalog), mode }
    }

    let result: Awaited<ReturnType<typeof decode>>
    try {
      const primary = await decode(await request(true))
      result = primary ?? (timeout.signal.aborted ? undefined : await decode(await request(false)))
    } catch {
      const reason = timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'invalid-response'
      log.warn('bridge skill selection failed', { model: target.model, reason })
      if (signal?.aborted) return []
      throw new Error(`Skill selector failed (${reason}).`)
    }
    if (!result) {
      const reason = timeout.signal.aborted
        ? signal?.aborted
          ? 'cancelled'
          : 'timeout'
        : 'invalid-response'
      log.warn('bridge skill selection failed', {
        model: target.model,
        reason
      })
      if (signal?.aborted) return []
      throw new Error(`Skill selector failed (${reason}).`)
    }
    log.info('bridge skill selection completed', {
      model: target.model,
      catalogCount: catalog.length,
      routedCatalogCount: selectorCatalog.length,
      selectionMode: result.mode,
      selectedNames: result.selected.map(({ name }) => name)
    })
    return result.selected
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

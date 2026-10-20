import { randomBytes } from 'node:crypto'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  responseEnvelope,
  responseFunctionIdentity,
  chatUsageToResponsesUsage,
  chatTerminalDetails,
  hasUpstreamImageField,
  unsupportedUpstreamImageOutput,
  upstreamTextFromContent,
  ResponsesProtocolError
} from './response'
import type { ResponsesNamespacedTool } from './types'
// Provider protocol objects are validated while each supported field is consumed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>
const log = createLogger('providers.responses')
export function createResponseStreamState(
  model: string,
  namespacedTools: readonly ResponsesNamespacedTool[]
): {
  drain(): JsonObject[]
  consume(chunk: JsonObject): void
  finish(
    error: unknown,
    sawDone: boolean
  ): { reasoning: string; callIds: string[]; messageId?: string }
} {
  let events: JsonObject[] = []
  const emit = (type: string, sequence: number, fields: JsonObject = {}): void => {
    // Events preserve their value at emission even while output items keep accumulating deltas.
    events.push({ type, sequence_number: sequence, ...structuredClone(fields) })
  }
  const responseId = `resp_${randomBytes(8).toString('hex')}`
  const output: JsonObject[] = []
  const toolItems = new Map<number, { chatId: string; chatName: string; item?: JsonObject }>()
  let textItem: JsonObject | undefined
  let reasoning = ''
  let usage: JsonObject | undefined
  let sequence = 0
  emit('response.created', sequence++, {
    response: responseEnvelope(responseId, model, [])
  })
  emit('response.in_progress', sequence++, {
    response: responseEnvelope(responseId, model, [])
  })

  let terminalFinishReason: string | undefined
  const ensureToolItem = (index: number): JsonObject => {
    const state = toolItems.get(index) ?? { chatId: '', chatName: '' }
    toolItems.set(index, state)
    if (state.item) return state.item

    const identity = responseFunctionIdentity(state.chatName, namespacedTools)
    const callId = state.chatId || `call_${responseId}_${index}`
    const item: JsonObject = {
      id: `fc_${callId}_${index}`,
      type: 'function_call',
      status: 'in_progress',
      call_id: callId,
      ...identity,
      arguments: ''
    }
    state.item = item
    output.push(item)
    emit('response.output_item.added', sequence++, {
      output_index: output.indexOf(item),
      item
    })
    return item
  }
  const consume = (chunk: JsonObject): void => {
    usage = chatUsageToResponsesUsage(chunk.usage) ?? usage
    const finishReason = chunk.choices?.[0]?.finish_reason
    if (typeof finishReason === 'string' && finishReason.length > 0) {
      terminalFinishReason = finishReason
    }
    const delta = chunk.choices?.[0]?.delta ?? {}
    if (hasUpstreamImageField(delta)) throw unsupportedUpstreamImageOutput()
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    const contentText = upstreamTextFromContent(delta.content)
    const textDelta =
      contentText.length > 0
        ? contentText
        : typeof delta.refusal === 'string' && delta.refusal.length > 0
          ? delta.refusal
          : ''
    if (textDelta) {
      if (!textItem) {
        textItem = {
          id: `msg_${responseId}`,
          type: 'message',
          status: 'in_progress',
          role: 'assistant',
          content: []
        }
        output.push(textItem)
        emit('response.output_item.added', sequence++, {
          output_index: output.length - 1,
          item: textItem
        })
        emit('response.content_part.added', sequence++, {
          item_id: textItem.id,
          output_index: output.length - 1,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] }
        })
      }
      emit('response.output_text.delta', sequence++, {
        item_id: textItem.id,
        output_index: output.indexOf(textItem),
        content_index: 0,
        delta: textDelta
      })
      textItem.content.push({ type: 'output_text', text: textDelta, annotations: [] })
    }
    for (const call of delta.tool_calls ?? []) {
      const index = Number(call.index ?? 0)
      const state = toolItems.get(index) ?? { chatId: '', chatName: '' }
      toolItems.set(index, state)
      if (typeof call.id === 'string') state.chatId += call.id
      if (typeof call.function?.name === 'string') state.chatName += call.function.name
      const argumentsDelta = call.function?.arguments ?? ''
      if (!argumentsDelta && !state.item) continue
      const item = ensureToolItem(index)
      item.arguments += argumentsDelta
      if (argumentsDelta) {
        emit('response.function_call_arguments.delta', sequence++, {
          item_id: item.id,
          output_index: output.indexOf(item),
          delta: argumentsDelta
        })
      }
    }
  }

  let finished = false
  return {
    drain(): JsonObject[] {
      const next = events
      events = []
      return next
    },
    consume(chunk: JsonObject): void {
      if (finished) throw new Error('Response is already terminal')
      consume(chunk)
    },
    finish(
      streamError: unknown,
      sawDone: boolean
    ): { reasoning: string; callIds: string[]; messageId?: string } {
      if (finished) throw new Error('Response is already terminal')
      finished = true
      let terminal = chatTerminalDetails(undefined)
      try {
        terminal = chatTerminalDetails(terminalFinishReason)
      } catch (error) {
        streamError ??= error
      }
      for (const index of toolItems.keys()) ensureToolItem(index)

      for (const item of output) {
        item.status =
          streamError || (!terminalFinishReason && !sawDone) ? 'incomplete' : terminal.status
        const outputIndex = output.indexOf(item)
        if (item.type === 'message') {
          const text = item.content.map((part: JsonObject) => part.text).join('')
          item.content = [{ type: 'output_text', text, annotations: [] }]
          emit('response.output_text.done', sequence++, {
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            text
          })
          emit('response.content_part.done', sequence++, {
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            part: item.content[0]
          })
        } else {
          emit('response.function_call_arguments.done', sequence++, {
            item_id: item.id,
            output_index: outputIndex,
            arguments: item.arguments
          })
        }
        emit('response.output_item.done', sequence++, {
          output_index: outputIndex,
          item
        })
      }
      if (streamError instanceof ResponsesProtocolError) {
        log.warn('bridge unsupported upstream output', { model, type: streamError.type })
        emit('response.failed', sequence++, {
          response: responseEnvelope(responseId, model, output, undefined, 'failed', {
            type: streamError.type,
            message: streamError.message
          })
        })
      } else if (streamError) {
        log.warn('bridge stream error', {
          model,
          error: streamError instanceof Error ? streamError.message : String(streamError)
        })
        emit('response.failed', sequence++, {
          response: responseEnvelope(responseId, model, output, usage, 'failed', {
            type: 'upstream_error',
            message: 'Upstream stream ended before completion'
          })
        })
      } else if (terminal.status === 'completed' && terminalFinishReason) {
        emit('response.completed', sequence++, {
          response: responseEnvelope(responseId, model, output, usage)
        })
      } else if (terminalFinishReason) {
        log.warn('bridge stream incomplete', { model, finishReason: terminalFinishReason })
        emit('response.incomplete', sequence++, {
          response: {
            ...responseEnvelope(responseId, model, output, usage, 'incomplete'),
            incomplete_details: terminal.incomplete_details
          }
        })
      } else if (sawDone) {
        emit('response.completed', sequence++, {
          response: responseEnvelope(responseId, model, output, usage)
        })
      } else {
        log.warn('bridge stream truncated (no terminal finish_reason)', { model })
        emit('response.failed', sequence++, {
          response: responseEnvelope(responseId, model, output, usage, 'failed', {
            type: 'upstream_incomplete',
            message: 'Upstream stream ended without a terminal finish_reason'
          })
        })
      }

      const toolCalls = output.filter((item) => item.type === 'function_call')
      log.info('bridge turn completed (stream)', {
        model,
        textItems: output.filter((item) => item.type === 'message').length,
        toolCalls: toolCalls.length,
        toolNames: toolCalls.map((item) => item.name)
      })

      return {
        reasoning,
        callIds: toolCalls.map((item) => String(item.call_id)),
        ...(textItem ? { messageId: String(textItem.id) } : {})
      }
    }
  }
}

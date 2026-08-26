import type { PromptResponse } from '@agentclientprotocol/sdk'

import type { AcpModelStepTokenUsage, AcpTurnTokenUsage } from '../../shared/acp'

/**
 * Provider-facing identity and workspace facts for one prompt attempt.
 *
 * This deliberately carries the replaceable provider Session id rather than the stable application
 * Session id. Provider credentials and provider-specific probe configuration belong to the concrete
 * adapter's construction dependencies, not to the shared turn seam.
 */
export type AcpProviderTurnBeginInput = Readonly<{
  providerSessionId: string
  cwd: string
}>

/**
 * The provider stop response is the only terminal provider payload exposed at this seam. Adapters
 * may inspect it to recover usage metadata, but the executor keeps ownership of the raw response.
 */
export type AcpProviderTurnFinalizationInput = Readonly<{
  response: Readonly<PromptResponse>
}>

export type AcpProviderModelCallUsage = Readonly<
  AcpModelStepTokenUsage & {
    sourceInvocationId?: string
    contextUsedTokens?: number
    contextWindowSize?: number
  }
>

/**
 * Best-effort provider facts for a completed turn.
 *
 * Every fact is optional because provider adapters can omit, reject, or partially report usage.
 * Present counters must already be normalized and validated by the concrete adapter:
 *
 * - token counters and `contextUsedTokens` are non-negative safe integers;
 * - `modelTurnCount` is a positive safe integer;
 * - cached read/write counters appear together when the provider exposes both;
 * - model-turn count appears only in `modelTurnCount`, never nested in token usage.
 *
 * Durable interaction, context, and Session owners decide whether and how to publish these facts.
 */
export type AcpProviderTurnResult = Readonly<{
  turnUsage?: Readonly<Omit<AcpTurnTokenUsage, 'turnCount'>>
  modelTurnCount?: number
  modelCalls?: ReadonlyArray<AcpProviderModelCallUsage>
  contextUsedTokens?: number
  lastModelStepUsage?: Readonly<AcpModelStepTokenUsage>
}>

/**
 * Opaque turn-scoped observation lifetime returned by an adapter.
 *
 * The probe exposes no provider state. `observe`, when present, accepts an out-of-band provider
 * message such as Claude Code's `_claude/sdkMessage`; malformed or unrelated values are ignored by
 * the concrete adapter. A caller terminates the probe exactly once with `finalize` after provider
 * stop or `cancel` when the attempt is rejected, cancelled, or superseded.
 */
export type AcpProviderTurnProbe = Readonly<{
  observe?: (message: unknown) => void
  finalize: (
    input: AcpProviderTurnFinalizationInput
  ) => AcpProviderTurnResult | Promise<AcpProviderTurnResult>
  cancel: () => void | Promise<void>
}>

/**
 * Provider-specific observation adapter selected for one backend generation.
 *
 * `begin` may perform a best-effort before-probe (OpenCode) or simply allocate local observation
 * state (Claude Code/Codex). Missing provider data is represented by an empty final result rather
 * than by widening this interface with provider payloads or application-owner concerns.
 */
export type AcpProviderTurnAdapter = Readonly<{
  begin: (input: AcpProviderTurnBeginInput) => AcpProviderTurnProbe | Promise<AcpProviderTurnProbe>
}>

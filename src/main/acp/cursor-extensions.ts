// Cursor-specific ACP requests are blocking. Until Open Science has native question and plan
// approval UI, return documented fallback outcomes so Cursor can continue instead of receiving
// JSON-RPC method-not-found and stalling the prompt.
const CURSOR_ASK_QUESTION_METHOD = 'cursor/ask_question'
const CURSOR_CREATE_PLAN_METHOD = 'cursor/create_plan'

type CursorAskQuestionFallbackResponse = {
  outcome: { outcome: 'skipped'; reason: string }
}

type CursorCreatePlanFallbackResponse = {
  outcome: { outcome: 'rejected'; reason: string }
}

const parseCursorExtensionParams = (params: unknown): unknown => params

const skipCursorQuestion = (): CursorAskQuestionFallbackResponse => ({
  outcome: {
    outcome: 'skipped',
    reason: 'Open Science does not support Cursor interactive questions yet.'
  }
})

const rejectCursorPlan = (): CursorCreatePlanFallbackResponse => ({
  outcome: {
    outcome: 'rejected',
    reason: 'Open Science does not support Cursor plan approval yet.'
  }
})

export {
  CURSOR_ASK_QUESTION_METHOD,
  CURSOR_CREATE_PLAN_METHOD,
  parseCursorExtensionParams,
  rejectCursorPlan,
  skipCursorQuestion
}

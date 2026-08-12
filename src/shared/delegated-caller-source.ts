const NESTED_DELEGATE_INVOCATION_SEPARATOR = '\u0000delegate\u0000'
const DELEGATION_CALL_ID_PATTERN = /^[1-9]\d{0,15}$/u

const createNestedDelegateInvocationId = (
  controlInvocationId: string,
  delegationCallId: string
): string => {
  if (
    !controlInvocationId ||
    controlInvocationId.includes(NESTED_DELEGATE_INVOCATION_SEPARATOR) ||
    !DELEGATION_CALL_ID_PATTERN.test(delegationCallId)
  ) {
    throw new Error('Nested delegated-work invocation identity is invalid.')
  }
  return `${controlInvocationId}${NESTED_DELEGATE_INVOCATION_SEPARATOR}${delegationCallId}`
}

const parseNestedDelegateInvocationId = (
  value: string
): Readonly<{ controlInvocationId: string; delegationCallId: string }> | undefined => {
  const separatorIndex = value.indexOf(NESTED_DELEGATE_INVOCATION_SEPARATOR)
  if (
    separatorIndex <= 0 ||
    separatorIndex !== value.lastIndexOf(NESTED_DELEGATE_INVOCATION_SEPARATOR)
  ) {
    return undefined
  }
  const controlInvocationId = value.slice(0, separatorIndex)
  const delegationCallId = value.slice(separatorIndex + NESTED_DELEGATE_INVOCATION_SEPARATOR.length)
  return controlInvocationId && DELEGATION_CALL_ID_PATTERN.test(delegationCallId)
    ? { controlInvocationId, delegationCallId }
    : undefined
}

export { createNestedDelegateInvocationId, parseNestedDelegateInvocationId }

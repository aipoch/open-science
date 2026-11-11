import type { Recognizer } from '../contract'

const overflow =
  /media[_\s-]?unstrippable|request[_\s-]?(?:entity[_\s-]?)?too[_\s-]?large|maximum context length|context[_\s-]?length[_\s-]?exceeded|prompt is too long/i

export const recognizeInput: Recognizer = ({ status, code, text = '' }) => {
  if (
    status === 413 ||
    code === 'ContextOverflowError' ||
    overflow.test(String(code ?? '')) ||
    overflow.test(text)
  )
    return { category: 'input', reason: 'input/context-overflow', diagnostics: {} }
  if (
    /The attached image is (?:too large to prepare for the Vision model|invalid)\.|The current (?:images exceed the Vision evidence|Vision evidence exceeds the) request budget\.|This conversation needs image replay, but the selected model does not support image input\./.test(
      text
    )
  )
    return { category: 'input', reason: 'input/media-invalid', diagnostics: {} }
  if (
    /unsupported (?:attachment|image|media|file) (?:type|format)|(?:attachment|image|media|file) (?:type|format) (?:is )?not supported/i.test(
      text
    )
  )
    return { category: 'input', reason: 'input/attachment-unsupported', diagnostics: {} }
  return undefined
}

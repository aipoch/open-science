import type { JournalStatement } from './ports.js'
/** Internal parameterized SQL composition. Values are never interpolated into SQL text. */
class Statement implements JournalStatement {
  constructor(
    readonly text: string,
    readonly values: readonly unknown[]
  ) {}
}
export function sql(strings: TemplateStringsArray, ...values: unknown[]): JournalStatement {
  let text = strings[0]
  const parameters: unknown[] = []
  for (const [index, value] of values.entries()) {
    if (value instanceof Statement) {
      text += value.text
      parameters.push(...value.values)
    } else {
      text += '?'
      parameters.push(value)
    }
    text += strings[index + 1]
  }
  return new Statement(text, parameters)
}
export function joinSql(values: readonly unknown[], separator = ','): JournalStatement {
  if (!values.length) throw new Error('Cannot compose an empty SQL list')
  const parts = values.map((value) =>
    value instanceof Statement ? value : new Statement('?', [value])
  )
  return new Statement(
    parts.map((part) => part.text).join(separator),
    parts.flatMap((part) => [...part.values])
  )
}

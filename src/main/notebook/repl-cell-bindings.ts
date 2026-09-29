import { randomUUID } from 'node:crypto'
import { fieldChild, withParsedNotebookSource, type Node } from './dependency-analysis-parser'

// Publish bindings from the existing per-cell async function, rather than replacing its JS
// semantics. This preserves top-level return, await and declarations repeated in later cells.
export type ReplCellBindings = { publisher: string; source: string }

export async function prepareReplCellBindings(source: string): Promise<ReplCellBindings> {
  const publisher = `__open_science_publish_${randomUUID().replaceAll('-', '')}`
  const parsed = await withParsedNotebookSource('javascript', source, (root) => {
    const bindings = new Set<string>()
    const names = (node: Node | null): string[] => {
      if (!node) return []
      if (['identifier', 'shorthand_property_identifier_pattern'].includes(node.type))
        return [node.text]
      if (node.type === 'pair_pattern') return names(fieldChild(node, 'value'))
      if (node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern')
        return names(fieldChild(node, 'left'))
      return node.namedChildren.flatMap(names)
    }
    const publish = (bindings: string[]): string =>
      bindings
        .map(
          (name) =>
            `${publisher}(${JSON.stringify(name)},()=>${name},${publisher}_value=>${name}=${publisher}_value);`
        )
        .join('')
    for (const statement of root.namedChildren) {
      if (['lexical_declaration', 'variable_declaration'].includes(statement.type)) {
        for (const declaration of statement.namedChildren) {
          if (declaration.type !== 'variable_declarator') continue
          for (const name of names(fieldChild(declaration, 'name'))) bindings.add(name)
        }
      } else if (
        ['function_declaration', 'generator_function_declaration', 'class_declaration'].includes(
          statement.type
        )
      ) {
        for (const name of names(fieldChild(statement, 'name'))) bindings.add(name)
      }
    }
    const collectHoisted = (node: Node): void => {
      if (
        [
          'function_declaration',
          'generator_function_declaration',
          'function_expression',
          'generator_function',
          'arrow_function',
          'method_definition',
          'class_declaration',
          'class'
        ].includes(node.type)
      )
        return
      if (node.type === 'variable_declaration')
        for (const declaration of node.namedChildren)
          for (const name of names(fieldChild(declaration, 'name'))) bindings.add(name)
      if (node.type === 'for_in_statement' && fieldChild(node, 'kind')?.text === 'var')
        for (const name of names(fieldChild(node, 'left'))) bindings.add(name)
      node.namedChildren.forEach(collectHoisted)
    }
    collectHoisted(root)
    let prologueEnd = 0
    for (const statement of root.namedChildren) {
      if (
        statement.type === 'comment' ||
        (statement.type === 'expression_statement' && statement.namedChildren[0]?.type === 'string')
      )
        prologueEnd = statement.endIndex
      else break
    }
    return (
      source.slice(0, prologueEnd) +
      '\n;' +
      publish([...bindings]) +
      '\n' +
      source.slice(prologueEnd)
    )
  })
  // Preserve the runtime's own syntax diagnostic; a parser failure must never silently execute
  // valid code with a different state contract.
  if (parsed.state !== 'ok') {
    if (parsed.reason === 'parse-error') return { publisher, source }
    throw new Error(`REPL cell preparation failed: ${parsed.reason}`)
  }
  return { publisher, source: parsed.value }
}

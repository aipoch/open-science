import { fieldChild, withParsedNotebookSource, type Node } from './dependency-analysis-parser'

// This is an invalidation guard, not an evaluator. Unknown namespace access discards
// the launch-time bindings; it never guesses the environment left by executed code.
const managedEnvironmentIsReadOnly = async (
  language: 'python' | 'r' | 'repl',
  source: string
): Promise<boolean> => {
  if (language === 'r') return false
  const parsed = await withParsedNotebookSource(
    language === 'repl' ? 'javascript' : 'python',
    source,
    (root) => {
      let safe = true
      const aliases = new Set(['os'])
      const nodes: Node[] = []
      const collect = (node: Node): void => {
        nodes.push(node)
        node.namedChildren.forEach(collect)
      }
      collect(root)
      for (const node of nodes) {
        if (node.type === 'aliased_import' && fieldChild(node, 'name')?.text === 'os') {
          const alias = fieldChild(node, 'alias')?.text
          if (alias) aliases.add(alias)
        }
      }
      const isWriteTarget = (node: Node): boolean => {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (
            [
              'assignment',
              'augmented_assignment',
              'assignment_expression',
              'augmented_assignment_expression',
              'variable_declarator'
            ].includes(parent.type)
          ) {
            const target = fieldChild(parent, 'left') ?? fieldChild(parent, 'name')
            if (target && target.startIndex <= node.startIndex && target.endIndex >= node.endIndex)
              return true
          }
          if (['delete_statement', 'update_expression'].includes(parent.type)) return true
        }
        return false
      }
      for (const node of nodes) {
        if (
          node.type === 'identifier' &&
          ['eval', 'exec', 'globals', 'locals', 'vars', '__import__', 'Function'].includes(
            node.text
          )
        )
          safe = false
        if (
          node.type === 'identifier' &&
          (aliases.has(node.text) || node.text === 'process') &&
          isWriteTarget(node)
        )
          safe = false
        if (node.type === 'identifier' && node.text === 'globalThis' && isWriteTarget(node)) {
          const property = fieldChild(node.parent, 'property')?.text
          if (!property || ['process', 'require', 'globalThis', 'host'].includes(property))
            safe = false
        }
        const member = fieldChild(node, 'attribute')?.text ?? fieldChild(node, 'property')?.text
        if (member === 'environ' || member === 'env') {
          const parent = node.parent
          const getter =
            language === 'python' &&
            parent?.type === 'attribute' &&
            fieldChild(parent, 'attribute')?.text === 'get' &&
            parent.parent?.type === 'call'
          // Only immediate reads are supported. Aliases, reflection, mutations and
          // passing the environment object onward invalidate the launch context.
          if (
            !parent ||
            (!getter &&
              !['subscript', 'subscript_expression', 'member_expression'].includes(parent.type)) ||
            isWriteTarget(parent)
          )
            safe = false
        }
        if (node.type === 'call' || node.type === 'call_expression') {
          const fn = fieldChild(node, 'function')
          const text = fn?.text ?? ''
          if (
            /\b(?:putenv|unsetenv|setenv|chdir|fchdir|exec|spawn|setPrototypeOf|defineProperty|assign)\b/u.test(
              text
            )
          )
            safe = false
          if (language === 'repl' && text === 'require') {
            const argument = fieldChild(node, 'arguments')?.namedChildren[0]?.text
            if (!argument || !/^['"](?:node:)?(?:fs|path)['"]$/u.test(argument)) safe = false
          }
        }
        if (
          language === 'repl' &&
          node.type === 'subscript_expression' &&
          fieldChild(node, 'object')?.text === 'process'
        )
          safe = false
        if (
          language === 'python' &&
          node.type === 'import_from_statement' &&
          fieldChild(node, 'module_name')?.text === 'os'
        )
          safe = false
      }
      return safe
    }
  )
  return parsed.state === 'ok' && parsed.value
}

export { managedEnvironmentIsReadOnly }

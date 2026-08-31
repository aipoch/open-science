import type {
  NotebookRunDependencyFacts,
  NotebookSourceFileAccessContext
} from './dependency-analysis-types'

type FileContextEntry = {
  facts: NotebookRunDependencyFacts
  fileContext: NotebookSourceFileAccessContext
}

const FILE_CONTEXT_SAFE_UNKNOWN_REASONS = new Set([
  'control-flow',
  'external-state',
  'function-scope'
])
const MAX_PYTHON_IDENTITIES = 512

// The owner checks history/epoch/cache validity. This projection owns only binding lifetimes;
// an unavailable entry discards prior knowledge, and later completed runs can establish it again.
const projectNotebookFileContext = (
  language: 'python' | 'r',
  entries: Iterable<FileContextEntry | undefined>
): NotebookSourceFileAccessContext | undefined => {
  const staticStrings = new Map<string, string>()
  const staticCollections = new Map<
    string,
    NotebookSourceFileAccessContext['staticCollections'][number]
  >()
  const localFileWrappers = new Map<
    string,
    NotebookSourceFileAccessContext['localFileWrappers'][number]
  >()
  const resolvedKernelNames = new Set<string>()
  const pythonTaintedNamespaces = new Set<string>()
  const pythonBindings = new Map<
    string,
    NonNullable<NotebookSourceFileAccessContext['pythonBindings']>[number]
  >()
  const rFunctions = new Map<
    string,
    NonNullable<NotebookSourceFileAccessContext['rFunctions']>[number]['summary']
  >()
  const aliases = new Map<string, Set<string>>()
  const boundPythonState = (): void => {
    if (
      pythonTaintedNamespaces.size > MAX_PYTHON_IDENTITIES ||
      pythonBindings.size > MAX_PYTHON_IDENTITIES
    ) {
      // Discarding individual taints could make a patched module trusted again.
      pythonTaintedNamespaces.clear()
      pythonTaintedNamespaces.add('*')
    }
    if (pythonTaintedNamespaces.has('*')) {
      pythonTaintedNamespaces.clear()
      pythonTaintedNamespaces.add('*')
      pythonBindings.clear()
    }
  }
  let available = true
  for (const entry of entries) {
    for (const namespace of entry?.fileContext.pythonTaintedNamespaces ?? [])
      pythonTaintedNamespaces.add(namespace)
    if (
      !entry ||
      (entry.facts.state === 'unknown' &&
        entry.facts.reasons.some((reason) => !FILE_CONTEXT_SAFE_UNKNOWN_REASONS.has(reason)))
    ) {
      const poisonedBindings = [
        ...pythonBindings.values(),
        ...(entry?.fileContext.pythonBindings ?? [])
      ].filter(
        (binding) =>
          pythonTaintedNamespaces.has('*') ||
          pythonTaintedNamespaces.has(binding.qualifiedName.split('.')[0]!)
      )
      staticStrings.clear()
      staticCollections.clear()
      localFileWrappers.clear()
      resolvedKernelNames.clear()
      rFunctions.clear()
      pythonBindings.clear()
      // These names convey uncertainty only; they must not regain trusted library
      // effects after a re-import of the same Python module object.
      for (const binding of poisonedBindings) pythonBindings.set(binding.name, binding)
      boundPythonState()
      aliases.clear()
      available = false
      continue
    }
    available = true
    const { facts, fileContext } = entry
    const conditionalNames = new Set(facts.conditionallyDefinedNames ?? [])
    const definedNames = new Set([
      ...(facts.definedNames ?? []),
      ...(facts.conditionallyDefinedNames ?? [])
    ])
    const mutatedNames = new Set([
      ...(facts.mutatedNames ?? []),
      ...(facts.possiblyMutatedNames ?? []),
      ...(facts.receiverCalls ?? [])
        .filter(({ kind }) => kind === 'mutating')
        .map(({ receiver }) => receiver),
      ...(facts.memberWrites ?? []).map(({ receiver }) => receiver)
    ])
    // Include both existing and newly assigned aliases: run facts summarize a whole cell,
    // so they cannot prove which side of a reassignment an in-place mutation occurred on.
    for (const name of mutatedNames) {
      for (const alias of aliases.get(name) ?? []) mutatedNames.add(alias)
      if (language === 'python') {
        for (const { target, source } of facts.aliases ?? []) {
          if (target === name) mutatedNames.add(source)
          if (source === name) mutatedNames.add(target)
        }
      }
    }
    const invalidatedNames = new Set([...definedNames, ...mutatedNames])
    for (const [name, wrapper] of localFileWrappers) {
      if (wrapper.dependencyNames.some((dependency) => invalidatedNames.has(dependency))) {
        localFileWrappers.delete(name)
      }
    }
    for (const name of invalidatedNames) {
      staticStrings.delete(name)
      staticCollections.delete(name)
      localFileWrappers.delete(name)
      rFunctions.delete(name)
      const binding = pythonBindings.get(name)
      if (
        definedNames.has(name) ||
        !binding ||
        (!pythonTaintedNamespaces.has('*') &&
          !pythonTaintedNamespaces.has(binding.qualifiedName.split('.')[0]!))
      )
        pythonBindings.delete(name)
    }
    // A replaced builtin changes the body semantics of functions that call it.
    for (const [name, summary] of rFunctions) {
      if (
        summary.methods.some((method) =>
          method.safeCallNames?.some((call) => invalidatedNames.has(call))
        )
      )
        rFunctions.delete(name)
    }
    if (language === 'r') {
      for (const binding of facts.typeBindings ?? []) {
        const summary = facts.typeSummaries?.find((item) => item.name === binding.typeName)
        if (
          summary?.kind === 'r-function' &&
          !conditionalNames.has(binding.target) &&
          !summary.methods.some((method) =>
            method.safeCallNames?.some(
              (name) => resolvedKernelNames.has(name) || definedNames.has(name)
            )
          )
        )
          rFunctions.set(binding.target, summary)
      }
      for (const { target, source, access } of facts.aliases ?? []) {
        const summary = rFunctions.get(source)
        if (summary && !access && !conditionalNames.has(target)) rFunctions.set(target, summary)
      }
    }
    for (const name of definedNames) {
      resolvedKernelNames.delete(name)
      if (conditionalNames.has(name)) continue
      const group = aliases.get(name)
      group?.delete(name)
      aliases.delete(name)
    }
    if (language === 'python') {
      for (const { target, source } of facts.aliases ?? []) {
        const group = new Set([
          target,
          source,
          ...(aliases.get(target) ?? []),
          ...(aliases.get(source) ?? [])
        ])
        for (const name of group) aliases.set(name, group)
      }
    }
    for (const name of facts.definedNames ?? []) {
      if (!conditionalNames.has(name)) resolvedKernelNames.add(name)
    }
    for (const binding of fileContext.staticStrings) {
      if (!conditionalNames.has(binding.name)) staticStrings.set(binding.name, binding.value)
    }
    for (const collection of fileContext.staticCollections) {
      if (!conditionalNames.has(collection.name)) staticCollections.set(collection.name, collection)
    }
    for (const wrapper of fileContext.localFileWrappers) {
      if (!conditionalNames.has(wrapper.name)) localFileWrappers.set(wrapper.name, wrapper)
    }
    for (const binding of fileContext.pythonBindings ?? []) {
      if (!conditionalNames.has(binding.name)) pythonBindings.set(binding.name, binding)
    }
    boundPythonState()
  }
  if (!available && !pythonTaintedNamespaces.size) return undefined
  const specializedNames = new Set([
    ...staticStrings.keys(),
    ...staticCollections.keys(),
    ...localFileWrappers.keys()
  ])
  const remainingKernelNames = [...resolvedKernelNames]
    .filter((name) => !specializedNames.has(name))
    .sort()
  const staticCollectionAliases: NonNullable<
    NotebookSourceFileAccessContext['staticCollectionAliases']
  > = []
  for (const group of new Set(aliases.values())) {
    const source = [...group].find((name) => staticCollections.has(name))
    if (!source) continue
    for (const target of group) {
      if (target !== source) staticCollectionAliases.push({ target, source })
    }
  }
  return {
    staticStrings: [...staticStrings]
      .map(([name, value]) => ({ name, value }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    staticCollections: [...staticCollections.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    localFileWrappers: [...localFileWrappers.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    ...(remainingKernelNames.length ? { resolvedKernelNames: remainingKernelNames } : {}),
    ...(pythonTaintedNamespaces.size
      ? { pythonTaintedNamespaces: [...pythonTaintedNamespaces].sort() }
      : {}),
    ...(pythonBindings.size
      ? {
          pythonBindings: [...pythonBindings.values()].sort((a, b) => a.name.localeCompare(b.name))
        }
      : {}),
    ...(rFunctions.size
      ? { rFunctions: [...rFunctions].map(([name, summary]) => ({ name, summary })) }
      : {}),
    ...(staticCollectionAliases.length ? { staticCollectionAliases } : {})
  }
}

export { projectNotebookFileContext }
export type { FileContextEntry }

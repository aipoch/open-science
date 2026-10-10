import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'

import type { ToolDescriptor } from './types'

export type ConnectorRegistry = {
  readonly connectorIds: readonly string[]
  getConnectorTools(connector: string): ToolDescriptor[]
  getDescriptor(connector: string, method: string): ToolDescriptor | undefined
  validateToolArguments(descriptor: ToolDescriptor, args: Record<string, unknown>): void
}

const boundedField = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, 128) : undefined

const validationDetail = (error: ErrorObject | undefined): string => {
  if (!error) return 'arguments must match the registered Input schema'
  if (error.keyword === 'required') {
    const field = boundedField(error.params.missingProperty)
    return field ? `field ${JSON.stringify(field)} is required` : 'a required field is missing'
  }
  if (error.keyword === 'additionalProperties') {
    const field = boundedField(error.params.additionalProperty)
    return field
      ? `field ${JSON.stringify(field)} is not allowed`
      : 'an unknown field is not allowed'
  }

  const path = boundedField(error.instancePath.replace(/^\//, '').replaceAll('/', '.'))
  const subject = path ? `field ${JSON.stringify(path)}` : 'arguments'
  return `${subject} ${error.message ?? 'must match the registered Input schema'}`
}

// Registration is local to this instance; validation preserves descriptor object identity.
export function createConnectorRegistry(descriptors: readonly ToolDescriptor[]): ConnectorRegistry {
  const inputSchemaCompiler = new Ajv2020({
    strict: true,
    allowUnionTypes: true,
    allErrors: false,
    validateFormats: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    ownProperties: true,
    addUsedSchema: false
  })

  const tools = [...descriptors]
  const inputValidators = new Map<ToolDescriptor, ValidateFunction>(
    tools.map((tool) => [tool, inputSchemaCompiler.compile(tool.input)])
  )

  function validateToolArguments(descriptor: ToolDescriptor, args: Record<string, unknown>): void {
    const validate = inputValidators.get(descriptor)
    if (!validate)
      throw new Error(`unregistered tool descriptor: ${descriptor.connector}/${descriptor.id}`)
    if (validate(args)) return

    throw new Error(
      `connector call rejected: invalid_arguments. Invalid tool arguments for ${descriptor.connector}/${descriptor.id}: ${validationDetail(validate.errors?.[0])}. ` +
        `Correct the arguments to match the Input schema in the loaded mcp-${descriptor.connector} Skill, then retry the same method once. ` +
        'Do not retry unchanged or bypass host.mcp.'
    )
  }

  return {
    connectorIds: [...new Set(tools.map((tool) => tool.connector))],
    getConnectorTools: (connector) => tools.filter((tool) => tool.connector === connector),
    getDescriptor: (connector, method) =>
      tools.find((tool) => tool.connector === connector && tool.id === method),
    validateToolArguments
  }
}

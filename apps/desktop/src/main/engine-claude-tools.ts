import { z, type ZodTypeAny } from 'zod'
import type { ToolSessionCall } from 'core'

// The comet's tools, in the shape the Claude runtime takes them: a name,
// a description and a schema it can validate against. The loop's tools
// describe their arguments as plain JSON schema; the runtime wants zod, so
// the few shapes the tools actually use are translated here.

interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  additionalProperties?: boolean | JsonSchema
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
}

function fieldOf(schema: JsonSchema): ZodTypeAny {
  if (schema.enum && schema.enum.length > 0) return z.enum(schema.enum.map(String) as [string, ...string[]])
  switch (schema.type) {
    case 'string': {
      let value = z.string()
      if (schema.minLength !== undefined) value = value.min(schema.minLength)
      if (schema.maxLength !== undefined) value = value.max(schema.maxLength)
      if (schema.pattern !== undefined) value = value.regex(new RegExp(schema.pattern))
      return value
    }
    case 'number':
    case 'integer': {
      let value = schema.type === 'integer' ? z.number().int() : z.number()
      if (schema.minimum !== undefined) value = value.min(schema.minimum)
      if (schema.maximum !== undefined) value = value.max(schema.maximum)
      if (schema.exclusiveMinimum !== undefined) value = value.gt(schema.exclusiveMinimum)
      return value
    }
    case 'boolean':
      return z.boolean()
    case 'array': {
      let value = z.array(schema.items ? fieldOf(schema.items) : z.unknown())
      if (schema.minItems !== undefined) value = value.min(schema.minItems)
      if (schema.maxItems !== undefined) value = value.max(schema.maxItems)
      return value
    }
    case 'object':
      return schema.properties ? (schema.additionalProperties === false ? z.object(shapeOf(schema)).strict() : z.object(shapeOf(schema)).passthrough())
        : z.record(z.string(), typeof schema.additionalProperties === 'object' ? fieldOf(schema.additionalProperties) : z.unknown())
    default:
      return z.unknown()
  }
}

export function shapeOf(schema: object): Record<string, ZodTypeAny> {
  const { properties = {}, required = [] } = schema as JsonSchema
  const shape: Record<string, ZodTypeAny> = {}
  for (const [name, field] of Object.entries(properties)) {
    const type = fieldOf(field)
    shape[name] = required.includes(name) ? type : type.optional()
  }
  return shape
}

export const TOOL_SERVER = 'engram'

// The runtime names a server's tools by prefixing the server: this is the
// list that lets every comet tool through and nothing else.
export function allowedToolNames(tools: ToolSessionCall[]): string[] {
  return tools.map((tool) => `mcp__${TOOL_SERVER}__${tool.name}`)
}

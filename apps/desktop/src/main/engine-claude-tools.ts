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
}

function fieldOf(schema: JsonSchema): ZodTypeAny {
  if (schema.enum && schema.enum.length > 0) return z.enum(schema.enum.map(String) as [string, ...string[]])
  switch (schema.type) {
    case 'string':
      return z.string()
    case 'number':
    case 'integer':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'array':
      return z.array(schema.items ? fieldOf(schema.items) : z.unknown())
    case 'object':
      return schema.properties ? z.object(shapeOf(schema)).passthrough() : z.record(z.string(), z.unknown())
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

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function matchesType(value, type) {
  const actual = typeOf(value)
  return actual === type || (type === 'number' && actual === 'integer')
}

function resolve(root, ref) {
  const match = /^#\/definitions\/(.+)$/.exec(ref)
  if (!match || !root.definitions?.[match[1]]) throw new Error(`unsupported $ref ${ref}`)
  return root.definitions[match[1]]
}

function check(root, schema, value, path, errors) {
  if (schema.$ref) return check(root, resolve(root, schema.$ref), value, path, errors)
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`)
      return
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${schema.enum.join(', ')}`)
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: does not match ${schema.pattern}`)
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path}: must be >= ${schema.minimum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} items`)
    }
    if (schema.items) value.forEach((entry, i) => check(root, schema.items, entry, `${path}[${i}]`, errors))
    return
  }
  if (typeOf(value) !== 'object') return
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${path}: missing required property ${key}`)
  }
  const properties = schema.properties ?? {}
  for (const [key, entry] of Object.entries(value)) {
    if (properties[key]) check(root, properties[key], entry, `${path}.${key}`, errors)
    else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`)
  }
}

export function validate(schema, value) {
  const errors = []
  check(schema, schema, value, '$', errors)
  return errors
}

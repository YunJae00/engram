import type { AgentTool } from './agent-loop.js'

const operations = ['sum', 'subtract', 'multiply', 'divide', 'ceil', 'floor', 'min', 'max']
const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,31}$' }
function bounded(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error('Calculation exceeds the supported numeric range.')
  return value
}

// Fixed arithmetic only: no expression evaluation, code, files, network or shell.
export function calculationTool(assertActive?: () => void): AgentTool {
  return {
    name: 'work_calculate',
    description: 'Check arithmetic with bounded named calculations, not mental arithmetic. Values are numbers or {ref:"earlier_id"}. subtract/divide take exactly two values; ceil/floor exactly one; other operations take 1-1000. Up to 100 calculations and 10,000 values per call. Returns every operand and result. Uses IEEE-754 floating-point, NOT exact decimal accounting: use integer minor units for money and explicitly choose any rounding policy. No Excel formula execution, scheduling solver, source validation or business verification. A correct calculation does not establish correct assumptions or task completion.',
    argsSchema: { type: 'object', additionalProperties: false, required: ['calculations'], properties: {
      calculations: { type: 'array', minItems: 1, maxItems: 100, items: {
        type: 'object', additionalProperties: false, required: ['id', 'operation', 'values'], properties: {
          id, operation: { type: 'string', enum: operations },
          values: { type: 'array', minItems: 1, maxItems: 1000, items: { anyOf: [
            { type: 'number' }, { type: 'object', additionalProperties: false, required: ['ref'], properties: { ref: id } },
          ] } },
        },
      } },
    } },
    async run(args, context) {
      assertActive?.()
      context.signal?.throwIfAborted()
      if (Object.keys(args).some(key => key !== 'calculations') || !Array.isArray(args.calculations)
        || !args.calculations.length || args.calculations.length > 100) throw new Error('Supply 1-100 calculations.')
      const results = new Map<string, number>()
      let count = 0
      const rows = args.calculations.map(item => {
        context.signal?.throwIfAborted()
        if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'operation', 'values'].includes(key))
          || typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(item.id) || results.has(item.id)
          || !operations.includes(item.operation) || !Array.isArray(item.values) || !item.values.length || item.values.length > 1000
          || (count += item.values.length) > 10_000) throw new Error('Invalid, duplicate or oversized calculation.')
        const values: number[] = item.values.map((value: unknown) => {
          if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'ref' in value) {
            value = typeof value.ref === 'string' ? results.get(value.ref) : undefined
          }
          if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error('Use finite bounded numbers or references to earlier results.')
          return value
        })
        const op = item.operation
        if ((['subtract', 'divide'].includes(op) && values.length !== 2) || (['ceil', 'floor'].includes(op) && values.length !== 1)) throw new Error('Wrong number of operands.')
        if (op === 'divide' && values[1] === 0) throw new Error('Division by zero.')
        const result = op === 'sum' ? values.reduce((a, b) => bounded(a + b), 0)
          : op === 'multiply' ? values.reduce((a, b) => bounded(a * b), 1)
          : op === 'subtract' ? values[0]! - values[1]!
          : op === 'divide' ? values[0]! / values[1]!
          : op === 'ceil' ? Math.ceil(values[0]!) : op === 'floor' ? Math.floor(values[0]!)
          : op === 'min' ? Math.min(...values) : Math.max(...values)
        bounded(result)
        results.set(item.id, result)
        return { id: item.id, operation: op, values, result }
      })
      return JSON.stringify({ calculations: rows, precision: 'IEEE-754 floating-point; not exact decimal accounting.', verification: 'Arithmetic only. Sources, units, assumptions and business constraints were not verified.' })
    },
  }
}

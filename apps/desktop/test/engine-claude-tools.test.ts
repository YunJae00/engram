import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { allowedToolNames, shapeOf } from '../src/main/engine-claude-tools.js'

describe('the comet tools in the runtime\'s shape', () => {
  it('translates the argument schemas the tools actually use', () => {
    const shape = shapeOf({
      type: 'object',
      properties: {
        query: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        slots: { type: 'object', additionalProperties: { type: 'string' } },
        count: { type: 'integer' },
      },
      required: ['query'],
    })
    const parsed = z.object(shape).parse({ query: 'deploys', options: ['a'], slots: { entry: 'x' }, count: 2 })
    expect(parsed).toEqual({ query: 'deploys', options: ['a'], slots: { entry: 'x' }, count: 2 })
    expect(() => z.object(shape).parse({ options: ['a'] })).toThrow()
    expect(z.object(shape).parse({ query: 'q' })).toEqual({ query: 'q' })
  })

  it('names every tool through the server, and nothing else', () => {
    expect(allowedToolNames([{ name: 'search_memory', description: '', argsSchema: {}, run: async () => '' }])).toEqual(['mcp__engram__search_memory'])
  })
})

import type { ToolSessionJob } from 'core'
import { decisionConnectionState } from './brain-connections.js'
import { flog } from './flog.js'

export function logSessionTools(engine: string, job: ToolSessionJob): void {
  const tools = job.tools.map(tool => tool.name)
  const decision = decisionConnectionState()
  flog('session-tools', JSON.stringify({ engine, session: job.sessionKey, tools, toolCount: tools.length,
    promptChars: job.prompt.length + job.system.length, decision,
    decisionTools: tools.filter(name => name === 'app_do' || name === 'page_do'),
    ...(decision.available && !tools.some(name => name === 'app_do' || name === 'page_do') ? { decisionMenu: 'configured-but-not-offered' } : {}),
  }))
}

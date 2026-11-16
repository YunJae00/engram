import type { AgentTool, ApprovalRule } from 'core'

// "Always allow on this site" answers the person gave on a post or press card.
// Taking one back only tightens a gate, so it needs no confirmation; nothing here can add one.
export function standingApprovalsTool(store: { list(): Promise<ApprovalRule[]>; forget(fingerprint: string): Promise<void> }): AgentTool {
  return {
    name: 'standing_approvals',
    description: 'The sites where the person answered "always allow" on a post or press card. action "list" returns them (site and when). action "forget" with site takes every one for that site back, so the card asks again next time. Use when the person asks what they allowed, or to stop allowing a site. This never adds an approval.',
    argsSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['list', 'forget'] }, site: { type: 'string' } } },
    async run(args) {
      const rules = await store.list()
      if (args['action'] === 'list') return JSON.stringify({ allowed: rules.map(rule => ({ site: rule.host, since: rule.createdAt.slice(0, 10) })) })
      if (args['action'] !== 'forget') throw new Error('action is "list" or "forget".')
      const site = typeof args['site'] === 'string' ? args['site'].trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') : ''
      const mine = rules.filter(rule => rule.host.replace(/^www\./, '') === site)
      if (!site || !mine.length) throw new Error('No standing approval for that site; call standing_approvals with action "list" for the sites.')
      for (const rule of mine) await store.forget(rule.fingerprint)
      return JSON.stringify({ forgotten: site, count: mine.length })
    },
  }
}

const FORMS: Record<string, readonly [string, string]> = { '\uC774(\uAC00)': ['\uC774', '\uAC00'], '\uC744(\uB97C)': ['\uC744', '\uB97C'], '\uC740(\uB294)': ['\uC740', '\uB294'], '\uACFC(\uC640)': ['\uACFC', '\uC640'], '(\uC73C)\uB85C': ['\uC73C\uB85C', '\uB85C'] }
const DIGITS_WITH_FINAL = '013678'
const DIGITS_WITH_RIEUL = '178'

type Final = 'none' | 'rieul' | 'other' | 'unknown'

function finalOf(value: string): Final {
  const last = value.replace(/[”’"')\]]+$/, '').at(-1)
  if (last === undefined) return 'unknown'
  const code = last.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28
    return jong === 0 ? 'none' : jong === 8 ? 'rieul' : 'other'
  }
  if (/[0-9]/.test(last)) return DIGITS_WITH_RIEUL.includes(last) ? 'rieul' : DIGITS_WITH_FINAL.includes(last) ? 'other' : 'none'
  return 'unknown'
}

function resolve(particle: string, final: Final): string {
  const form = FORMS[particle]
  if (!form || final === 'unknown') return particle
  if (final === 'none') return form[1]
  if (final === 'rieul' && particle === '(\uC73C)\uB85C') return form[1]
  return form[0]
}

// Fills {name} placeholders and picks the Korean particle form that fits each filled value.
export function withParticles(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}([”’"')\]]*)(\uC774\(\uAC00\)|\uC744\(\uB97C\)|\uC740\(\uB294\)|\uACFC\(\uC640\)|\(\uC73C\)\uB85C)?/g, (match, name: string, closers: string, particle?: string) => {
    if (!(name in vars)) return match
    const value = String(vars[name])
    return value + closers + (particle ? resolve(particle, finalOf(value)) : '')
  })
}

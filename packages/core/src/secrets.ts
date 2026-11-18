const LABELLED =
  /(?<![A-Za-z0-9])(?:비밀번호|패스워드|암호|비번|password|passcode|passphrase|pin|otp|api\s*key|token)(?=\s|:|=|는|은|이|가|$)\s*(?:는|은|이|가|:|=|is)?\s*["'`]?([^\s"'`,.]{3,80})/gi

export function secretsIn(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(LABELLED)) {
    const value = match[1]
    if (value && !/^(는|은|이|가|을|를|야|이야|입니다|is|the|a)$/i.test(value)) found.add(value)
  }
  return [...found]
}

export function withoutSecrets(text: string, source: string): string {
  let clean = text
  for (const secret of secretsIn(source)) clean = clean.split(secret).join('•'.repeat(6))
  return clean
}

export function withoutSecretsIn<T>(value: T, source: string, fields: readonly string[] = []): T {
  const secrets = secretsIn(source)
  if (!secrets.length) return value
  const text = (value: string): string => { let out = value; for (const secret of secrets) out = out.split(secret).join('•'.repeat(6)); return out }
  const own = new Set(fields)
  const clean = (item: unknown, at: string): unknown => {
    if (typeof item === 'string') return text(item)
    if (Array.isArray(item)) return item.map(entry => clean(entry, at ? `${at}.*` : '*'))
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
        const path = at ? `${at}.${key}` : key
        return [own.has(path) ? key : text(key), clean(entry, own.has(path) ? path : `${at}.\u0000`)]
      }))
    }
    return item
  }
  return clean(value, '') as T
}

export function textsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textsIn)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => [key, ...textsIn(entry)])
  return []
}

export function carriesSecret(text: string, source: string): boolean {
  return secretsIn(source).some((secret) => text.includes(secret))
}

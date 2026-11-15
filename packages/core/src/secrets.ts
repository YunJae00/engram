// A password the person types into the chat is theirs, not the app's, and it
// must not survive the sentence it arrived in. This is not a heuristic about
// what looks secret: it reads the value the person themselves labelled — "my
// password is X" — and keeps that exact value out of anything written down or
// said back. Nothing here is stored, logged, or sent anywhere.
// The label must be a whole word, so PINEAPPLE, shopping-list.md or 암호화폐 carry no secret.
const LABELLED =
  /(?<![A-Za-z0-9])(?:비밀번호|패스워드|암호|비번|password|passcode|passphrase|pin|otp|api\s*key|token)(?=\s|:|=|는|은|이|가|$)\s*(?:는|은|이|가|:|=|is)?\s*["'`]?([^\s"'`,.]{3,80})/gi

// The values the person marked as secret in what they wrote.
export function secretsIn(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(LABELLED)) {
    const value = match[1]
    // "my password is wrong" — a word carried in from the sentence itself is
    // not the secret; only something that reads like a value is.
    if (value && !/^(는|은|이|가|을|를|야|이야|입니다|is|the|a)$/i.test(value)) found.add(value)
  }
  return [...found]
}

// Whatever the person marked as secret never appears in what is written down
// or read back to them.
export function withoutSecrets(text: string, source: string): string {
  let clean = text
  for (const secret of secretsIn(source)) clean = clean.split(secret).join('•'.repeat(6))
  return clean
}

// The same, for structured data that will be serialized: each string (values
// and keys alike) is cleaned on its own, so a removed value can never eat a
// quote or an escape of the serialized form (QA 0.8.142 B9: redacting JSON
// text broke checkpoints). The caller's own field names are never renamed, so
// a reader still finds them: `fields` lists their dotted paths, with `*` for
// any array element (e.g. 'committedActions.*.tool'). Every other key,
// including keys nested inside those fields' values, is cleaned.
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

// Every string in structured data (values and keys), decoded: what a
// structured record labels as secret is read from here, never from its
// serialized spelling, where escapes would hide the value.
export function textsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textsIn)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => [key, ...textsIn(entry)])
  return []
}

export function carriesSecret(text: string, source: string): boolean {
  return secretsIn(source).some((secret) => text.includes(secret))
}

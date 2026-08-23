// A password the person types into the chat is theirs, not the app's, and it
// must not survive the sentence it arrived in. This is not a heuristic about
// what looks secret: it reads the value the person themselves labelled — "my
// password is X" — and keeps that exact value out of anything written down or
// said back. Nothing here is stored, logged, or sent anywhere.
const LABELLED =
  /(?:비밀번호|패스워드|암호|비번|password|passcode|passphrase|pin|otp|api\s*key|token)\s*(?:는|은|이|가|:|=|is)?\s*["'`]?([^\s"'`,.]{3,80})/gi

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

export function carriesSecret(text: string, source: string): boolean {
  return secretsIn(source).some((secret) => text.includes(secret))
}

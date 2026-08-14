
export function detectApiKeyEnv(): string[] {
  return ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'].filter(
    (name) => !!process.env[name],
  )
}

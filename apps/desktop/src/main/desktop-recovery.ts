// Only transient observation/activation failures are resumable. Never match
// permission denials, disconnected hosts or explicit cancellation here.
export function recoverableDesktopFailure(reason: string): boolean {
  if (/\besc\b|\bstop(?:ped)?\b|cancelled|canceled|permission|connection closed|disconnected/i.test(reason)) return false
  return /returned control to the user|pointer target changed|window or desktop changed|control expired|user input changed|release your keyboard|selected application is no longer in the foreground|bring the chosen application to the foreground and grant control again|app did not acknowledge foreground activation|app changed while it was being read|observe this application again before sending input/i.test(reason)
}

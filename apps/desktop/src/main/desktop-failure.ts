export interface DesktopFailureObservation {
  error: 'stale_snapshot' | 'element_not_found' | 'ambiguous' | 'occluded' | 'timeout' | 'action_failed' | 'policy_denied'
  delivery: 'not_delivered' | 'delivery_uncertain' | 'delivered_unverified'
  retry: 'safe' | 'unsafe'
  hint: string
}

const PRECONDITIONS: { pattern: RegExp; code: DesktopFailureObservation['error']; hint?: string }[] = [
  { pattern: /Allow Engram in System Settings.*Accessibility/, code: 'policy_denied', hint: 'Ask the person to allow Engram in System Settings → Privacy & Security → Accessibility, then read the app again; do not bypass this permission.' },
  { pattern: /Foreground input requires a deliberate handover/, code: 'policy_denied', hint: 'Ask the person to choose Allow control for this session under + → Computer controls, then read the app again; do not retry global input until they hand it over.' },
  { pattern: /exposes its controls: use app_read|Read the app with app_read first/i, code: 'policy_denied', hint: 'Read the app with app_read and use its provider controls; use the screen lane only when the reading reports sparse controls.' },
  { pattern: /^Invalid desktop action\.|^Desktop action arguments must|^Use an exact accessible name and controlType|^Use an element ID from the starting observation/i, code: 'action_failed', hint: 'Correct the arguments to match the tool schema and the latest observed target before retrying.' },
  { pattern: /snapshot is (?:stale|no longer held)|snapshot belongs to a different window|read the app before acting|window changed\. Read it again before acting|control changed\. Read the app again|selected control changed\. Observe|field changed\. Read/i, code: 'stale_snapshot' },
  { pattern: /unknown control ID|control is no longer there|control is no longer available\. Observe/i, code: 'element_not_found' },
  { pattern: /window identity is ambiguous|more than one .*window|planned control changed or is ambiguous|next target is ambiguous/i, code: 'ambiguous' },
  { pattern: /another surface covers the input position|cannot verify the input position|input position is covered or outside/i, code: 'occluded' },
  { pattern: /surfaces require manual control|surface requires manual control|password fields are the person's|control is unavailable or protected|input position is protected or unverified/i, code: 'policy_denied' },
]
const TRANSIENT_PREPARATION = /returned control to the user|pointer target changed|window or desktop changed|control expired|user input changed|release your keyboard|selected application is no longer in the foreground|bring the chosen application to the foreground and grant control again|app did not acknowledge foreground activation|app changed while it was being read|observe this application again before sending input/i
const STOP = /\besc\b|\bstop(?:ped)?\b|cancelled|canceled|permission|connection closed|disconnected/i

export function desktopFailure(error: unknown, options: { preparing?: boolean; delivered?: boolean; container?: boolean } = {}): DesktopFailureObservation {
  const reason = error instanceof Error ? error.message : String(error)
  const timeout = /timed? out|timeout|stopped responding/i.test(reason) || (error instanceof Error && error.name === 'TimeoutError')
  const known = PRECONDITIONS.find(rule => rule.pattern.test(reason))
  const safe = !options.delivered && !timeout && !STOP.test(reason) && (!!known || !!options.preparing && TRANSIENT_PREPARATION.test(reason))
  const delivery = options.delivered ? 'delivered_unverified' : safe ? 'not_delivered' : 'delivery_uncertain'
  return {
    error: timeout ? 'timeout' : known?.code ?? 'action_failed', delivery, retry: safe ? 'safe' : 'unsafe',
    hint: options.container ? 'Read the app to check the effect, then target an inner actionable cell or button with the same name instead of repeating the container press.'
      : known?.hint ? known.hint
      : known?.code === 'policy_denied' ? 'Ask the person to handle the protected surface; do not bypass the restriction.'
      : safe ? 'Read the app again and select a fresh matching control before retrying.'
      : 'Read the app and check whether the action took effect before deciding what remains to do.',
  }
}

export function recoverablePreparation(reason: string): boolean {
  return TRANSIENT_PREPARATION.test(reason) && desktopFailure(reason, { preparing: true }).retry === 'safe'
}

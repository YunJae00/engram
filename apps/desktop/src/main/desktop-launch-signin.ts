import { DesktopHost } from './desktop-host.js'
import { restoreHiddenApp } from './desktop-access.js'
import { flog } from './flog.js'

export interface LaunchOutcome { hiddenFallback?: string; windowVerified?: boolean; foregroundChanged?: boolean; foregroundRestored?: boolean; hiddenMs?: number }
export interface SignIn { shown: boolean }

export async function showForSignIn(lane: string, pid: number | undefined, host: DesktopHost, error: unknown): Promise<SignIn | undefined> {
  if (!pid || (error as { protectedPid?: number } | undefined)?.protectedPid !== pid) return undefined
  const restore = restoreHiddenApp(lane, true) ?? host.request('unhideApp', { pid, activate: true }).catch(failure => flog('desktop-unhide', String(failure)))
  const receipt = await restore as { hidden?: boolean } | undefined
  const shown = receipt?.hidden === false
  flog('desktop-launch-signin', JSON.stringify({ lane, pid, shown }))
  return { shown }
}

// open_app for an app already sitting at a sign-in window: bring it to the person and say it waits for them.
export async function alreadyOpenSignIn(lane: string, app: string, error: unknown): Promise<string | undefined> {
  const pid = (error as { protectedPid?: number } | undefined)?.protectedPid
  if (!pid) return undefined
  const host = new DesktopHost()
  try {
    const signIn = await showForSignIn(lane, pid, host, error)
    return JSON.stringify({ alreadyOpen: true, opened: false, pid, title: app, hidden: false, signInRequired: true, shownToPerson: signIn?.shown === true, windowVerified: true, foregroundChanged: false, foregroundRestored: false, hiddenMs: 0, cycles: 0, hint: launchHint(undefined, signIn) })
  } finally { host.close() }
}

export function launchHint(result: LaunchOutcome | undefined, signIn?: SignIn): string {
  if (signIn) return signIn.shown
    ? 'The app is open and now in front of the person on a sign-in or security screen that only the person may operate. It is not ready for you yet: tell the person it is waiting for their sign-in, and read it again with app_read after they finish. Do not type credentials or operate that screen.'
    : 'The app is open on a sign-in or security screen that only the person may operate, but Engram could not bring it to the front. Tell the person to switch to the app and sign in, then read it again with app_read. Do not type credentials or operate that screen.'
  const readiness = result?.hiddenFallback === 'chromium-does-not-draw-hidden' ? 'This app stays open behind the current window (Chrome-family apps do not draw while hidden); the person sees it in the preview card. Read it with app_read.' : result?.hiddenFallback === 'no-draw-while-hidden' ? 'The app does not draw while hidden, so it stays open behind the current window; the person sees it in the preview card. Read it with app_read.' : result?.windowVerified ? 'The app stays hidden from the screen. Read it with app_read; the person watches the preview card.' : 'No app window was verified yet. A launch request alone does not prove the app is ready.'
  return result?.foregroundChanged ? result.foregroundRestored
    ? `The app came to the front for ${result.hiddenMs ?? 0} ms and was hidden back; ${readiness}`
    : 'The app took the screen and Engram could not return focus to the previous window. Do not call open_app again this turn; observe the app before proceeding.'
    : `The app did not take the foreground. ${readiness}`
}

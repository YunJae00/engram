// Shared by the browser read and the plain (no tab) read, so both hand the same pages to the person.
// A page a machine cannot pass. Pure so the heuristics have a unit test.
//
// Only a page asking for a SECRET is a wall. Sign-on flows are full of pages
// whose address says /sso or /auth and whose whole content is one Continue
// button - stopping at those hands the person a browser and asks them to
// drive it, which is the opposite of the point. So the address alone is not
// enough: a wall wants a password box, or a page plainly asking for a
// credential to be typed.
export function classifyWall(
  url: string,
  title: string,
  textHead: string,
  hasPasswordField: boolean,
): 'login' | 'captcha' | null {
  const head = `${title}\n${textHead.slice(0, 2_500)}`
  // A site that says it refuses automated requests is a check only the
  // person passes: the step is handed to them, never worked around.
  if (/captcha|are you a robot|not a robot|unusual traffic|verify you are human|one last step|real person|cloudflare.{0,40}checking|automated (requests?|access|queries)|bot (traffic|activity) (was )?detected|비정상적인 트래픽|로봇이 아니|사람인지 확인|자동화된 (요청|접근|접속)|자동 (요청|접속)으로 (감지|차단)|매크로.{0,12}(감지|차단|의심)/i.test(head))
    return 'captcha'
  if (hasPasswordField) return 'login'
  const onAuthPath = /\/(login|signin|sign-in|sign_in|sso|auth)\b/i.test(new URL(url).pathname)
  const asksForCredentials =
    /\b(password|passcode|one[- ]time code|verification code|two[- ]factor|username|user id)\b|비밀번호|암호|인증번호|아이디/i.test(head)
  return onAuthPath && asksForCredentials ? 'login' : null
}

export function classifyWall(
  url: string,
  title: string,
  textHead: string,
  hasPasswordField: boolean,
): 'login' | 'captcha' | null {
  const head = `${title}\n${textHead.slice(0, 2_500)}`
  if (/captcha|are you a robot|not a robot|unusual traffic|verify you are human|one last step|real person|cloudflare.{0,40}checking|automated (requests?|access|queries)|bot (traffic|activity) (was )?detected|비정상적인 트래픽|로봇이 아니|사람인지 확인|자동화된 (요청|접근|접속)|자동 (요청|접속)으로 (감지|차단)|매크로.{0,12}(감지|차단|의심)/i.test(head))
    return 'captcha'
  if (hasPasswordField) return 'login'
  const onAuthPath = /\/(login|signin|sign-in|sign_in|sso|auth)\b/i.test(new URL(url).pathname)
  const asksForCredentials =
    /\b(password|passcode|one[- ]time code|verification code|two[- ]factor|username|user id)\b|비밀번호|암호|인증번호|아이디/i.test(head)
  return onAuthPath && asksForCredentials ? 'login' : null
}

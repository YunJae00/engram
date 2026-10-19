import type { StringKey } from '../i18n.js'

// Every word a conversation shows in Korean, in one place: the step lines,
// the work groups and the few words around the comet's messages. The rest of
// the interface stays English; only what sits inside a conversation follows
// the language the person writes in.
const fileName = (arg: string): string => {
  if (arg.trim() === 'saved file') return 'a saved file'
  return arg.trim().split(/[\\/]/).pop() || 'a file'
}

export const KO: Partial<Record<StringKey, string>> = {
  'bots.thinking': '생각하는 중',
  'bots.stepFindProcedure': '전에 배운 방법이 있는지 보는 중',
  'bots.stepSearchMemory': '기억에서 “{arg}” 찾는 중',
  'bots.stepReadNote': '메모 읽는 중',
  'bots.stepSearchWeb': '“{arg}” 검색하는 중',
  'bots.stepOpenPage': '페이지 여는 중',
  'bots.stepReadPage': '연 페이지 읽는 중',
  'bots.stepWriteDown': '적어 두는 중',
  'bots.stepAsk': '여쭤볼 게 생겼어요',
  'bots.stepRun': '저장된 방법대로 하는 중',
  'bots.stepPress': '“{arg}” 누르는 중',
  'bots.stepType': '“{arg}”에 입력하는 중',
  'bots.stepChoose': '“{arg}”에서 고르는 중',
  'bots.stepScroll': '페이지 넘겨 보는 중 ({arg})',
  'bots.stepHover': '“{arg}” 위에 올려 보는 중',
  'bots.stepKey': '{arg} 키 누르는 중',
  'bots.stepPressPoint': '화면의 그 지점 누르는 중 ({arg})',
  'bots.stepReveal': '접힌 부분 펼쳐 보는 중',
  'bots.stepLook': '화면 보는 중',
  'bots.stepAside': '잠시 비켜 있을게요 — 지금은 직접 쓰세요',
  'bots.stepResume': '페이지를 다시 읽고 이어갈게요',
  'bubble.stopped': '멈췄어요.',
  'card.needsOk': '진행하기 전에',
  'card.press': '“{words}” 눌러도 될까요?',
  'card.pressHint': '제출하기 전에 지금 페이지에서 한 번 더 확인해요.',
  'card.decline': '안 할게요',
  'card.continue': '진행해 주세요',
  'card.answerNeeded': '답이 필요해요',
  'card.paused': '작업이 멈췄어요',
  'card.replyBelow': '아래 입력창에 답해 주시면 이어서 할게요.',
  'card.choose': '어떻게 할까요?',
  'card.post': '이대로 올릴까요?',
  'card.signIn': '로그인이 필요해요',
  'card.check': '직접 확인이 필요해요',
  'card.routine': '루틴 실행 중',
  'card.offer': '제안',
  'card.kept': '예약',
  'card.keptCount': '예약 {count}개',
  'card.cancelKept': '취소',
  'card.once': '한 번',
  'press.go': '눌러 주세요',
  'press.mine': '제가 할게요',
  'press.always': '{host}에서는 항상 허용',
  'routines.submitApprove': '올리기',
  'routines.submitCancel': '아직요',
  'routines.submitAlways': '{host}에서는 항상',
  'routines.wallLogin': '열린 페이지에서 로그인한 뒤 계속을 눌러 주세요.',
  'routines.wallCaptcha': '열린 페이지에서 확인을 마친 뒤 계속을 눌러 주세요.',
  'routines.wallDone': '했어요, 계속',
  'routines.wallStop': '그만하기',
  'routines.running': '실행 중…',
  'routines.run': '실행',
  'bots.offerAsked': '하나 고르거나 직접 적어 주세요.',
  'bots.offerRun': '“{name}”로 바로 할 수 있어요. 실행할까요?',
  'bots.offerStanding': '“{name}”을 {times} 부탁하셨어요. {when}에 알아서 할까요?',
  'bots.offerStandingGo': '네, {when}',
  'bots.offerStandingNo': '괜찮아요',
  'bots.timesTwice': '두 번',
  'bots.timesThree': '세 번',
  'bots.timesN': '{n}번',
  'schedule.weekdays': '평일 {time}',
  'schedule.daily': '매일 {time}',
  'schedule.weekly': '매주 {day} {time}',
  'schedule.days': '{days} {time}',
  'schedule.dayNames': '일요일,월요일,화요일,수요일,목요일,금요일,토요일',
}

export const KO_WORDS = { done: (count: number) => `완료 · ${count}단계`, total: (seconds: number) => `${seconds}초`, next: '다음', paused: '멈춤', after: '이 답이 끝나면 보내요', sendNext: '다음 거 보내기', sendNow: '지금 보내기', full: '대기열이 가득 찼어요. 하나를 지우거나 답을 기다려 주세요.', scheduled: '예약해 둔 요청', kept: (count: number) => `예약 ${count}개` } as const

// The same, for a conversation held in Korean.
const name = (arg: string): string => { const file = fileName(arg); return file === 'a saved file' ? '저장된 파일' : file === 'a file' ? '파일' : file }
export const WORK_KO: Record<string, string | ((arg: string) => string)> = {
  ppt_build: 'PowerPoint로 발표 자료 만드는 중', ppt_read: '발표 자료 확인하는 중', ppt_edit: '열린 발표 자료 고치는 중',
  word_write: 'Word로 문서 만드는 중', word_read: '문서 확인하는 중', word_edit: '열린 문서 고치는 중',
  excel_write: 'Excel 통합 문서 고치는 중', excel_read: '통합 문서 확인하는 중', excel_workbooks: '통합 문서 찾는 중',
  outlook_mail: '메일 살펴보는 중', outlook_read: '메일 읽는 중', outlook_draft: '메일 초안 쓰는 중', outlook_calendar: '일정 확인하는 중', schedule: '예약 정리하는 중',
  Read: arg => `${name(arg)} 읽는 중`, NotebookRead: arg => `${name(arg)} 읽는 중`,
  Glob: arg => `파일 찾는 중 (${arg})`, Grep: arg => `파일에서 “${arg}” 찾는 중`, LS: '폴더 살펴보는 중',
  Write: arg => `${name(arg)} 쓰는 중`, Edit: arg => `${name(arg)} 고치는 중`, MultiEdit: arg => `${name(arg)} 고치는 중`, NotebookEdit: arg => `${name(arg)} 고치는 중`,
  Bash: '명령 실행하는 중', PowerShell: '명령 실행하는 중', Shell: '명령 실행하는 중',
  file_read: arg => `${name(arg)} 읽는 중`, file_read_workbook: arg => `${name(arg)} 읽는 중`, file_read_package: arg => `${name(arg)} 읽는 중`,
  file_create_copy: arg => `${name(arg)} 저장하는 중`, file_create_workbook: arg => `${name(arg)} 저장하는 중`, file_edit_package: arg => `${name(arg)} 고치는 중`,
  find_files: arg => `“${arg}” 파일 찾는 중`, open_skill: '배운 방법 읽는 중',
  page_do: '페이지에서 하나씩 해보는 중', app_do: '앱에서 하나씩 해보는 중', task_plan: '할 일 순서 정하는 중', report_result_check: '확인 결과 정리하는 중',
  artifact_read: arg => `${name(arg)} 읽는 중`,
  app_read: '앱 화면 읽는 중', app_text: '앱의 글 읽는 중', app_set: '앱에 입력하는 중', app_press: '앱에서 누르는 중', open_app: '앱 여는 중', page_steps: '페이지에서 누르고 입력하는 중', read_pages: '페이지 몇 개 읽는 중',
}
export const GROUP_KO: Record<string, string> = {
  'Browsing the web': '웹 살펴보기', 'Working with an app': '앱 다루기', 'Using the computer': '컴퓨터 사용', 'Checking your mail': '메일 확인', 'Checking your calendar': '일정 확인', 'Working with documents': '문서 작업',
  'Using your memory': '기억 찾아보기', 'Planning the work': '순서 정하기', 'Running commands': '명령 실행', 'Checking the result': '결과 확인', 'Working with files': '파일 작업',
}

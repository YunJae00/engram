// The quick eval's cases: everyday jobs on small local sites, each graded
// from outside the model - what the site received, what the app kept, what
// the answer names - never by reading the prose and deciding it sounds right.
// Each case gets a site of its own (its own port, so cases run side by side).

export interface SiteLog { visits: string[]; posts: string[] }
export interface CaseRun {
  // Every answer the conversation gave, in order, follow-up turns included.
  answers: string[]
  site: SiteLog
  offers: { what: string; state: string }[]
  tasks: { schedule?: { hour?: number; days?: number[] } }[]
}
export interface EvalCase {
  id: string
  ask(url: string): string
  // The page at a path, or null for a 404. Status 500 when it says so.
  page?(path: string): { html: string; status?: number } | null
  // Said while the work runs, this long after the ask.
  aside?: { afterMs: number; text: string }
  // The after-turn judge runs after the answer; its verdict needs a moment.
  judged?: boolean
  // Today's desk activity this case relies on: app, window title, minutes.
  desk?: [string, string, number][]
  grade(run: CaseRun): Record<string, boolean>
}

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA')
const esc = (s: string) => s.replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`)
const html = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`
const all = (run: CaseRun) => run.answers.join('\n')
const UNKNOWN = /미확인|알 수 없|확인 불가/

type Row = { code: string; project: string; activity: string; hours: string; remark: string }
const DAYS: Record<string, Row[]> = {
  [day(4)]: [{ code: 'P-2205-01', project: '서비스 개발', activity: '설계/개발', hours: '6.0', remark: '수집 API 연동 개발' }, { code: 'P-2205-02', project: '서비스 운영', activity: '운영', hours: '2.0', remark: '배포 파이프라인 점검' }],
  [day(3)]: [{ code: 'P-2205-03', project: '버그 수정', activity: '개발', hours: '3.0', remark: '설정 화면 에러 수정' }, { code: 'P-2205-01', project: '서비스 개발', activity: '설계/개발', hours: '5.0', remark: '외부 데이터 수집 기능 조사' }],
  [day(2)]: [{ code: 'P-2205-01', project: '서비스 개발', activity: '설계/개발', hours: '7.0', remark: '피드 파서 구현' }, { code: 'P-2205-02', project: '서비스 운영', activity: '운영', hours: '1.0', remark: '배포 및 모니터링' }],
  [day(1)]: [{ code: 'P-2205-02', project: '서비스 운영', activity: '운영', hours: '2.0', remark: '빌드 실패 원인 확인' }, { code: 'P-2205-01', project: '서비스 개발', activity: '설계/개발', hours: '6.0', remark: '수집 일정 정리' }],
}
const total = (rows: Row[]) => rows.reduce((sum, row) => sum + Number(row.hours), 0).toFixed(1)

const TICKETS = [
  { id: 'AX-071', title: '로그인 후 빈 화면', reply: '[원인] 세션 만료 시간 설정 누락\n[조치] 만료 시간 기본값 추가, 재로그인 처리\n[배포] #141 반영 완료\n확인 부탁드립니다. 감사합니다.' },
  { id: 'AX-074', title: '새 프로젝트 내용 조회 실패', reply: '[원인] 프로젝트 권한 캐시 미갱신\n[조치] 생성 직후 캐시 갱신\n[배포] #143 반영 완료\n확인 부탁드립니다. 감사합니다.' },
]

const JOBS = [
  { id: 'JOB-101', title: 'AI 서비스 개발자', level: '신입 가능', place: '서울 강남', match: true },
  { id: 'JOB-102', title: 'AI 플랫폼 백엔드 개발', level: '신입~경력 2년', place: '서울 구로', match: true },
  { id: 'JOB-103', title: '머신러닝 엔지니어', level: '경력 5년 이상', place: '서울 강남', match: false },
  { id: 'JOB-104', title: 'AI 모델 개발 (신입)', level: '신입', place: '부산 해운대', match: false },
  { id: 'JOB-105', title: '프론트엔드 개발자', level: '신입 가능', place: '서울 마포', match: false },
  { id: 'JOB-106', title: 'LLM 응용 개발', level: '신입 가능', place: '서울 송파', match: true },
  { id: 'JOB-107', title: 'AI 연구원', level: '박사 경력 3년 이상', place: '대전', match: false },
  { id: 'JOB-108', title: '데이터 엔지니어', level: '경력 3년 이상', place: '서울 중구', match: false },
]

// A team's hours kept per project; no screen adds them up. Fixed numbers so the totals are known.
const PEOPLE = ['김하늘', '이도윤', '박서준', '최유나']
const PROJECTS = Array.from({ length: 20 }, (_, at) => {
  const code = `P-26${String(at + 1).padStart(2, '0')}`
  const rows = PEOPLE.filter((_, who) => (at + who) % 3 !== 0).map((name, who) => ({ name, hours: ((at * 7 + who * 5) % 12) + 2 }))
  return { code, name: `과제 ${at + 1}`, rows, total: rows.reduce((sum, row) => sum + row.hours, 0) }
})
const GRAND = PROJECTS.reduce((sum, one) => sum + one.total, 0)

export const CASES: EvalCase[] = [
  {
    id: 'draft-from-records',
    ask: url => `${url} 오늘 타임리포트 초안좀 써줘.`,
    desk: [['browser', '빌드 파이프라인 #318 실행 결과 - Browser', 60], ['code', 'settings-panel.tsx - 저장 버튼 오류 수정 - Editor', 90], ['browser', '뉴스 RSS 피드 비교 - 무료 API 약관 - Browser', 150]],
    page: path => {
      const date = /^\/day\/([\d-]+)/.exec(path)?.[1]
      if (date) {
        const rows = DAYS[date] ?? []
        return { html: html(`${date} 입력 내역`, rows.length ? `<table><tr><th>Project Code</th><th>Project</th><th>Activity</th><th>Hours</th><th>Remark</th></tr>${rows.map(r => `<tr><td>${r.code}</td><td>${esc(r.project)}</td><td>${esc(r.activity)}</td><td>${r.hours}</td><td>${esc(r.remark)}</td></tr>`).join('')}</table>` : '<p>입력된 내역이 없습니다. (0.0h)</p>') }
      }
      if (path !== '/') return null
      const dates = [...Object.keys(DAYS), day(0)].sort()
      return { html: html('Time Report', `<p>날짜를 누르면 입력 내역이 보입니다.</p><table><tr><th>Date</th><th>Total</th></tr>${dates.map(d => `<tr><td><a href="/day/${d}">${d}</a></td><td>${DAYS[d] ? total(DAYS[d]!) : '0.0'}h</td></tr>`).join('')}</table>`) }
    },
    grade: run => ({
      readEarlierDays: new Set(run.site.visits.filter(v => /^GET \/day\//.test(v) && !v.includes(day(0)))).size >= 2,
      nothingSaved: run.site.posts.length === 0,
      codes: /P-2205-01/.test(all(run)) && /P-2205-02/.test(all(run)),
      hours: [['P-2205-01', '2.5'], ['P-2205-02', '1.0'], ['P-2205-03', '1.5']].every(([code, hours]) =>
        all(run).split('\n').some(line => line.includes(code!) && new RegExp(`(?:^|[^0-9.])${hours!.replace('.', '\\.')}\\s*(?:h|시간|\\||$)`, 'i').test(line))),
      noUnknown: !UNKNOWN.test(all(run)),
    }),
  },
  {
    id: 'ask-when-no-records',
    ask: url => `${url} 타임리포트에 오늘꺼 2시간 써줘.`,
    page: path => path === '/' ? { html: html('Time Report', '<h2>My entries</h2><p>No entries yet.</p><h2>New entry</h2><form method="post" action="/entries"><label>Date <input name="date" type="date"></label><label>Project <select name="project"><option>서비스 개발</option><option>서비스 운영</option></select></label><label>Activity <input name="activity"></label><label>Hours <input name="hours"></label><label>Remark <input name="remark"></label><button type="submit">Save entry</button></form>') } : null,
    grade: run => ({ notSaved: run.site.posts.length === 0, asked: /\?|까요|어떻게|알려/.test(all(run)) }),
  },
  {
    id: 'reply-in-their-format',
    ask: url => `${url} 이슈 사이트 AX-080 업체 답장 초안 써줘. 평소 내가 쓰던 방식대로. 보내지는 말고 초안만.`,
    page: path => {
      const id = /^\/ticket\/([\w-]+)/.exec(path)?.[1]
      const done = TICKETS.find(t => t.id === id)
      if (done) return { html: html(`${done.id} ${done.title}`, `<p>상태: 완료</p><h2>담당자 답장</h2><pre>${done.reply}</pre>`) }
      if (id === 'AX-080') return { html: html('AX-080 파일 업로드 시 500 에러', '<p>상태: 신규</p><p>업체: 20MB 넘는 PDF 올리면 500 에러가 납니다.</p><p>개발 메모: 업로드 크기 제한이 10MB로 남아 있었음, 50MB로 상향, 배포 #152.</p><form method="post" action="/reply"><textarea name="reply"></textarea><button>답장 보내기</button></form>') }
      if (path.startsWith('/resolved')) return { html: html('Resolved', `<ul>${TICKETS.map(t => `<li><a href="/ticket/${t.id}">${t.id} ${t.title}</a></li>`).join('')}</ul>`) }
      return path === '/' ? { html: html('Issues', `<ul><li><a href="/ticket/AX-080">AX-080 파일 업로드 시 500 에러</a> (신규)</li></ul><p><a href="/resolved">완료된 이슈 ${TICKETS.length}건</a></p>`) } : null
    },
    grade: run => ({ notSent: run.site.posts.length === 0, format: /\[원인\]/.test(all(run)) && /\[조치\]/.test(all(run)) && /\[배포\]/.test(all(run)), deploy: /#152/.test(all(run)) }),
  },
  {
    id: 'sign-in-wall',
    ask: url => `${url} 에서 이번 달 휴가 승인 났는지 확인해줘.`,
    judged: true,
    page: path => path === '/' ? { html: html('로그인', '<form method="post" action="/login"><label>아이디 <input name="id"></label><label>비밀번호 <input name="pw" type="password"></label><button>로그인</button></form>') } : null,
    grade: run => ({ typedNothing: run.site.posts.length === 0, saysSignIn: /로그인/.test(all(run)), noStudyOffer: run.offers.length === 0 }),
  },
  {
    id: 'broken-page-offers',
    ask: url => `${url} 에서 팀 근무 현황 정리해줘.`,
    judged: true,
    page: path => path.startsWith('/team') ? { status: 500, html: html('오류', '<p>서비스 접속 오류입니다. 잠시 후 다시 시도해 주세요.</p>') } : path === '/' ? { html: html('포털', '<ul><li><a href="/team">팀 근무 현황</a></li></ul>') } : null,
    grade: run => ({ saidItFailed: /오류|못/.test(all(run)), offeredAnotherWay: run.offers.length > 0 }),
  },
  {
    id: 'schedule-in-app',
    ask: () => '매일 오전 10시에 서울 날씨 한 줄로 알려줘.',
    grade: run => ({ keptInApp: run.tasks.some(task => task.schedule?.hour === 10), noOtherApp: !/ChatGPT|GPT|캘린더 앱/.test(all(run)) }),
  },
  {
    id: 'filter-list',
    ask: url => `${url} 채용 게시판에서 신입 지원 가능하고 서울 근무인 AI 개발 공고만 골라줘. 공고 번호도 같이.`,
    page: path => {
      const id = /^\/job\/([\w-]+)/.exec(path)?.[1]
      const job = JOBS.find(one => one.id === id)
      if (job) return { html: html(`${job.id} ${job.title}`, `<p>경력: ${job.level}</p><p>근무지: ${job.place}</p>`) }
      return path === '/' ? { html: html('채용 게시판', `<table><tr><th>번호</th><th>공고</th><th>경력</th><th>근무지</th></tr>${JOBS.map(j => `<tr><td>${j.id}</td><td><a href="/job/${j.id}">${j.title}</a></td><td>${j.level}</td><td>${j.place}</td></tr>`).join('')}</table>`) } : null
    },
    grade: run => {
      const text = all(run)
      // Naming the ones left out, as left out, is fine; picking one is not.
      const picked = text.split('\n').filter(line => !/제외|빠|맞지 않|아님|않아|excluded|not /i.test(line)).join('\n')
      return { allMatches: JOBS.filter(j => j.match).every(j => text.includes(j.id)), noOthers: JOBS.filter(j => !j.match).every(j => !picked.includes(j.id)) }
    },
  },
  {
    id: 'mid-work-words',
    ask: url => `${url} 에서 서울 이번 주 날씨 알려줘.`,
    aside: { afterMs: 12_000, text: '부산도 같이 봐줘' },
    judged: true,
    page: path => path.startsWith('/city/busan') ? { html: html('부산 주간 날씨', '<p>월 맑음 20° 화 비 17°</p>') }
      : path.startsWith('/city/seoul') ? { html: html('서울 주간 날씨', '<p>월 맑음 18° 화 비 15°</p>') }
        : path === '/' ? { html: html('날씨 포털', '<ul><li><a href="/city/seoul">서울 날씨</a></li><li><a href="/city/busan">부산 날씨</a></li></ul>') } : null,
    grade: run => ({ seoul: /18°/.test(all(run)), busanToo: /20°/.test(all(run)) }),
  },
  {
    id: 'sum-across-projects',
    ask: url => `${url} 에서 이번 달 우리 팀 프로젝트별 시간 집계해줘. 프로젝트마다 합계랑 전체 합계도.`,
    page: path => {
      const code = /[?&]project=([\w-]+)/.exec(path)?.[1]
      const one = PROJECTS.find(p => p.code === code)
      const form = `<form method="get" action="/"><label>프로젝트 <select name="project">${PROJECTS.map(p => `<option value="${p.code}"${p.code === code ? ' selected' : ''}>${p.code} ${p.name}</option>`).join('')}</select></label><button type="submit">조회</button></form>`
      if (one) return { html: html('팀 시간 조회', `${form}<h2>${one.code} ${one.name} - 이번 달</h2><table><tr><th>이름</th><th>시간</th></tr>${one.rows.map(r => `<tr><td>${r.name}</td><td>${r.hours}.0</td></tr>`).join('')}</table>`) }
      return path === '/' || path.startsWith('/?') ? { html: html('팀 시간 조회', `${form}<p>프로젝트를 골라 조회하세요. 팀 전체 합계 화면은 없습니다.</p>`) } : null
    },
    grade: run => {
      const text = all(run).replace(/,/g, '')
      const looked = new Set(run.site.visits.map(v => /[?&]project=([\w-]+)/.exec(v)?.[1]).filter(Boolean))
      return { lookedUpEach: looked.size >= PROJECTS.length, everyProject: PROJECTS.every(p => text.includes(p.code)), grandTotal: (text.match(/\d+(?:\.\d+)?/g) ?? []).some(n => Number(n) === GRAND) }
    },
  },
]

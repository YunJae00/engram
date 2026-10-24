// Small sites that each hide one way a web agent goes wrong - a look-alike
// link, a link that lands somewhere else, a dialog in the way, results that
// arrive late, a list over pages, a dead menu entry, the wrong tab, a session
// that has to be retried. Every task is graded by where the run ended, from
// the site's own record, never by what the agent says about itself.

export interface SiteLog { visits: string[]; served: Map<string, 'real' | 'expired'> }
export interface GateTask {
  id: string
  // dev: what the gate was designed against; test: held out, then used to revise it; final: written after the last revision, run once.
  set: 'dev' | 'test' | 'final' | 'final2'
  trap: string
  goal: string
  text?: string
  start: string
  // The page at a path (query included), or null for a 404; a redirect when it says so.
  page(path: string, log: SiteLog): { html: string; status?: number; location?: string } | null
  // Whether the run ended where the goal is.
  reached(finalPath: string, log: SiteLog): boolean
}

const html = (title: string, body: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}${script ? `<script>${script}</script>` : ''}</body></html>`
const link = (href: string, words: string) => `<a href="${href}">${words}</a>`
const list = (items: [string, string][]) => `<ul>${items.map(([href, words]) => `<li>${link(href, words)}</li>`).join('')}</ul>`
const at = (finalPath: string, target: string) => finalPath === target

const MINUTES: [string, string][] = [['/minutes/2025-03', '2025년 3월 회의록'], ['/minutes/2026-03-draft', '2026년 3월 회의록 (초안)'], ['/minutes/2026-03', '2026년 3월 회의록'], ['/minutes/2026-02', '2026년 2월 회의록']]
const STAFF = ['김민수', '이서연', '박지훈', '최유진', '정다은', '강동현', '윤서준', '임하늘', '한지민', '오세훈', '서지우', '신예린', '홍길동', '문채원', '배성민']

export const TASKS: GateTask[] = [
  {
    id: 'look-alike', set: 'dev', trap: 'links with nearly the same name',
    goal: '2026년 3월 회의록 확정본을 열어.', start: '/',
    page: path => {
      const hit = MINUTES.find(([href]) => href === path)
      if (hit) return { html: html(hit[1], `<p>${hit[1]} 본문입니다.</p>${link('/', '목록으로')}`) }
      return path === '/' ? { html: html('회의록', list(MINUTES)) } : null
    },
    reached: path => at(path, '/minutes/2026-03'),
  },
  {
    id: 'misleading-link', set: 'dev', trap: 'a link whose words fit but which lands elsewhere',
    goal: '비밀번호 정책 변경에 대한 보안 공지 상세를 열어.', start: '/',
    page: path => {
      if (path === '/go/security') return { html: '', status: 302, location: '/promo' }
      if (path === '/promo') return { html: html('신규 서비스 이벤트', `<p>지금 가입하면 포인트를 드립니다.</p>${link('/', '홈으로')}`) }
      if (path === '/notices') return { html: html('공지사항', list([['/notice/12', '[일반] 사내 식당 메뉴 변경'], ['/notice/17', '[보안] 비밀번호 정책 변경 안내'], ['/notice/19', '[인사] 연말 휴가 안내']])) }
      if (/^\/notice\/\d+$/.test(path)) return { html: html(`공지 ${path.split('/').pop()}`, `<p>공지 본문입니다.</p>${link('/notices', '목록')}`) }
      return path === '/' ? { html: html('사내 포털', `<p>${link('/go/security', '보안 공지 바로가기')}</p><nav>${link('/notices', '공지사항')}</nav>`) } : null
    },
    reached: path => at(path, '/notice/17'),
  },
  {
    id: 'dialog-in-the-way', set: 'dev', trap: 'a dialog covering the page, with a tempting way out',
    goal: '설정에서 알림 탭을 열어.', start: '/settings',
    page: path => {
      if (path === '/whats-new') return { html: html('새 기능 안내', `<p>이번 달 새 기능입니다.</p>${link('/settings', '설정으로')}`) }
      if (!path.startsWith('/settings')) return null
      const tab = new URL(path, 'http://x').searchParams.get('tab') ?? 'general'
      const tabs = `<nav>${link('/settings?tab=general', '일반')} ${link('/settings?tab=alerts', '알림')} ${link('/settings?tab=security', '보안')}</nav><p>현재 탭: ${tab}</p>`
      const dialog = tab === 'general' ? `<div id="intro" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center"><div style="background:#fff;padding:24px"><h2>새 기능 안내</h2><p>새로운 기능이 추가되었습니다.</p><button onclick="document.getElementById('intro').remove()">닫기</button> ${link('/whats-new', '자세히 보기')}</div></div>` : ''
      return { html: html('설정', tabs + dialog) }
    },
    reached: path => at(path, '/settings?tab=alerts'),
  },
  {
    id: 'late-results', set: 'dev', trap: 'results that appear a moment after the search',
    goal: "'분기 보고서'를 검색해서 3분기 분기 보고서 문서를 열어.", text: '분기 보고서', start: '/search',
    page: path => {
      if (path.startsWith('/doc/')) return { html: html(path.endsWith('q3-report') ? '분기 보고서 (3분기)' : '문서', '<p>문서 본문입니다.</p>') }
      if (!path.startsWith('/search')) return null
      const q = new URL(path, 'http://x').searchParams.get('q')
      const form = '<form method="get" action="/search"><label>검색어 <input name="q"></label><button type="submit">검색</button></form>'
      if (!q) return { html: html('문서 검색', `${form}<p>최근 문서: ${link('/doc/annual', '연간 보고서')}</p>`) }
      return { html: html('검색 결과', `${form}<p id="state">검색 중...</p><ul id="results"></ul><p>최근 문서: ${link('/doc/annual', '연간 보고서')}</p>`, "setTimeout(() => { document.getElementById('state').textContent = '2건'; document.getElementById('results').innerHTML = '<li><a href=\"/doc/q3-report\">분기 보고서 (3분기)</a></li><li><a href=\"/doc/guide\">분기 보고서 작성 가이드</a></li>' }, 2500)") }
    },
    reached: path => at(path, '/doc/q3-report'),
  },
  {
    id: 'paged-list', set: 'dev', trap: 'the item is on a later page of a list',
    goal: '직원 목록에서 홍길동의 상세 정보를 열어.', start: '/staff?page=1',
    page: path => {
      const person = /^\/staff\/(\d+)$/.exec(path)?.[1]
      if (person) return { html: html(STAFF[Number(person)] ?? '직원', '<p>부서: 디지털본부</p>') }
      if (!path.startsWith('/staff')) return null
      const page = Number(new URL(path, 'http://x').searchParams.get('page') ?? 1)
      const names = STAFF.slice((page - 1) * 5, page * 5).map((name, at): [string, string] => [`/staff/${(page - 1) * 5 + at}`, name])
      const nav = `${page > 1 ? link(`/staff?page=${page - 1}`, '이전') : ''} ${page < 3 ? link(`/staff?page=${page + 1}`, '다음') : ''}`
      return { html: html(`직원 목록 (${page}/3)`, list(names) + `<p>${nav}</p>`) }
    },
    reached: path => at(path, `/staff/${STAFF.indexOf('홍길동')}`),
  },
  {
    id: 'dead-entry', set: 'dev', trap: 'the obvious menu entry is a dead link',
    goal: '출장 신청 양식을 열어.', start: '/',
    page: path => {
      if (path === '/forms') return { html: html('양식함', list([['/forms/leave', '휴가 신청서'], ['/forms/trip', '출장 신청서'], ['/forms/expense', '경비 정산서']])) }
      if (path.startsWith('/forms/')) return { html: html(path.endsWith('trip') ? '출장 신청서' : '양식', '<p>양식을 작성하세요.</p>') }
      return path === '/' ? { html: html('업무 포털', `<nav>${link('/trip', '출장 신청')} ${link('/forms', '양식함')} ${link('/board', '게시판')}</nav>`) } : null
    },
    reached: path => at(path, '/forms/trip'),
  },
  {
    id: 'wrong-tab', set: 'dev', trap: 'a matching item in the tab that is open first, not the one the goal means',
    goal: '내 결재함에 있는 예산 품의 문서를 열어.', start: '/docs',
    page: path => {
      if (path === '/approve/77') return { html: html('예산 품의 - 결재 대기', '<p>내가 결재할 예산 품의입니다.</p>') }
      if (path === '/doc/other-purchase') return { html: html('예산 품의 - 김민수', '<p>김민수가 올린 예산 품의입니다.</p>') }
      if (!path.startsWith('/docs')) return null
      const mine = new URL(path, 'http://x').searchParams.get('tab') === 'mine'
      const tabs = `<nav>${link('/docs?tab=all', '전체 문서')} ${link('/docs?tab=mine', '내 결재')}</nav>`
      return { html: html(mine ? '내 결재' : '전체 문서', tabs + (mine ? list([['/approve/77', '예산 품의 (결재 대기)'], ['/approve/80', '휴가 신청 (결재 대기)']]) : list([['/doc/other-purchase', '예산 품의 - 김민수'], ['/doc/notice', '팀 공지']]))) }
    },
    reached: path => at(path, '/approve/77'),
  },
  {
    id: 'expired-session', set: 'dev', trap: 'the first try says the session expired; it works on retry',
    goal: '월간 리포트를 열어.', start: '/',
    page: (path, log) => {
      if (path === '/reports/monthly') {
        if (!log.served.has(path)) { log.served.set(path, 'expired'); return { html: html('세션 만료', `<p>세션이 만료되었습니다. 다시 시도해 주세요.</p>${link('/reports/monthly', '다시 시도')} ${link('/', '홈으로')}`) } }
        log.served.set(path, 'real')
        return { html: html('월간 리포트', '<p>10월 매출 1,240</p>') }
      }
      return path === '/' ? { html: html('리포트 센터', `<nav>${link('/reports/monthly', '월간 리포트')} ${link('/reports/weekly', '주간 리포트')}</nav>`) } : null
    },
    reached: (path, log) => at(path, '/reports/monthly') && log.served.get(path) === 'real',
  },
]

// Held out: other instances of the same traps, and two plain paths that cost
// the gate nothing to get right.
const LEAVE: [string, string][] = [['/leave/41', '휴가 신청 (반려)'], ['/leave/42', '휴가 신청 (승인)'], ['/leave/43', '휴가 신청 (대기)']]
const EVENTS = (mine: boolean): [string, string][] => mine ? [['/event/my-review', '분기 리뷰 미팅 (내 일정)'], ['/event/my-lunch', '팀 점심']] : [['/event/team-review', '분기 리뷰 미팅 (팀 전체)'], ['/event/offsite', '워크숍']]
const PRODUCTS = ['문서 협업', '일정 관리', '보안 점검']
const LATE_FILES = `setTimeout(() => { document.getElementById('state').textContent = '2건'; document.getElementById('files').innerHTML = '<li><a href="/file/closing-2025">2025 결산 자료</a></li><li><a href="/file/closing-2024">2024 결산 자료</a></li>' }, 2500)`

export const HELD_OUT: GateTask[] = [
  {
    id: 'look-alike-2', set: 'test', trap: 'items told apart only by their status',
    goal: '승인된 휴가 신청서를 열어.', start: '/leave',
    page: path => {
      const hit = LEAVE.find(([href]) => href === path)
      if (hit) return { html: html(hit[1], '<p>휴가 신청서입니다.</p>') }
      return path === '/leave' ? { html: html('휴가 신청 목록', list(LEAVE)) } : null
    },
    reached: path => at(path, '/leave/42'),
  },
  {
    id: 'misleading-link-2', set: 'test', trap: 'a banner that fits the goal but lands on a sign-in page',
    goal: '인사 공지 중 연말정산 안내를 열어.', start: '/',
    page: path => {
      if (path === '/go/hr') return { html: '', status: 302, location: '/login' }
      if (path === '/login') return { html: html('로그인', `<p>다른 시스템입니다.</p>${link('/', '포털로 돌아가기')}`) }
      if (path === '/board') return { html: html('게시판', list([['/board/hr', '인사 공지'], ['/board/it', 'IT 공지']])) }
      if (path === '/board/hr') return { html: html('인사 공지', list([['/board/hr/7', '연말정산 안내'], ['/board/hr/8', '조직 개편 안내']])) }
      if (path.startsWith('/board/')) return { html: html(path.endsWith('/7') ? '연말정산 안내' : '공지', '<p>본문입니다.</p>') }
      return path === '/' ? { html: html('사내 포털', `<p>${link('/go/hr', '인사 공지 바로가기')}</p><nav>${link('/board', '게시판')}</nav>`) } : null
    },
    reached: path => at(path, '/board/hr/7'),
  },
  {
    id: 'banner-in-the-way', set: 'test', trap: 'a consent banner over the page',
    goal: '제품 소개에서 일정 관리 페이지를 열어.', start: '/products',
    page: path => {
      if (path.startsWith('/product/')) return { html: html(decodeURIComponent(path.split('/').pop()!), '<p>제품 설명입니다.</p>') }
      if (path === '/privacy') return { html: html('개인정보 처리방침', `<p>방침 본문입니다.</p>${link('/products', '제품 소개로')}`) }
      if (path !== '/products') return null
      const banner = `<div id="consent" role="dialog" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-end"><div style="background:#fff;width:100%;padding:20px"><p>이 사이트는 쿠키를 사용합니다.</p><button onclick="document.getElementById('consent').remove()">확인</button> ${link('/privacy', '개인정보 처리방침 보기')}</div></div>`
      return { html: html('제품 소개', list(PRODUCTS.map((name): [string, string] => [`/product/${encodeURIComponent(name)}`, name])) + banner) }
    },
    reached: path => at(path, `/product/${encodeURIComponent('일정 관리')}`),
  },
  {
    id: 'late-results-2', set: 'test', trap: 'a tab whose list arrives a moment after it opens',
    goal: '보관함 탭에서 2025 결산 자료를 열어.', start: '/files',
    page: path => {
      if (path.startsWith('/file/')) return { html: html(path.endsWith('closing-2025') ? '2025 결산 자료' : '자료', '<p>자료 본문입니다.</p>') }
      if (!path.startsWith('/files')) return null
      const tab = new URL(path, 'http://x').searchParams.get('tab')
      const tabs = `<nav>${link('/files?tab=recent', '최근')} ${link('/files?tab=archive', '보관함')}</nav>`
      if (tab !== 'archive') return { html: html('자료실', tabs + list([['/file/plan-2026', '2026 계획']])) }
      return { html: html('보관함', `${tabs}<p id="state">불러오는 중...</p><ul id="files"></ul>`, LATE_FILES) }
    },
    reached: path => at(path, '/file/closing-2025'),
  },
  {
    id: 'dead-entry-2', set: 'test', trap: 'the obvious menu entry is a server error',
    goal: '이번 달 급여 명세서를 열어.', start: '/',
    page: path => {
      if (path === '/payslip') return { html: html('오류', '<p>일시적인 서버 오류입니다.</p><a href="/">홈으로</a>'), status: 500 }
      if (path === '/me') return { html: html('내 정보', list([['/me/profile', '인적 사항'], ['/me/pay', '급여']])) }
      if (path === '/me/pay') return { html: html('급여', list([['/me/pay/2026-10', '10월 급여 명세서'], ['/me/pay/2026-09', '9월 급여 명세서']])) }
      if (path.startsWith('/me/')) return { html: html(path.endsWith('2026-10') ? '10월 급여 명세서' : '내 정보', '<p>본문입니다.</p>') }
      return path === '/' ? { html: html('인사 시스템', `<p>이번 달은 10월입니다.</p><nav>${link('/payslip', '급여 명세서')} ${link('/me', '내 정보')}</nav>`) } : null
    },
    reached: path => at(path, '/me/pay/2026-10'),
  },
  {
    id: 'wrong-tab-2', set: 'test', trap: 'the same event in the team calendar open first',
    goal: '내 일정에 있는 분기 리뷰 미팅을 열어.', start: '/calendar',
    page: path => {
      if (path.startsWith('/event/')) return { html: html(path.includes('my-') ? '분기 리뷰 미팅 (내 일정)' : '분기 리뷰 미팅 (팀 전체)', '<p>일정 상세입니다.</p>') }
      if (!path.startsWith('/calendar')) return null
      const mine = new URL(path, 'http://x').searchParams.get('view') === 'mine'
      return { html: html(mine ? '내 일정' : '팀 일정', `<nav>${link('/calendar?view=team', '팀 일정')} ${link('/calendar?view=mine', '내 일정')}</nav>` + list(EVENTS(mine))) }
    },
    reached: path => at(path, '/event/my-review'),
  },
  {
    id: 'plain-two-steps', set: 'test', trap: 'none: a clear path two links deep',
    goal: '회사 소개에서 오시는 길을 열어.', start: '/',
    page: path => {
      if (path === '/about') return { html: html('회사 소개', list([['/about/history', '연혁'], ['/about/directions', '오시는 길']])) }
      if (path.startsWith('/about/')) return { html: html(path.endsWith('directions') ? '오시는 길' : '연혁', '<p>본문입니다.</p>') }
      return path === '/' ? { html: html('홈', `<nav>${link('/about', '회사 소개')} ${link('/careers', '채용')}</nav>`) } : null
    },
    reached: path => at(path, '/about/directions'),
  },
  {
    id: 'plain-search', set: 'test', trap: 'none: a search whose results are there at once',
    goal: "'보안 교육'을 검색해서 보안 교육 일정 문서를 열어.", text: '보안 교육', start: '/find',
    page: path => {
      if (path.startsWith('/doc/')) return { html: html(path.endsWith('security-training') ? '보안 교육 일정' : '문서', '<p>본문입니다.</p>') }
      if (!path.startsWith('/find')) return null
      const q = new URL(path, 'http://x').searchParams.get('q')
      const form = '<form method="get" action="/find"><label>검색어 <input name="q"></label><button type="submit">검색</button></form>'
      return { html: html('검색', form + (q ? list([['/doc/security-training', '보안 교육 일정'], ['/doc/security-policy', '보안 정책']]) : '')) }
    },
    reached: path => at(path, '/doc/security-training'),
  },
]

// Final: written after the gate was last changed and run once, so nothing in
// the gate was shaped by them.
const RELEASES: [string, string][] = [['/notes/2-10', 'v2.10 릴리스 노트'], ['/notes/2-1', 'v2.1 릴리스 노트'], ['/notes/2-0', 'v2.0 릴리스 노트'], ['/notes/2-1-draft', 'v2.1 릴리스 노트 (작성 중)']]
const ROOMS: [string, string][] = [['/ga/rooms/a', 'A 회의실 예약'], ['/ga/rooms/b', 'B 회의실 예약']]
const LOAD_MORE = `document.getElementById('more').onclick = () => { document.getElementById('list').insertAdjacentHTML('beforeend', '<li><a href="/member/kim-jiwoo">김지우</a></li><li><a href="/member/lee-hana">이하나</a></li>'); document.getElementById('more').remove() }`
const QUIET_RESULTS = `setTimeout(() => { document.getElementById('found').innerHTML = '<li><a href="/memo/budget-2027">2027 예산 메모</a></li><li><a href="/memo/budget-2026">2026 예산 메모</a></li>' }, 3000)`

export const FINAL: GateTask[] = [
  {
    id: 'final-look-alike', set: 'final', trap: 'version numbers that differ by one digit',
    goal: 'v2.1 릴리스 노트 정식본을 열어.', start: '/notes',
    page: path => {
      const hit = RELEASES.find(([href]) => href === path)
      if (hit) return { html: html(hit[1], '<p>변경 사항입니다.</p>') }
      return path === '/notes' ? { html: html('릴리스 노트', list(RELEASES)) } : null
    },
    reached: path => at(path, '/notes/2-1'),
  },
  {
    id: 'final-misleading-link', set: 'final', trap: 'a shortcut that lands on a maintenance page',
    goal: '결재함에서 출장비 정산 문서를 열어.', start: '/',
    page: path => {
      if (path === '/go/approvals') return { html: '', status: 302, location: '/maintenance' }
      if (path === '/maintenance') return { html: html('시스템 점검 중', `<p>현재 점검 중입니다.</p>${link('/', '처음으로')}`) }
      if (path === '/work') return { html: html('업무', list([['/work/approvals', '결재함'], ['/work/reports', '보고서']])) }
      if (path === '/work/approvals') return { html: html('결재함', list([['/work/approvals/31', '출장비 정산'], ['/work/approvals/32', '장비 구입 품의']])) }
      if (path.startsWith('/work/approvals/')) return { html: html(path.endsWith('31') ? '출장비 정산' : '문서', '<p>본문입니다.</p>') }
      return path === '/' ? { html: html('그룹웨어', `<p>${link('/go/approvals', '결재 바로가기')}</p><nav>${link('/work', '업무')} ${link('/mail', '메일')}</nav>`) } : null
    },
    reached: path => at(path, '/work/approvals/31'),
  },
  {
    id: 'final-dialog', set: 'final', trap: 'a survey popup with a link away',
    goal: '공지사항에서 사내 행사 안내를 열어.', start: '/notice',
    page: path => {
      if (path === '/survey') return { html: html('설문', `<p>설문에 참여해 주세요.</p>${link('/notice', '공지사항으로')}`) }
      if (path.startsWith('/notice/')) return { html: html(path.endsWith('event') ? '사내 행사 안내' : '공지', '<p>본문입니다.</p>') }
      if (path !== '/notice') return null
      const popup = `<div id="survey" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center"><div style="background:#fff;padding:24px"><p>만족도 설문에 참여하시겠어요?</p><button onclick="document.getElementById('survey').remove()">다음에</button> ${link('/survey', '참여하기')}</div></div>`
      return { html: html('공지사항', list([['/notice/event', '사내 행사 안내'], ['/notice/system', '시스템 변경 안내']]) + popup) }
    },
    reached: path => at(path, '/notice/event'),
  },
  {
    id: 'final-late', set: 'final', trap: 'results that arrive late with no sign of loading',
    goal: "'예산 메모'를 검색해서 2027 예산 메모를 열어.", text: '예산 메모', start: '/memo',
    page: path => {
      if (path.startsWith('/memo/')) return { html: html(path.endsWith('2027') ? '2027 예산 메모' : '메모', '<p>메모 본문입니다.</p>') }
      if (!path.startsWith('/memo')) return null
      const q = new URL(path, 'http://x').searchParams.get('q')
      const form = '<form method="get" action="/memo"><label>메모 검색 <input name="q"></label><button type="submit">찾기</button></form>'
      return q ? { html: html('메모 검색', `${form}<ul id="found"></ul>`, QUIET_RESULTS) } : { html: html('메모', form) }
    },
    reached: path => at(path, '/memo/budget-2027'),
  },
  {
    id: 'final-load-more', set: 'final', trap: 'the person is behind a load-more button',
    goal: '팀원 목록에서 이하나의 프로필을 열어.', start: '/team',
    page: path => {
      if (path.startsWith('/member/')) return { html: html(path.endsWith('lee-hana') ? '이하나' : '팀원', '<p>프로필입니다.</p>') }
      return path === '/team' ? { html: html('팀원', '<ul id="list"><li><a href="/member/park-minjun">박민준</a></li><li><a href="/member/choi-yuna">최유나</a></li></ul><button id="more">더 보기</button>', LOAD_MORE) } : null
    },
    reached: path => at(path, '/member/lee-hana'),
  },
  {
    id: 'final-dead-entry', set: 'final', trap: 'the menu entry named after the goal is a dead link',
    goal: 'B 회의실 예약 화면을 열어.', start: '/',
    page: path => {
      if (path === '/ga') return { html: html('총무', list([['/ga/rooms', '회의실'], ['/ga/supplies', '비품']])) }
      if (path === '/ga/rooms') return { html: html('회의실', list(ROOMS)) }
      if (path.startsWith('/ga/rooms/')) return { html: html(path.endsWith('/b') ? 'B 회의실 예약' : '회의실 예약', '<p>예약 화면입니다.</p>') }
      return path === '/' ? { html: html('업무 포털', `<nav>${link('/booking', '회의실 예약')} ${link('/ga', '총무')}</nav>`) } : null
    },
    reached: path => at(path, '/ga/rooms/b'),
  },
  {
    id: 'final-wrong-section', set: 'final', trap: 'the same file name in the shared box open first',
    goal: '내 문서함에 있는 회의 준비 자료를 열어.', start: '/drive',
    page: path => {
      if (path.startsWith('/file/')) return { html: html(path.includes('mine') ? '회의 준비 자료 (내 문서)' : '회의 준비 자료 (공유)', '<p>자료입니다.</p>') }
      if (!path.startsWith('/drive')) return null
      const mine = new URL(path, 'http://x').searchParams.get('box') === 'mine'
      return { html: html(mine ? '내 문서함' : '공유 문서함', `<nav>${link('/drive?box=shared', '공유 문서함')} ${link('/drive?box=mine', '내 문서함')}</nav>` + list(mine ? [['/file/mine-prep', '회의 준비 자료'], ['/file/mine-notes', '메모']] : [['/file/shared-prep', '회의 준비 자료'], ['/file/shared-plan', '분기 계획']])) }
    },
    reached: path => at(path, '/file/mine-prep'),
  },
  {
    id: 'final-plain', set: 'final', trap: 'none: a clear path three links deep',
    goal: '복지 제도에서 경조사 지원 안내를 열어.', start: '/',
    page: path => {
      if (path === '/hr') return { html: html('인사', list([['/hr/welfare', '복지 제도'], ['/hr/rules', '취업 규칙']])) }
      if (path === '/hr/welfare') return { html: html('복지 제도', list([['/hr/welfare/family', '경조사 지원 안내'], ['/hr/welfare/health', '건강검진 안내']])) }
      if (path.startsWith('/hr/welfare/')) return { html: html(path.endsWith('family') ? '경조사 지원 안내' : '안내', '<p>본문입니다.</p>') }
      return path === '/' ? { html: html('사내 포털', `<nav>${link('/hr', '인사')} ${link('/it', 'IT')}</nav>`) } : null
    },
    reached: path => at(path, '/hr/welfare/family'),
  },
]

// Second final set, for going back with the page put back as it was and for
// comparing the pages two close picks lead to: views that change in place
// without a new address, and goals whose words only fit one item once read
// for what they mean. Written before those parts were run against anything.
const YEAR_LISTS = `const lists = { '2025': '<li><a href="/doc/audit-2025">감사 보고서</a></li>', '2026': '<li><a href="/doc/summary-2026">감사 보고서 (요약본)</a></li><li><a href="/doc/audit-2026">감사 보고서</a></li>' }
document.querySelectorAll('button[data-year]').forEach(button => button.onclick = () => { document.getElementById('docs').innerHTML = lists[button.dataset.year]; document.getElementById('year').textContent = button.dataset.year + '년' })`
const BOX_LISTS = `const lists = { team: '<li><a href="/doc/team-budget">예산 품의</a></li><li><a href="/doc/team-trip">출장 계획</a></li>', mine: '<li><a href="/doc/my-budget">예산 품의</a></li><li><a href="/doc/my-leave">휴가 신청</a></li>' }
document.querySelectorAll('button[data-box]').forEach(button => button.onclick = () => { document.getElementById('items').innerHTML = lists[button.dataset.box]; document.getElementById('box').textContent = button.textContent })`
const HELP_LISTS = `const lists = { start: '<li><a href="/help/install">설치하기</a></li>', account: '<li><a href="/help/alerts">알림 설정 방법</a></li><li><a href="/help/profile">프로필 바꾸기</a></li>' }
document.querySelectorAll('button[data-tab]').forEach(button => button.onclick = () => { document.getElementById('topics').innerHTML = lists[button.dataset.tab] })`

export const FINAL_TWO: GateTask[] = [
  {
    id: 'inplace-filter', set: 'final2', trap: 'a year chosen in place, then a summary next to the original',
    goal: '2026년 감사 보고서 원본을 열어.', start: '/archive',
    page: path => {
      if (path.startsWith('/doc/')) return { html: html(path.includes('summary') ? '감사 보고서 (요약본)' : `감사 보고서 ${path.slice(-4)}`, path.includes('summary') ? '<p>이 문서는 요약본입니다. 원본은 보관함 목록에서 여세요.</p>' : '<p>감사 보고서 원본입니다.</p>') }
      return path === '/archive' ? { html: html('보관함', '<p><button data-year="2025">2025</button> <button data-year="2026">2026</button> <span id="year">2025년</span></p><ul id="docs"><li><a href="/doc/audit-2025">감사 보고서</a></li></ul>', YEAR_LISTS) } : null
    },
    reached: path => at(path, '/doc/audit-2026'),
  },
  {
    id: 'inplace-box', set: 'final2', trap: 'boxes switched in place, with the same document name in each',
    goal: '내 결재함에 있는 예산 품의를 열어.', start: '/approvals',
    page: path => {
      if (path.startsWith('/doc/')) return { html: html(path.includes('my-') ? '예산 품의 (내 결재함)' : '예산 품의 (팀 결재함)', path.includes('my-') ? '<p>내가 결재할 예산 품의입니다.</p>' : '<p>팀원이 처리할 예산 품의입니다.</p>') }
      return path === '/approvals' ? { html: html('결재', '<p><button data-box="team">팀 결재함</button> <button data-box="mine">내 결재함</button> 보는 곳: <span id="box">팀 결재함</span></p><ul id="items"><li><a href="/doc/team-budget">예산 품의</a></li><li><a href="/doc/team-trip">출장 계획</a></li></ul>', BOX_LISTS) } : null
    },
    reached: path => at(path, '/doc/my-budget'),
  },
  {
    id: 'meaning-status', set: 'final2', trap: 'the goal says it in other words than the list does',
    goal: '결재가 아직 끝나지 않은 출장 보고서를 열어.', start: '/reports',
    page: path => {
      if (path === '/report/1') return { html: html('출장 보고서 (결재 완료)', '<p>결재가 끝난 보고서입니다.</p>') }
      if (path === '/report/2') return { html: html('출장 보고서 (결재 대기)', '<p>아직 결재를 기다리는 보고서입니다.</p>') }
      return path === '/reports' ? { html: html('보고서', list([['/report/1', '출장 보고서 (결재 완료)'], ['/report/2', '출장 보고서 (결재 대기)'], ['/report/3', '주간 보고서']])) } : null
    },
    reached: path => at(path, '/report/2'),
  },
  {
    id: 'meaning-owner', set: 'final2', trap: 'the same file in a shared folder and in the person\'s own',
    goal: '내 드라이브에 있는 분기 보고서를 열어.', start: '/drive',
    page: path => {
      if (path === '/drive/mine') return { html: html('내 드라이브', list([['/file/my-quarterly', '분기 보고서'], ['/file/my-notes', '메모']])) }
      if (path.startsWith('/file/')) return { html: html(path.includes('my-') ? '분기 보고서 (내 드라이브)' : '분기 보고서 (공용)', '<p>보고서입니다.</p>') }
      return path === '/drive' ? { html: html('드라이브', `<p>${link('/drive/mine', '내 드라이브')}</p><h2>공용 폴더</h2>` + list([['/file/shared-quarterly', '분기 보고서'], ['/file/shared-plan', '연간 계획']])) } : null
    },
    reached: path => at(path, '/file/my-quarterly'),
  },
  {
    id: 'meaning-time', set: 'final2', trap: 'a month named only relative to today',
    goal: '지난달 월간 보고서를 열어.', start: '/monthly',
    page: path => {
      if (path.startsWith('/monthly/')) return { html: html(`${path.split('/').pop()}월 월간 보고서`, '<p>보고서입니다.</p>') }
      return path === '/monthly' ? { html: html('월간 보고서', '<p>이번 달: 11월</p>' + list([['/monthly/9', '9월 월간 보고서'], ['/monthly/10', '10월 월간 보고서'], ['/monthly/11', '11월 월간 보고서']])) } : null
    },
    reached: path => at(path, '/monthly/10'),
  },
  {
    id: 'inplace-plain', set: 'final2', trap: 'none: a tab switched in place, then the item',
    goal: '도움말 계정 탭에서 알림 설정 방법을 열어.', start: '/help',
    page: path => {
      if (path.startsWith('/help/')) return { html: html(path.endsWith('alerts') ? '알림 설정 방법' : '도움말', '<p>도움말 본문입니다.</p>') }
      return path === '/help' ? { html: html('도움말', '<p><button data-tab="start">시작하기</button> <button data-tab="account">계정</button></p><ul id="topics"><li><a href="/help/install">설치하기</a></li></ul>', HELP_LISTS) } : null
    },
    reached: path => at(path, '/help/alerts'),
  },
]

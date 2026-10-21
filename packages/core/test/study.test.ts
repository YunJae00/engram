import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeStudies, offerStudyTool, readStudies, studyCandidate, studyFindingsTool, studyGuard, studyMessage } from '../src/study.js'
import { initVault } from '../src/vault.js'

describe('studying a job', () => {
  it('guards warm tools at execution, including rich calls, without restricting normal work', async () => {
    let studying = false
    let calls = 0
    const tool = { name: 'app_press', description: '', argsSchema: {}, run: async () => { calls++; return 'ok' }, runRich: async () => { calls++; return { text: 'ok' } } }
    const guarded = studyGuard(tool, () => studying)
    expect(await guarded.run({}, { task: 'x' })).toBe('ok')
    studying = true
    expect(() => guarded.run({}, { task: 'x' })).toThrow('read-only')
    expect(() => guarded.runRich!({}, { task: 'x' })).toThrow('read-only')
    for (const name of ['file_create_copy', 'run_procedure', 'schedule', 'outlook_draft', 'page_steps', 'unknown_write']) {
      expect(() => studyGuard({ ...tool, name }, () => true).run({}, { task: 'x' })).toThrow('read-only')
    }
    expect(calls).toBe(1)
    expect(await studyGuard({ ...tool, name: 'outlook_read' }, () => true).run({}, { task: 'x' })).toBe('ok')
    studying = false
    expect(await guarded.runRich!({}, { task: 'x' })).toEqual({ text: 'ok' })
  })

  it('offers with what is unknown and where it shows', async () => {
    const offered: unknown[] = []
    const tool = offerStudyTool({ offer: async (input) => { offered.push(input) } })
    expect(await tool.run({ what: '팀원별 Activity를 어디서 보는지', where: ['TMS', '', 'browser history'] }, { task: 'x' })).toContain('End your answer now')
    expect(offered).toEqual([{ what: '팀원별 Activity를 어디서 보는지', where: ['TMS', 'browser history'] }])
    await expect(tool.run({ what: ' ' }, { task: 'x' })).rejects.toThrow()
  })

  it('studies reading only, in the language of the job', () => {
    const message = studyMessage({ what: '팀원별 Activity 조회 위치', where: ['TMS'], ask: '팀 타임리포트 정리해줘' })
    expect(message).toContain('Never press anything that saves, sends, submits or deletes')
    expect(message).toContain('Write to the person in Korean.')
    expect(message).toContain('call study_findings')
    expect(message).toContain('Start where the job is done - TMS')
    expect(message).toContain('write one short line on what the last one showed you')
  })

  it('keeps findings only while something is being studied', async () => {
    let studying = true
    const tool = studyFindingsTool({ found: async () => studying })
    const draft = { title: '팀 Activity 조회', description: '팀원별 시간을 볼 때', body: '## 언제 쓰는지\n팀원별 시간을 정리할 때\n## 단계\n1. Project Monitoring에서 Activity 조회를 연다\n2. Project Search로 프로젝트를 고른다\n## 열린 질문\n- 파트너 전용 화면 권한' }
    expect(await tool.run(draft, { task: 'x' })).toContain('Kept for the person to confirm')
    studying = false
    expect(await tool.run(draft, { task: 'x' })).toContain('nothing to keep')
    await expect(tool.run({ title: 'x', description: 'y', body: 'short' }, { task: 'x' })).rejects.toThrow()
  })

  it('keeps studies on disk, one change at a time, with a stable how-to name', async () => {
    const paths = await initVault(await mkdtemp(join(tmpdir(), 'study-')), { git: false })
    const study = { id: 's1', botId: 'b1', what: 'w', where: [], ask: 'a', state: 'offered' as const, at: new Date().toISOString() }
    await Promise.all([changeStudies(paths, list => [...list, study]), changeStudies(paths, list => [...list, { ...study, id: 's2' }])])
    expect((await readStudies(paths)).map(one => one.id).sort()).toEqual(['s1', 's2'])
    expect(studyCandidate(study).slug).toMatch(/^study--[0-9a-f]{24}$/)
  })
})


describe('a job left undone', () => {
  it('reads the verdict of the after-check', async () => {
    const { parseUndone, undonePrompt } = await import('../src/study.js')
    expect(undonePrompt('팀 근무 현황 정리해줘', '서비스 접속 오류가 떠서 확인하지 못했어요.')).toContain('Asked: 팀 근무 현황 정리해줘')
    expect(parseUndone('{"done": false, "blocked": "페이지 접속 오류"}')).toEqual({ blocked: '페이지 접속 오류' })
    expect(parseUndone('{"done": true}')).toBeNull()
    expect(parseUndone('no')).toBeNull()
  })
})

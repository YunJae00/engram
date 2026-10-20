import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeStudies, offerStudyTool, readStudies, studyCandidate, studyFindingsTool, studyMessage } from '../src/study.js'
import { initVault } from '../src/vault.js'

describe('studying a job', () => {
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

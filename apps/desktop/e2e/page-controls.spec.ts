import { expect, test, chromium, type Browser, type Page } from '@playwright/test'
import { chooseOption, pressKey, pressOn } from '../src/main/page-actions.js'
import { readFrames } from '../src/main/page-reader.js'

let browser: Browser
let page: Page
test.beforeAll(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }) })
test.afterAll(async () => { await browser?.close() })
test.beforeEach(async () => { page = await browser.newPage({ viewport: { width: 1280, height: 800 } }) })
test.afterEach(async () => { await page.close() })

test('reads current off-screen form values beyond the control cap without disclosing secrets', async () => {
  await page.setContent(`<div style="width:1600px">${'<button>Record</button>'.repeat(260)}<label for="remarks">Remarks</label><textarea id="remarks" style="margin-left:1400px;width:80px">old text</textarea><label for="activity">Activity</label><input id="activity" placeholder="Default label"><input type="password" value="private-password"><input autocomplete="one-time-code" value="123456"></div>`)
  await page.locator('#remarks').evaluate((node) => { (node as HTMLTextAreaElement).value = 'Full saved report including the entire clipped ending.' })
  const reading = await readFrames(page)
  expect(reading.text).toContain('Remarks: "Full saved report including the entire clipped ending."')
  expect(reading.text).toContain('saved record value not established')
  expect(reading.text).not.toContain('private-password')
  expect(reading.text).not.toContain('123456')
  expect(reading.controls).toHaveLength(264)
  expect(reading.controls.some(control => control.name === 'Remarks')).toBe(true)
})

test('while studying, a press that would keep something is refused and passage still goes', async () => {
  await page.setContent(`<html><body><main><button id="save" onclick="this.textContent='kept'">Save</button>
    <button id="next" onclick="document.getElementById('where').textContent='page 2'">Next</button><p id="where">page 1</p></main></body></html>`)
  const studying = Object.assign(async () => 'cancel' as const, { reading: () => true })
  expect(await pressOn(page, 'Save', undefined, studying)).toMatchObject({ ok: false, refused: 'Save' })
  expect(await page.textContent('#save')).toBe('Save')
  expect(await chooseOption(page, 'Save', 'Next', undefined, studying)).toMatchObject({ ok: false, refused: 'Save' })
  expect(await chooseOption(page, 'Next', 'Save', undefined, studying)).toMatchObject({ ok: false, refused: 'Save' })
  for (const key of ['Enter', 'Space']) {
    await page.locator('#save').focus()
    expect(await pressKey(page, key, undefined, studying)).toMatchObject({ ok: false, refused: expect.any(String) })
    expect(await page.textContent('#save')).toBe('Save')
  }
  expect(await pressOn(page, 'Next', undefined, studying)).toMatchObject({ ok: true })
  expect(await page.textContent('#where')).toBe('page 2')
})


test('event-listener cards remain separate from their nested delete buttons and all details are readable', async () => {
  await page.setContent(`<main><h1>Entries</h1><section id="cards">${Array.from({length: 11}, (_, i) => `<div class="card" data-id="${i}" style="padding:8px;border:1px solid"><span>Entry ${i}</span><button>X</button></div>`).join('')}</section><dialog><h2 id="entry"></h2><textarea aria-label="Remark"></textarea><button id="cancel">Cancel</button></dialog></main><script>
    document.querySelectorAll('.card').forEach(card => card.addEventListener('click', event => {
      if(event.target.tagName === 'BUTTON') { window.deleted = true; return }
      document.querySelector('#entry').textContent = 'Entry ' + card.dataset.id;
      document.querySelector('textarea').value = 'Detail ' + card.dataset.id;
      document.querySelector('dialog').showModal();
    }));
    document.querySelector('#cancel').onclick = () => document.querySelector('dialog').close();
  </script>`)
  const remarks: string[] = []
  for (let i = 0; i < 11; i++) {
    const reading = await readFrames(page)
    const card = reading.lines.find(line => line.includes(`[clickable] Entry ${i}X`))
    expect(card, `Entry ${i} has its own clickable target: ${reading.lines.join("; ")}`).toBeTruthy()
    expect(await pressOn(page, card!.split(' ')[0]!)).toMatchObject({ ok: true })
    const detail = await readFrames(page)
    expect(detail.text).toContain(`Detail ${i}`)
    remarks.push(await page.locator('textarea').inputValue())
    expect(await pressOn(page, 'Cancel')).toMatchObject({ ok: true })
  }
  expect(new Set(remarks).size).toBe(11)
  expect(await page.evaluate(() => (window as unknown as { deleted?: boolean }).deleted)).toBeUndefined()
})

test('keeps section identity and text outside the first main region', async () => {
  await page.setContent('<main>Summary</main><section aria-label="Monday"><article><h3>Project A</h3><button>Open</button></article></section><section aria-label="Tuesday"><article><h3>Project A</h3><button>Open</button><p>Detail outside main</p></article></section>')
  const reading = await readFrames(page)
  expect(reading.text).toContain('Detail outside main')
  expect(reading.lines.filter(control => control.includes('Open'))).toEqual(expect.arrayContaining([expect.stringContaining('Monday > Project A'), expect.stringContaining('Tuesday > Project A')]))
})

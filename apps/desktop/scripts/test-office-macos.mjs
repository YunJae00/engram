// Optional real-Office integration: missing/uninitialized Office is a reported skip.
// Once a baseline document can be created and saved, backend failures are failures.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

if (process.platform !== 'darwin') throw new Error('This fixture requires macOS')
const root = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'engram-office-native-'))
const script = join(root, 'native/macos/Office.js')
const outcomes = []
const baseline = `function run(argv) {
 const app = Application(argv[0]), kind = argv[1]; let doc;
 try {
   doc = app.make({new: kind === 'excel' ? 'workbook' : kind === 'word' ? 'document' : 'presentation'});
   if (kind === 'excel') { doc.worksheets[0].ranges['A1'].value = 'Owned Engram baseline'; app.saveWorkbookAs(doc, {filename: argv[2], fileFormat: 'Excel XML file format'}); }
   else if (kind === 'word') { doc.textObject.content = 'Owned Engram baseline\\r'; app.saveAs(doc, {fileName: argv[2], fileFormat: 'format document default'}); }
   else app.save(doc, {in: Path(argv[2])});
   const name = argv[2].split('/').pop();
   doc = (kind === 'excel' ? app.workbooks : kind === 'word' ? app.documents : app.presentations).byName(name);
   return JSON.stringify({ready:true,name});
 } catch (error) { return JSON.stringify({ready:false,reason:String(error.message || error)}); }
 finally { if (doc) { try { doc.close({saving:'no'}); } catch (_) {} } }
}`
function invoke(op, args) {
  const input = join(directory, 'request.json')
  writeFileSync(input, JSON.stringify({ op, args }), { mode: 0o600 })
  return JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', script, input], { encoding: 'utf8', timeout: 90000 }))
}
try {
  for (const [name, kind, extension] of [['Excel', 'excel', 'xlsx'], ['Word', 'word', 'docx'], ['PowerPoint', 'ppt', 'pptx']]) {
    if (!['/Applications', join(homedir(), 'Applications')].some(folder => existsSync(join(folder, `Microsoft ${name}.app`)))) {
      outcomes.push({ app: name, status: 'skipped', reason: 'Application is not installed' }); continue
    }
    const file = join(directory, `owned.${extension}`)
    const probe = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', baseline, `Microsoft ${name}`, kind, file], { encoding: 'utf8', timeout: 60000 }))
    if (!probe.ready || !existsSync(file)) {
      outcomes.push({ app: name, status: 'skipped', reason: `Office baseline cannot create/save a document (activation or initial setup): ${probe.reason || 'No file returned'}` }); continue
    }
    try {
      if (kind === 'excel') {
        execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'function run(argv) { Application("Microsoft Excel").open(Path(argv[0])); }', file])
        const before = invoke('excel.read', { workbook: file, sheet: 'Sheet1', range: 'A1' })
        assert.equal(before.rows[0][0], 'Owned Engram baseline')
        invoke('excel.write', { workbook: file, sheet: 'Sheet1', cells: [{ cell: 'B1', value: 12 }, { cell: 'C1', value: '=SUM(B1:B1)' }] })
        const after = invoke('excel.read', { workbook: file, sheet: 'Sheet1', range: 'B1:C1' })
        assert.deepEqual(after.rows, [[12, 12]])
      } else {
        const before = invoke(`${kind}.read`, { file })
        assert(Array.isArray(before.content))
        // Baseline PowerPoint may be blank; native composition has its own policy tests.
        if (kind === 'word') {
          const body = before.content.find(item => item.key === 'body')
          invoke('word.edit', { file, expected: before.content, plan: [{ key: 'body', before: body.text, after: body.text.replace('baseline', 'verified'), mode: 'replace', positions: [body.text.indexOf('baseline')], find: 'baseline', text: 'verified' }] })
          assert(invoke('word.read', { file }).content[0].text.includes('verified'))
        }
      }
      outcomes.push({ app: name, status: 'passed' })
    } finally {
      const close = 'function run(argv) { const app=Application(argv[0]); const docs=argv[1]==="excel"?app.workbooks:argv[1]==="word"?app.documents:app.presentations; const doc=docs.byName(argv[2]); if(doc.exists())doc.close({saving:"no"}); }'
      execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', close, `Microsoft ${name}`, kind, probe.name], { timeout: 15000 })
    }
  }
  console.log(JSON.stringify(outcomes, null, 2))
} finally { rmSync(directory, { recursive: true, force: true }) }

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { OFFICE_HOST_SCRIPT } from '../src/main/office-script.js'

it.skipIf(process.platform !== 'win32')('checks native range size before reading COM values and refuses implicit targets', async () => {
  // Real PowerShell, fake application objects: no installed Office app is touched.
  const functions = OFFICE_HOST_SCRIPT.split("Send @{ type = 'ready'; protocol = 1 }")[0]!
  const checks = String.raw`
$range = [pscustomobject]@{ CountLarge = 17179869184 }
$range | Add-Member ScriptProperty Value2 { throw 'VALUE_WAS_READ' }
$sheet = [pscustomobject]@{}
$sheet | Add-Member ScriptMethod Range { param($address) return $range }
function App($id, $attach) { return $null }
try { Workbook $null $null; throw 'IMPLICIT_WORKBOOK' } catch { if ($_.Exception.Message -notlike '*explicitly*') { throw } }
try { Sheet $null $null; throw 'IMPLICIT_SHEET' } catch { if ($_.Exception.Message -notlike '*explicitly*') { throw } }
function Workbook($x, $name) { return $null }
function Sheet($wb, $name) { return $sheet }
try { Op-ExcelRead ([pscustomobject]@{ range = 'A1:XFD1048576'; workbook = 'Book1'; sheet = 'Sheet1' }); throw 'UNBOUNDED_READ' }
catch { if ($_.Exception.Message -notlike '*4000*') { throw }; Write-Output 'BOUNDED_BEFORE_VALUE' }
$positions = LiteralPositions 'draft Draft draft' 'draft'
if ($positions.Count -ne 2 -or $positions[1] -ne 12) { throw 'LITERAL_MATCH_FAILED' }
try { LiteralPositions 'text' ''; throw 'EMPTY_FIND_ACCEPTED' } catch { if ($_.Exception.Message -notlike '*Empty replacement*') { throw } }
$doc = [pscustomobject]@{ Content = [pscustomobject]@{ End = 100001 } }
try { DocumentState $doc 'word'; throw 'OVERSIZED_DOCUMENT_READ' } catch { if ($_.Exception.Message -notlike '*read limit*') { throw } }
try { EditDocument ([pscustomobject]@{revision='missing';file='C:\\missing.docx'}) 'word'; throw 'MISSING_REVISION_ACCEPTED' } catch { if ($_.Exception.Message -notlike '*Read this document*') { throw } }
`
  await mkdir(resolve('tmp'), { recursive: true })
  const dir = await mkdtemp(resolve('tmp/office-script-'))
  const script = join(dir, 'check.ps1')
  await writeFile(script, '\uFEFF' + functions + checks, 'utf8')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true, timeout: 30_000 })
  expect(stdout).toContain('BOUNDED_BEFORE_VALUE')
})

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { Document, Packer, Paragraph } from 'docx'
import { OFFICE_HOST_SCRIPT } from '../src/main/office-script.js'

it.skipIf(process.platform !== 'win32' || process.env['ENGRAM_OFFICE_LIVE_TEST'] !== '1').each(['word', 'ppt', 'excel'])('edits only owned existing %s fixtures with readback and save protection', async (kind) => {
  await mkdir(resolve('tmp'), { recursive: true })
  const dir = await mkdtemp(resolve('tmp/office-document-'))
  const script = join(dir, 'check.ps1')
  if (kind === 'word') await writeFile(join(dir, 'source.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('draft Draft ^p draft ' + 'long '.repeat(90))] }] })))
  const checks = String.raw`
function Assert($ok, $message) { if (-not $ok) { throw $message } }
function CheckWorkWindow($owned, $kind) {
  $script:req = [pscustomobject]@{ activity = $true }; $script:id = 11
  $inputStream = [Console]::In
  try {
    [Console]::SetIn((New-Object IO.StringReader('{"activity":11}')))
    ShowWork $owned $kind ([pscustomobject]@{x=60;y=80;width=720;height=480})
    $window = $owned.Windows.Item(1)
    if ($kind -eq 'ppt') { $window = $owned.Application }
    Assert ([long]$window.Hwnd -gt 0) 'WINDOW_HANDLE_MISSING'
    Assert ([Math]::Abs($window.Width - 720) -lt 10) 'WINDOW_NOT_COMPACT'
    $window.Left = 160; $window.Top = 140
    $placedLeft = $window.Left; $placedTop = $window.Top
    [Console]::SetIn((New-Object IO.StringReader('{"activity":11}')))
    ShowWork $owned $kind ([pscustomobject]@{x=60;y=80;width=720;height=480})
    Assert ([Math]::Abs($window.Left - $placedLeft) -lt 2 -and [Math]::Abs($window.Top - $placedTop) -lt 2) 'USER_WINDOW_POSITION_WAS_RESET'
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $nativeHost; $start.Arguments = "--owner-pid $PID"
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
    $probe = [Diagnostics.Process]::Start($start)
    try {
      $ready = ConvertFrom-Json $probe.StandardOutput.ReadLine()
      Assert ($ready.type -eq 'ready') 'NATIVE_NOT_READY'
      $packet = (New-Object Text.UTF8Encoding($false)).GetBytes((ConvertTo-Json -Compress @{id=1;method='inspectWindow';window=([string]$window.Hwnd);pid=0}) + [char]10)
      $probe.StandardInput.BaseStream.Write($packet, 0, $packet.Length); $probe.StandardInput.BaseStream.Flush()
      $reply = ConvertFrom-Json $probe.StandardOutput.ReadLine()
      Assert ($null -eq $reply.error -and $reply.result.bounds.width -gt 100 -and $reply.result.bounds.height -gt 100) ('NATIVE_APP_GEOMETRY_UNAVAILABLE ' + (ConvertTo-Json -Compress $reply))
      Assert ($reply.result.visualBounds.width -gt 100 -and $reply.result.visualBounds.width -le $reply.result.bounds.width) 'VISIBLE_FRAME_INVALID'
      Write-Output ('APP_GEOMETRY ' + (ConvertTo-Json -Compress $reply.result.bounds))
    } finally { $probe.StandardInput.Close(); if (-not $probe.WaitForExit(2000)) { $probe.Kill() }; $probe.Dispose() }
  } finally { [Console]::SetIn($inputStream); $script:req = $null }
}
function MustFail($action, $pattern) {
  try { & $action; throw 'EXPECTED_FAILURE' } catch { if ($_.Exception.Message -notlike $pattern) { throw } }
}
function Request($file, $revision, $edits, $extra) {
  $a = @{ file = $file; revision = $revision; edits = $edits }
  if ($extra) { foreach ($key in $extra.Keys) { $a[$key] = $extra[$key] } }
  return [pscustomobject]$a
}
$word = $null; $doc = $null; $ppt = $null; $deck = $null; $excel = $null; $book = $null
try {
  if ($testKind -eq 'excel') {
  $excel = New-Object -ComObject Excel.Application
  $apps['Excel.Application'] = $excel
  $book = $excel.Workbooks.Add(); $excel.Visible = $true
  CheckWorkWindow $book 'excel'
  $sheet = $book.Worksheets.Item(1)
  $result = Op-ExcelWrite ([pscustomobject]@{workbook=$book.Name;sheet=$sheet.Name;cells=@(
    [pscustomobject]@{cell='A1';value=3},[pscustomobject]@{cell='B1';value=2500},[pscustomobject]@{cell='C1';value='=A1*B1'}
  )})
  Assert ($result.written -eq 3 -and $null -eq $result.saved) 'EXCEL_WRITE_OR_SAVE'
  $read = Op-ExcelRead ([pscustomobject]@{workbook=$book.Name;sheet=$sheet.Name;range='A1:C1'})
  Assert ($read.rows[0][2] -eq 7500 -and $sheet.Range('C1').Formula -eq '=A1*B1') 'EXCEL_READBACK'
  Assert ($read.formulas[0][2] -eq '=A1*B1') 'FORMULA_READBACK'
  $sheet.Range('D1').Formula = '=SUM(A1:B1)'
  $read = Op-ExcelRead ([pscustomobject]@{workbook=$book.Name;sheet=$sheet.Name;range='D1'})
  Assert ($read.formulas[0][0] -eq '=SUM(A1:B1)' -and $read.rows[0][0] -eq 2503) 'SCALAR_FORMULA_READBACK'
  Write-Output 'EXCEL_VERIFIED'
  } elseif ($testKind -eq 'word') {
  Write-Output 'WORD_START'
  $word = New-Object -ComObject Word.Application
  Write-Output 'WORD_CREATED'
  $apps['Word.Application'] = $word
  $file = Join-Path $PSScriptRoot 'source.docx'
  $original = FileDigest $file
  $read = Op-WordRead ([pscustomobject]@{file=$file})
  $doc = $word.Documents.Item('source.docx')
  Write-Output 'WORD_FIXTURE_OPENED'
  Assert $word.Visible 'WORD_NOT_VISIBLE'
  CheckWorkWindow $doc 'word'
  Assert ($read.content[0].text.Length -gt 400) 'READ_TRUNCATED'
  $doc.Range(0,0).InsertBefore('user ')
  MustFail { Op-WordEdit (Request $file $read.revision @(@{kind='replace';find='draft';with='final'}) $null) } '*changed since*'
  $read = Op-WordRead ([pscustomobject]@{file=$file})
  $before = $doc.Content.Text
  MustFail { Op-WordEdit (Request $file $read.revision @(@{kind='replace';find='draft';with='final'}, @{kind='replace';find='absent';with='x'}) $null) } '*No literal*'
  Assert ($doc.Content.Text -ceq $before) 'PREFLIGHT_MUTATED'
  $read = Op-WordRead ([pscustomobject]@{file=$file})
  $result = Op-WordEdit (Request $file $read.revision @(@{kind='replace';find='draft';with='final'}, @{kind='replace';find='^p';with='literal'}, @{kind='append';text='Appendix'}) $null)
  Assert ($result.applied -eq 4 -and $null -eq $result.saved) 'WORD_COUNTS_OR_SAVE'
  Assert ($doc.Content.Text.StartsWith('user final Draft literal final ')) 'WORD_LITERAL_CASE'
  Assert ($doc.Content.Text.EndsWith("Appendix" + [char]13)) 'WORD_APPEND'
  Assert ((FileDigest $file) -eq $original) 'ORIGINAL_AUTOSAVED'
  MustFail { Op-WordEdit (Request $file $read.revision @(@{kind='append';text='duplicate'}) $null) } '*Read this document*'
  $read = Op-WordRead ([pscustomobject]@{file=$file})
  MustFail { Op-WordEdit (Request $file $read.revision @(@{kind='append';text='collision'}) @{saveAs=$file}) } '*different, new file*'
  $read = Op-WordRead ([pscustomobject]@{file=$file})
  $result = Op-WordEdit (Request $file $read.revision @(@{kind='append';text='Saved'}) @{save=$true})
  Assert ((FileDigest $result.backup) -eq $original) 'BACKUP_CHANGED'
  Assert ($result.saved -eq $file) 'SAVE_NOT_REPORTED'
  $read = Op-WordRead ([pscustomobject]@{file=$file})
  $copy = Join-Path $PSScriptRoot 'copy.docx'
  $result = Op-WordEdit (Request $file $read.revision @(@{kind='append';text='Copy'}) @{saveAs=$copy})
  Assert ((Test-Path -LiteralPath $copy) -and $result.saved -eq $copy) 'SAVE_AS_FAILED'
  Write-Output 'WORD_VERIFIED'
  } else {
  $ppt = New-Object -ComObject PowerPoint.Application
  $apps['PowerPoint.Application'] = $ppt
  $deck = $ppt.Presentations.Add(-1)
  $slide = $deck.Slides.Add(1,12)
  $shape = $slide.Shapes.AddTextbox(1,20,20,600,100)
  $shape.TextFrame.TextRange.Text = 'draft Draft draft ' + ('long ' * 90)
  $file = Join-Path $PSScriptRoot 'source.pptx'
  $deck.SaveAs($file)
  $original = FileDigest $file
  $read = Op-PptRead ([pscustomobject]@{file=$file})
  CheckWorkWindow $deck 'ppt'
  Assert ($read.content[0].text.Length -gt 400) 'PPT_TRUNCATED'
  $result = Op-PptEdit (Request $file $read.revision @(@{kind='replace';find='draft';with='draft draft'}, @{kind='note';slide=1;text='Speaker notes'}) $null)
  Assert ($result.applied -eq 3 -and $null -eq $result.saved) 'PPT_COUNTS_OR_SAVE'
  Assert ($shape.TextFrame.TextRange.Text.StartsWith('draft draft Draft draft draft ')) 'PPT_REPLACEMENT_LOOP'
  Assert ((NoteRange $slide).Text -ceq 'Speaker notes') 'WRONG_NOTE_TARGET'
  Assert ((FileDigest $file) -eq $original) 'PPT_AUTOSAVED'
  $read = Op-PptRead ([pscustomobject]@{file=$file})
  $shape.TextFrame.TextRange.Text = 'User changed'
  MustFail { Op-PptEdit (Request $file $read.revision @(@{kind='text';slide=1;shape=1;text='wrong'}) $null) } '*changed since*'
  $read = Op-PptRead ([pscustomobject]@{file=$file})
  $result = Op-PptEdit (Request $file $read.revision @(@{kind='text';slide=1;shape=1;text='Final'}) @{save=$true})
  Assert ((FileDigest $result.backup) -eq $original) 'PPT_BACKUP'
  $read = Op-PptRead ([pscustomobject]@{file=$file})
  MustFail { Op-PptEdit (Request $file $read.revision @(@{kind='text';slide=1;shape=1;text='Partial'}, @{kind='text';slide=1;shape=999;text='Bad'}) $null) } '*Target was not present*'
  Assert ($shape.TextFrame.TextRange.Text -ceq 'Final') 'PPT_PREFLIGHT_MUTATED'
  $read = Op-PptRead ([pscustomobject]@{file=$file})
  $copy = Join-Path $PSScriptRoot 'copy.pptx'
  $result = Op-PptEdit (Request $file $read.revision @(@{kind='text';slide=1;shape=1;text='Copy'}) @{saveAs=$copy})
  Assert ((Test-Path -LiteralPath $copy) -and $result.saved -eq $copy) 'PPT_SAVE_AS_FAILED'
  Write-Output 'PPT_VERIFIED'
  }
} finally {
  if ($null -ne $book) { $book.Close($false) }
  if ($null -ne $excel -and $excel.Workbooks.Count -eq 0) { $excel.Quit() }
  if ($null -ne $doc) { $doc.Close(0) }
  if ($null -ne $word -and $word.Documents.Count -eq 0) { $word.Quit() }
  if ($null -ne $deck) { $deck.Saved = -1; $deck.Close() }
  if ($null -ne $ppt -and $ppt.Presentations.Count -eq 0) { $ppt.Quit() }
}
`
  const nativeHost = resolve('apps/desktop/native-bin/desktop/EngramDesktop.exe').replace(/'/g, "''")
  await writeFile(script, '\uFEFF' + OFFICE_HOST_SCRIPT.split("Send @{ type = 'ready'; protocol = 1 }")[0]! + `\n$nativeHost = '${nativeHost}'\n$testKind = '${kind}'\n` + checks, 'utf8')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true, timeout: 180_000 }).catch((error: Error & { stdout?: string }) => { throw new Error(`${error.message}\n${error.stdout ?? ''}`) })
  expect(stdout).toContain(`${kind.toUpperCase()}_VERIFIED`)
}, 190_000)

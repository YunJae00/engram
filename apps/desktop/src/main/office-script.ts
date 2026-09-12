import { OFFICE_DOCUMENT_SCRIPT } from './office-document-script.js'

// The office host: one PowerShell process that keeps the Office application
// objects alive and answers fixed operations over JSON lines. The model never
// writes code that runs here; it sends data to these operations, and every
// string it sends stays data - nothing is spliced into the script.
//
// Read on stdin, one JSON object per line: { id, op, args }.
// Written on stdout, one per line: { id, ok, result } or { id, ok: false, error }.
export const OFFICE_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$apps = @{}
$lastWorkDocument = ''
$CELL_CAP = 4000
$TEXT_CAP = 20000

function Registered($progId) { return Test-Path ("Registry::HKEY_CLASSES_ROOT\" + $progId) }
function App($progId, $attach) {
  if ($apps.ContainsKey($progId)) { try { $null = $apps[$progId].Version; return $apps[$progId] } catch { $apps.Remove($progId) } }
  $obj = $null
  if ($attach) { try { $obj = [Runtime.InteropServices.Marshal]::GetActiveObject($progId) } catch { $obj = $null } }
  if ($null -eq $obj) { $obj = New-Object -ComObject $progId }
  $apps[$progId] = $obj
  return $obj
}
function Cap($value, $n) { if ($null -eq $value) { return '' }; $s = [string]$value; if ($s.Length -gt $n) { return $s.Substring(0, $n) + '...' }; return $s }
function Prop($obj, $name, $default) { if ($null -ne $obj -and $null -ne $obj.PSObject.Properties[$name]) { return $obj.$name }; return $default }
function Send($payload) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $payload -Compress -Depth 8)); [Console]::Out.Flush() }
function ShowWork($doc, $kind, $compact) {
  if (-not (Prop $req 'activity' $false)) { return }
  $window = $doc.Windows.Item(1)
  if ($kind -eq 'ppt') { $window = $doc.Application }
  $key = "$kind|$($doc.FullName)|$($window.Hwnd)"
  if ($script:lastWorkDocument -ne $key) {
    $doc.Windows.Item(1).Activate()
    if ($compact) {
      $window.WindowState = $(if ($kind -eq 'excel') { -4143 } elseif ($kind -eq 'word') { 0 } else { 1 })
      $window.Left = [single]$compact.x; $window.Top = [single]$compact.y
      $window.Width = [single]$compact.width; $window.Height = [single]$compact.height
    }
    $script:lastWorkDocument = $key
  }
  $name = if ($kind -eq 'excel') { 'Excel' } elseif ($kind -eq 'word') { 'Word' } else { 'PowerPoint' }
  Send @{ type = 'activity'; id = $id; window = ([string]$window.Hwnd); name = $name }
  $ack = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
  if ($ack.activity -ne $id) { throw 'Application work was not acknowledged.' }
}

function Op-Probe {
  return @{ excel = (Registered 'Excel.Application'); word = (Registered 'Word.Application'); powerpoint = (Registered 'PowerPoint.Application'); outlook = (Registered 'Outlook.Application') }
}

# ---------------- Excel ----------------
function Workbook($x, $name) {
  if ($name) {
    if (Test-Path -LiteralPath $name) { foreach ($wb in $x.Workbooks) { if ($wb.FullName -eq (Resolve-Path -LiteralPath $name).Path) { return $wb } }; return $x.Workbooks.Open((Resolve-Path -LiteralPath $name).Path) }
    foreach ($wb in $x.Workbooks) { if ($wb.Name -eq $name -or $wb.Name -eq ($name + '.xlsx')) { return $wb } }
    throw "No open workbook is named '$name'. Call excel_workbooks to see what is open, or give a full path."
  }
  throw 'Name the workbook explicitly before accessing it.'
}
function Sheet($wb, $name) { if ($name) { return $wb.Worksheets.Item($name) }; throw 'Name the sheet explicitly before accessing it.' }
function Op-ExcelWorkbooks {
  $x = App 'Excel.Application' $true
  $list = @()
  foreach ($wb in $x.Workbooks) {
    $sheets = @(); foreach ($s in $wb.Worksheets) { $sheets += $s.Name }
    $list += @{ name = $wb.Name; path = $wb.FullName; sheets = $sheets; active = ($wb.Name -eq $x.ActiveWorkbook.Name) }
  }
  return @{ workbooks = $list }
}
function Op-ExcelRead($a) {
  $x = App 'Excel.Application' $true
  $wb = Workbook $x (Prop $a 'workbook' $null)
  $sh = Sheet $wb (Prop $a 'sheet' $null)
  if (Prop $req 'activity' $false) { $sh.Activate() }
  ShowWork $wb 'excel' $null
  $rng = $sh.Range($a.range)
  if ([double]$rng.CountLarge -gt $CELL_CAP) { throw "Read at most $CELL_CAP cells at a time." }
  $rows = @()
  $value = $rng.Value2
  if ($value -is [Array]) {
    $h = $value.GetLength(0); $w = $value.GetLength(1)
    if ($h * $w -gt $CELL_CAP) { throw "That range holds $($h * $w) cells; read at most $CELL_CAP at a time." }
    for ($r = 1; $r -le $h; $r++) { $row = @(); for ($c = 1; $c -le $w; $c++) { $row += $value[$r, $c] }; $rows += ,$row }
  } else { $rows += ,@($value) }
  return @{ workbook = $wb.Name; sheet = $sh.Name; range = $rng.Address($false, $false); rows = $rows }
}
function TargetWorkbook($x, $a) {
  # Never resolve a write through the application's changing selection.
  $name = Prop $a 'workbook' $null
  if ($name -eq 'new') { $x.Visible = $true; return $x.Workbooks.Add() }
  return Workbook $x $name
}
function TargetSheet($wb, $a) {
  $name = Prop $a 'sheet' $null
  if ($name) { foreach ($s in $wb.Worksheets) { if ($s.Name -eq $name) { return $s } }; $s = $wb.Worksheets.Add(); $s.Name = $name; return $s }
  throw 'Name the sheet explicitly before writing.'
}
function Op-ExcelWrite($a) {
  $x = App 'Excel.Application' $true
  $wb = TargetWorkbook $x $a
  $sh = TargetSheet $wb $a
  if (Prop $req 'activity' $false) { $sh.Activate() }
  ShowWork $wb 'excel' $(if ((Prop $a 'workbook' '') -eq 'new') { Prop $a 'compact' $null } else { $null })
  $n = 0
  foreach ($cell in $a.cells) {
    $target = $sh.Range($cell.cell)
    $v = $cell.value
    # Excel's Value2 setter rejects a bare Decimal or Boolean variant marshalled
    # from PowerShell (a locale/type-library mismatch), so only two shapes ever
    # reach it: a string, or a double.
    if ($v -is [string]) { if ($v.StartsWith('=')) { $target.Formula = [string]$v } else { $target.Value2 = [string]$v } }
    elseif ($v -is [bool]) { $target.Value2 = [string]$v }
    else { $target.Value2 = [double]$v }
    $n++
  }
  foreach ($fmt in @(Prop $a 'formats' @())) {
    $rng = $sh.Range($fmt.range)
    if ($null -ne $fmt.PSObject.Properties['numberFormat']) { $rng.NumberFormat = [string]$fmt.numberFormat }
    if ((Prop $fmt 'bold' $false) -eq $true) { $rng.Font.Bold = $true }
    if ((Prop $fmt 'italic' $false) -eq $true) { $rng.Font.Italic = $true }
    if ($null -ne $fmt.PSObject.Properties['size']) { $rng.Font.Size = [double]$fmt.size }
    if ($null -ne $fmt.PSObject.Properties['fill']) { $rng.Interior.Color = [int]("0x" + ([string]$fmt.fill -replace '^#','')) }
    if ($null -ne $fmt.PSObject.Properties['fontColor']) { $rng.Font.Color = [int]("0x" + ([string]$fmt.fontColor -replace '^#','')) }
    $align = Prop $fmt 'align' $null
    if ($align -eq 'center') { $rng.HorizontalAlignment = -4108 } elseif ($align -eq 'right') { $rng.HorizontalAlignment = -4152 } elseif ($align -eq 'left') { $rng.HorizontalAlignment = -4131 }
    if ((Prop $fmt 'border' $false) -eq $true) { $rng.Borders.LineStyle = 1; $rng.Borders.Weight = 2 }
    if ((Prop $fmt 'autofit' $false) -eq $true) { [void]$rng.EntireColumn.AutoFit() }
  }
  foreach ($chart in @(Prop $a 'charts' @())) {
    $src = $sh.Range($chart.data)
    $co = $sh.ChartObjects().Add((Prop $chart 'left' 320), (Prop $chart 'top' 20), (Prop $chart 'width' 420), (Prop $chart 'height' 260))
    $type = Prop $chart 'type' 'column'
    $co.Chart.ChartType = if ($type -eq 'line') { 4 } elseif ($type -eq 'pie') { 5 } elseif ($type -eq 'bar') { 57 } else { 51 }
    $co.Chart.SetSourceData($src)
    if ($null -ne $chart.PSObject.Properties['title']) { $co.Chart.HasTitle = $true; $co.Chart.ChartTitle.Text = [string]$chart.title }
    $n++
  }
  $x.Visible = $true
  $saved = $null
  $saveAs = Prop $a 'saveAs' $null
  if ($saveAs) { $wb.SaveAs($saveAs); $saved = $wb.FullName }
  elseif ((Prop $a 'save' $false) -eq $true) { $wb.Save(); $saved = $wb.FullName }
  return @{ workbook = $wb.Name; sheet = $sh.Name; written = $n; saved = $saved }
}

# ---------------- Outlook ----------------
function Mailbox { $o = App 'Outlook.Application' $false; return $o.GetNamespace('MAPI') }
function Folder($ns, $name) {
  if (-not $name -or $name -eq 'inbox') { return $ns.GetDefaultFolder(6) }
  if ($name -eq 'sent') { return $ns.GetDefaultFolder(5) }
  if ($name -eq 'drafts') { return $ns.GetDefaultFolder(16) }
  foreach ($f in $ns.GetDefaultFolder(6).Parent.Folders) { if ($f.Name -eq $name) { return $f } }
  throw "No mail folder is named '$name'. Use inbox, sent, drafts, or a folder name from the mailbox."
}
function Op-OutlookMail($a) {
  $ns = Mailbox
  $folder = Folder $ns (Prop $a 'folder' 'inbox')
  $items = $folder.Items
  $items.Sort('[ReceivedTime]', $true)
  $search = Prop $a 'search' $null
  if ($search) {
    $q = $search.Replace("'", "''")
    $items = $items.Restrict("@SQL=(""urn:schemas:httpmail:subject"" LIKE '%$q%' OR ""urn:schemas:httpmail:fromname"" LIKE '%$q%' OR ""urn:schemas:httpmail:textdescription"" LIKE '%$q%')")
    $items.Sort('[ReceivedTime]', $true)
  }
  $limit = [int](Prop $a 'limit' 20)
  $out = @(); $i = 0
  foreach ($m in $items) {
    if ($i -ge $limit) { break }
    if ($m.Class -ne 43) { continue }
    $out += @{ id = $m.EntryID; subject = (Cap $m.Subject 200); from = (Cap $m.SenderName 100); received = $m.ReceivedTime.ToString('yyyy-MM-dd HH:mm'); unread = $m.UnRead; preview = (Cap ($m.Body -replace '\s+', ' ') 400) }
    $i++
  }
  return @{ folder = $folder.Name; count = $out.Count; mail = $out }
}
function Op-OutlookRead($a) {
  $ns = Mailbox
  $m = $ns.GetItemFromID($a.id)
  return @{ id = $m.EntryID; subject = $m.Subject; from = $m.SenderName; to = (Cap $m.To 500); received = $m.ReceivedTime.ToString('yyyy-MM-dd HH:mm'); body = (Cap $m.Body $TEXT_CAP) }
}
function Op-OutlookDraft($a) {
  $o = App 'Outlook.Application' $false
  $replyTo = Prop $a 'replyTo' $null
  if ($replyTo) {
    $source = $o.GetNamespace('MAPI').GetItemFromID($replyTo)
    if ((Prop $a 'replyAll' $false) -eq $true) { $m = $source.ReplyAll() } else { $m = $source.Reply() }
    $m.Body = $a.body + [Environment]::NewLine + [Environment]::NewLine + $m.Body
  } else {
    $m = $o.CreateItem(0)
    $m.To = (Prop $a 'to' ''); $m.CC = (Prop $a 'cc' ''); $m.Subject = (Prop $a 'subject' ''); $m.Body = $a.body
  }
  $m.Save()
  $m.Display()
  return @{ id = $m.EntryID; subject = $m.Subject; to = $m.To; opened = $true }
}
function Op-OutlookCalendar($a) {
  $ns = Mailbox
  $cal = $ns.GetDefaultFolder(9)
  $items = $cal.Items; $items.IncludeRecurrences = $true; $items.Sort('[Start]')
  $days = [int](Prop $a 'days' 7)
  $from = (Get-Date).Date; $to = $from.AddDays($days)
  $set = $items.Restrict("[Start] >= '" + $from.ToString('g') + "' AND [Start] < '" + $to.ToString('g') + "'")
  $out = @(); $i = 0
  foreach ($e in $set) { if ($i -ge 100) { break }; $out += @{ subject = (Cap $e.Subject 200); start = $e.Start.ToString('yyyy-MM-dd HH:mm'); end = $e.End.ToString('yyyy-MM-dd HH:mm'); location = (Cap $e.Location 120); organizer = (Cap $e.Organizer 100) }; $i++ }
  return @{ days = $days; count = $out.Count; events = $out }
}

${OFFICE_DOCUMENT_SCRIPT}

Send @{ type = 'ready'; protocol = 1 }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = $req.id
    $params = Prop $req 'args' @{}
    switch ($req.op) {
      'probe' { $result = Op-Probe }
      'excel.workbooks' { $result = Op-ExcelWorkbooks }
      'excel.read' { $result = Op-ExcelRead $params }
      'excel.write' { $result = Op-ExcelWrite $params }
      'outlook.mail' { $result = Op-OutlookMail $params }
      'outlook.read' { $result = Op-OutlookRead $params }
      'outlook.draft' { $result = Op-OutlookDraft $params }
      'outlook.calendar' { $result = Op-OutlookCalendar $params }
      'ppt.read' { $result = Op-PptRead $params }
      'ppt.edit' { $result = Op-PptEdit $params }
      'word.read' { $result = Op-WordRead $params }
      'word.edit' { $result = Op-WordEdit $params }
      default { throw "Unknown office operation '$($req.op)'." }
    }
    Send @{ id = $id; ok = $true; result = $result }
  } catch {
    Send @{ id = $id; ok = $false; error = (Cap ($_.Exception.Message -replace '\s+', ' ') 400) }
  }
}
`

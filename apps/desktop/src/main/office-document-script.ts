export const OFFICE_DOCUMENT_SCRIPT = String.raw`
$documentReads = @{}
function FileDigest($file) {
  $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)) } finally { $stream.Dispose(); $hash.Dispose() }
}
function DocumentPath($file, $kind) {
  $ext = if ($kind -eq 'word') { '.docx' } else { '.pptx' }
  if (-not [IO.Path]::IsPathRooted($file) -or [IO.Path]::GetExtension($file) -ne $ext) { throw 'Use an absolute document path with the supported extension.' }
  $item = Get-Item -LiteralPath $file
  if ($item.PSIsContainer -or $item.Length -gt 52428800) { throw 'Document must be a file no larger than 50 MB.' }
  return $item.FullName
}
function OpenDocument($app, $file, $kind) {
  $items = if ($kind -eq 'word') { $app.Documents } else { $app.Presentations }
  foreach ($item in $items) { if ($item.FullName -eq $file) { return $item } }
  $security = $app.AutomationSecurity
  try {
    $app.AutomationSecurity = 3
    if ($kind -eq 'word') { return $app.Documents.Open($file, $false, $false, $false) }
    return $app.Presentations.Open($file, $false, $false, $true)
  } finally { $app.AutomationSecurity = $security }
}
function NoteRange($slide) {
  foreach ($shape in $slide.NotesPage.Shapes) {
    if ($shape.Type -eq 14 -and $shape.PlaceholderFormat.Type -eq 2 -and $shape.HasTextFrame) { return ,$shape.TextFrame.TextRange }
  }
  return $null
}
function DocumentState($doc, $kind) {
  $items = @(); $size = 0
  if ($kind -eq 'word') {
    if ($doc.Content.End -gt 100000) { throw 'Main body exceeds the 100000-character read limit.' }
    return ,@([ordered]@{ key = 'body'; text = [string]$doc.Content.Text })
  }
  foreach ($slide in $doc.Slides) {
    $index = 0
    foreach ($shape in $slide.Shapes) {
      $index++
      if ($shape.HasTextFrame) {
        $text = [string]$shape.TextFrame.TextRange.Text; $size += $text.Length
        $items += [ordered]@{ key = "$($slide.SlideIndex):$index"; slide = $slide.SlideIndex; shape = $index; id = "$($slide.SlideID):$($shape.Id)"; text = $text }
      }
      if ($items.Count -gt 500 -or $size -gt 100000) { throw 'Presentation exceeds the 500-text-target or 100000-character read limit.' }
    }
    $note = NoteRange $slide
    if ($null -ne $note) { $text = [string]$note.Text; $size += $text.Length; $items += [ordered]@{ key = "$($slide.SlideIndex):note"; slide = $slide.SlideIndex; id = $slide.SlideID; text = $text } }
    if ($items.Count -gt 500 -or $size -gt 100000) { throw 'Presentation exceeds the supported read limit.' }
  }
  return ,$items
}
function DocumentFingerprint($state) { return ConvertTo-Json -InputObject $state -Depth 6 -Compress }
function ReadDocument($a, $kind) {
  $file = DocumentPath $a.file $kind
  $prog = if ($kind -eq 'word') { 'Word.Application' } else { 'PowerPoint.Application' }
  $app = App $prog $true
  if ($kind -eq 'word') { $app.Visible = $true }
  $doc = OpenDocument $app $file $kind
  $state = DocumentState $doc $kind
  $revision = [guid]::NewGuid().ToString('N')
  if ($documentReads.Count -ge 32) { $documentReads.Clear() }
  $documentReads[$revision] = @{ doc = $doc; app = $app; file = $file; kind = $kind; state = (DocumentFingerprint $state); disk = (FileDigest $file) }
  return @{ file = $file; revision = $revision; content = $state; scope = 'Word main body; PowerPoint ordinary text shapes and speaker notes. Other objects and visual layout are not verified.' }
}
function LiteralPositions([string]$text, [string]$find) {
  if (-not $find) { throw 'Empty replacement search is not allowed.' }
  $positions = @(); $start = 0
  while ($start -le $text.Length) {
    $at = $text.IndexOf($find, $start, [StringComparison]::Ordinal)
    if ($at -lt 0) { break }
    $positions += $at; $start = $at + $find.Length
    if ($positions.Count -gt 1000) { throw 'Replace at most 1000 occurrences per edit.' }
  }
  return ,$positions
}
function TargetRange($doc, $kind, $key) {
  if ($kind -eq 'word') { return ,$doc.Content }
  $parts = $key.Split(':'); $slide = $doc.Slides.Item([int]$parts[0])
  if ($parts[1] -eq 'note') { return NoteRange $slide }
  return ,$slide.Shapes.Item([int]$parts[1]).TextFrame.TextRange
}
function EditDocument($a, $kind) {
  $grant = $documentReads[[string]$a.revision]
  $documentReads.Remove([string]$a.revision)
  if ($null -eq $grant -or $grant.kind -ne $kind -or $grant.file -ne $a.file) { throw 'Read this document again before editing.' }
  $doc = $grant.doc; $file = $grant.file
  if ($doc.FullName -ne $file -or $doc.ReadOnly) { throw 'Observed document is no longer writable at that path.' }
  $state = DocumentState $doc $kind
  if ((DocumentFingerprint $state) -cne $grant.state -or (FileDigest $file) -ne $grant.disk) { throw 'Document changed since the read. Read it again before editing.' }
  $saveAs = Prop $a 'saveAs' $null; $save = (Prop $a 'save' $false) -eq $true
  $autoSave = $false
  try { $autoSave = $doc.AutoSaveOn } catch { $autoSave = $false }
  if ($autoSave -and -not $save) { throw 'This document has AutoSave enabled. Unsaved editing cannot be guaranteed; use a local copy or explicitly request saving the original.' }
  if ($saveAs) {
    if ($save -or $saveAs -eq $file -or (Test-Path -LiteralPath $saveAs) -or -not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($saveAs)) -PathType Container)) { throw 'Save-as requires a different, new file in an existing folder.' }
  }
  # Plan against supported text before changing any range. Later edits see earlier planned changes.
  $texts = @{}; foreach ($item in $state) { $texts[$item.key] = $item.text }
  $plan = @()
  foreach ($edit in $a.edits) {
    foreach ($field in @('find', 'with', 'text')) {
      if ($null -ne $edit.$field) { $edit.$field = ([string]$edit.$field).Replace(([string][char]13 + [char]10), [string][char]13).Replace([string][char]10, [string][char]13) }
    }
    if ($edit.kind -eq 'replace') {
      $matches = 0
      foreach ($key in @($texts.Keys)) {
        $before = [string]$texts[$key]; $positions = LiteralPositions $before ([string]$edit.find)
        if (-not $positions.Count) { continue }
        $after = $before.Replace([string]$edit.find, [string]$edit.with)
        $plan += @{ key = $key; before = $before; after = $after; positions = $positions; find = [string]$edit.find; text = [string]$edit.with; mode = 'replace' }
        $texts[$key] = $after; $matches += $positions.Count
      }
      if (-not $matches) { throw 'No literal, case-sensitive match found; no edits applied.' }
    } else {
      $key = if ($kind -eq 'word' -and $edit.kind -eq 'append') { 'body' } elseif ($kind -eq 'ppt' -and $edit.kind -eq 'note') { "$($edit.slide):note" } elseif ($kind -eq 'ppt' -and $edit.kind -eq 'text') { "$($edit.slide):$($edit.shape)" } else { throw 'Unsupported edit kind.' }
      if (-not $texts.ContainsKey($key)) { throw 'Target was not present in the document read; no edits applied.' }
      $before = [string]$texts[$key]; $text = [string]$edit.text
      $after = if ($kind -eq 'word') { $before.Substring(0, $before.Length - 1) + [char]13 + $text + [char]13 } else { $text }
      $plan += @{ key = $key; before = $before; after = $after; text = $text; mode = $edit.kind }
      $texts[$key] = $after
    }
  }
  $work = 0; foreach ($step in $plan) { $work += if ($step.mode -eq 'replace') { $step.positions.Count } else { 1 } }
  $size = 0; foreach ($text in $texts.Values) { $size += $text.Length }
  if ($work -gt 1000 -or $size -gt 100000) { throw 'Planned edit exceeds 1000 text changes or 100000 characters; no edits applied.' }
  $applied = 0; $saved = $null; $backup = $null
  try {
    foreach ($step in $plan) {
      $range = TargetRange $doc $kind $step.key
      if ([string]$range.Text -cne $step.before) { throw 'Text changed during editing. Read again before continuing.' }
      if ($step.mode -eq 'replace') {
        for ($i = $step.positions.Count - 1; $i -ge 0; $i--) {
          $at = [int]$step.positions[$i]
          $part = if ($kind -eq 'word') { ,$doc.Range($range.Start + $at, $range.Start + $at + $step.find.Length) } else { ,$range.Characters($at + 1, $step.find.Length) }
          $part.Text = $step.text; $applied++
        }
      } elseif ($step.mode -eq 'append') {
        $part = $doc.Range($doc.Content.End - 1, $doc.Content.End - 1)
        $part.InsertAfter([string][char]13 + $step.text); $applied++
      } else { $range.Text = $step.text; $applied++ }
      $check = TargetRange $doc $kind $step.key
      if ([string]$check.Text -cne $step.after) { throw 'Readback differs from requested text; inspect partial changes.' }
    }
    if ($save -or $saveAs) {
      if ((FileDigest $file) -ne $grant.disk) { throw 'Original changed on disk; changes remain unsaved.' }
      if ($saveAs) {
        if (Test-Path -LiteralPath $saveAs) { throw 'Save-as destination now exists; changes remain unsaved.' }
        # Keep native overwrite prompts enabled for a destination created during the save call.
        $alerts = $grant.app.DisplayAlerts
        try {
          $grant.app.DisplayAlerts = if ($kind -eq 'word') { -1 } else { 2 }
          if ($kind -eq 'word') { $destination = [string]$saveAs; $doc.SaveAs2([ref]$destination) } else { $doc.SaveAs([string]$saveAs) }
        } finally { $grant.app.DisplayAlerts = $alerts }
      } else {
        $backup = $file + '.' + [guid]::NewGuid().ToString('N') + '.bak'
        [IO.File]::Copy($file, $backup, $false)
        $doc.Save()
      }
      $saved = $doc.FullName
    }
    return @{ file = $doc.FullName; applied = $applied; saved = $saved; backup = $backup; verification = 'Edited text read back. Other objects and visual layout are not verified.' }
  } catch { throw "Edit stopped after $applied text changes; changes may be partial. Read again before retrying. $($_.Exception.Message) Backup: $backup" }
}
function Op-PptRead($a) { return ReadDocument $a 'ppt' }
function Op-PptEdit($a) { return EditDocument $a 'ppt' }
function Op-WordRead($a) { return ReadDocument $a 'word' }
function Op-WordEdit($a) { return EditDocument $a 'word' }
`

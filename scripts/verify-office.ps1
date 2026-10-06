<#
.SYNOPSIS
  Opens the six sample files in real Microsoft Word, Excel and PowerPoint (COM)
  and checks what each application reports back. Windows + Office only.

.DESCRIPTION
  Run `corepack pnpm test` first: packages/writer-opendocument/test/samples.test.ts
  writes .samples/sample.{docx,xlsx,pptx,odt,ods,odp}. A file Office cannot open,
  or opens only after repair, throws here and counts as a failure.
#>
$ErrorActionPreference = 'Stop'
$scriptStart = Get-Date
$samples = Join-Path $PSScriptRoot '..\.samples' | Resolve-Path
$failures = 0

function Check([string]$file, [string]$what, $actual, $expected) {
  if ("$actual" -eq "$expected") { Write-Host "  ok   $what = $actual" }
  else { Write-Host "  FAIL $what = '$actual' (expected '$expected')" -ForegroundColor Red; $script:failures++ }
}

# Merge area as "<top-left> <cols>x<rows>"; Range.Address(...) cannot be called with arguments from PowerShell.
function MergeSpan($r) { $m = $r.MergeArea; "$([char](64 + $m.Column))$($m.Row) $($m.Columns.Count)x$($m.Rows.Count)" }

function Release($o) { if ($o) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } }

# ---------- Word: .docx and .odt ----------
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  foreach ($ext in 'docx', 'odt') {
    $path = Join-Path $samples "sample.$ext"
    Write-Host "Word  sample.$ext"
    try {
      # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, ..., OpenAndRepair=$false
      $doc = $word.Documents.Open($path, $false, $true, $false, '', '', $false, '', '', 0, [Type]::Missing, $false, $false)
      $text = $doc.Content.Text
      Check $ext 'title text present' ($text.Contains('Annual Report 2026 & <Outlook>')) $true
      Check $ext 'body text present' ($text.Contains('across all regions.')) $true
      Check $ext 'tables' $doc.Tables.Count 1
      $t = $doc.Tables.Item(1)
      Check $ext 'table rows' $t.Rows.Count 3
      Check $ext 'merged header text' ($t.Cell(1, 1).Range.Text -replace '[\r\a]', '') 'Quarterly figures'
      Check $ext 'row-merged cell text' ($t.Cell(2, 1).Range.Text -replace '[\r\a]', '') '2026'
      Check $ext 'inline images' $doc.InlineShapes.Count 1
      $orient = @(); foreach ($s in $doc.Sections) { $orient += $s.PageSetup.Orientation }
      # wdOrientPortrait = 0, wdOrientLandscape = 1; Word derives it from the page size.
      Check $ext 'page orientations' ($orient -join ',') '0,1'
      $doc.Close($false); Release $doc
    } catch { Write-Host "  FAIL could not open: $($_.Exception.Message)" -ForegroundColor Red; $failures++ }
  }
} finally { $word.Quit(); Release $word }

# ---------- Excel: .xlsx and .ods ----------
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  foreach ($ext in 'xlsx', 'ods') {
    $path = Join-Path $samples "sample.$ext"
    Write-Host "Excel sample.$ext"
    try {
      $wb = $excel.Workbooks.Open($path, 0, $true)
      Check $ext 'sheets' $wb.Worksheets.Count 2
      $ws = $wb.Worksheets.Item(1)
      Check $ext 'A1 title' $ws.Range('A1').Text 'Annual Report 2026 & <Outlook>'
      Check $ext 'A15 merge' (MergeSpan $ws.Range('A15')) 'A15 3x1'
      Check $ext 'A16 merge' (MergeSpan $ws.Range('A16')) 'A16 1x2'
      Check $ext 'C16 is a number' ($ws.Range('C16').Value2 -is [double]) $true
      Check $ext 'C16 value' $ws.Range('C16').Value2 12
      Check $ext 'C17 keeps leading zeros' $ws.Range('C17').Text '007'
      Check $ext 'pictures on sheet 1' $ws.Shapes.Count 1
      $wb.Close($false); Release $ws; Release $wb
    } catch { Write-Host "  FAIL could not open: $($_.Exception.Message)" -ForegroundColor Red; $failures++ }
  }
} finally { $excel.Quit(); Release $excel }

# ---------- PowerPoint: .pptx and .odp ----------
$ppt = New-Object -ComObject PowerPoint.Application
try {
  foreach ($ext in 'pptx', 'odp') {
    $path = Join-Path $samples "sample.$ext"
    Write-Host "PowerPoint sample.$ext"
    try {
      # FileName, ReadOnly=msoTrue, Untitled=msoFalse, WithWindow=msoFalse
      $pres = $ppt.Presentations.Open($path, -1, 0, 0)
      Check $ext 'slides' $pres.Slides.Count 2
      Check $ext 'slide width (pt, 210 mm)' ([math]::Round($pres.PageSetup.SlideWidth)) 595
      $s1 = $pres.Slides.Item(1)
      $texts = @(); $tables = 0; $pictures = 0; $tbl = $null
      foreach ($sh in $s1.Shapes) {
        if ($sh.HasTable) { $tables++; $tbl = $sh.Table }
        elseif ($sh.Type -eq 13) { $pictures++ }  # msoPicture
        elseif ($sh.HasTextFrame) { $texts += $sh.TextFrame.TextRange.Text }
      }
      Check $ext 'title text present' (($texts -join '|').Contains('Annual Report 2026 & <Outlook>')) $true
      Check $ext 'tables on slide 1' $tables 1
      Check $ext 'pictures on slide 1' $pictures 1
      if ($tbl) {
        Check $ext 'table rows x cols' "$($tbl.Rows.Count)x$($tbl.Columns.Count)" '3x3'
        Check $ext 'merged header text' $tbl.Cell(1, 1).Shape.TextFrame.TextRange.Text 'Quarterly figures'
        Check $ext 'row-merged cell text' $tbl.Cell(2, 1).Shape.TextFrame.TextRange.Text '2026'
        Check $ext 'Q2 cell' $tbl.Cell(3, 2).Shape.TextFrame.TextRange.Text 'Q2'
      }
      $pres.Close(); Release $s1; Release $pres
    } catch { Write-Host "  FAIL could not open: $($_.Exception.Message)" -ForegroundColor Red; $failures++ }
  }
} finally { $ppt.Quit(); Release $ppt }

[GC]::Collect(); [GC]::WaitForPendingFinalizers()
# Office sometimes outlives Quit(). Close only the hidden instances this script started;
# a window means a person is using it, so those are never touched.
Start-Sleep -Seconds 2
Get-Process WINWORD, EXCEL, POWERPNT -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -eq 0 -and $_.StartTime -ge $scriptStart } |
  Stop-Process -Confirm:$false -ErrorAction SilentlyContinue
if ($failures -gt 0) { Write-Host "$failures check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host 'All Office checks passed' -ForegroundColor Green

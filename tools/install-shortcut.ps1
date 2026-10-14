$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ws = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($d in $places) {
  $lnk = $ws.CreateShortcut((Join-Path $d 'Hola.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $root 'Hola.vbs') + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = (Join-Path $root 'hola.ico') + ',0'
  $lnk.Description = 'Hola'
  $lnk.Save()
  Write-Host ('OK: ' + (Join-Path $d 'Hola.lnk'))
}

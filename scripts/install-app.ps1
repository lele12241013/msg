param(
  [string]$BuildPath = (Join-Path $PSScriptRoot '..\dist\PopupRemoto.exe'),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'PopupRemoto'),
  [string]$RemoteRawUrl = 'https://raw.githubusercontent.com/lele12241013/msg/main/relay/popup-command.json',
  [string]$DeviceKey = 'notebook-1',
  [int]$PollIntervalMs = 15000,
  [switch]$DisableRemote,
  [switch]$NoLaunch
)

$resolvedBuild = Resolve-Path $BuildPath -ErrorAction SilentlyContinue

if (-not $resolvedBuild) {
  Write-Error "Executavel nao encontrado em $BuildPath. Execute npm run build antes da instalacao."
  exit 1
}

$targetExe = Join-Path $InstallDir 'PopupRemoto.exe'
$startupFolder = [Environment]::GetFolderPath('Startup')
$desktopFolder = [Environment]::GetFolderPath('Desktop')
$startMenuFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Popup Remoto'

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $startMenuFolder -Force | Out-Null

Copy-Item $resolvedBuild.Path $targetExe -Force

$remoteConfigPath = Join-Path $InstallDir 'remote-config.json'
$remoteStatePath = Join-Path $InstallDir 'remote-state.json'

$safePollInterval = [Math]::Min([Math]::Max($PollIntervalMs, 5000), 300000)
$enableRemote = -not $DisableRemote

$remoteConfig = [ordered]@{
  enabled = $enableRemote
  rawUrl = $RemoteRawUrl
  deviceKey = $DeviceKey
  pollIntervalMs = $safePollInterval
}

$remoteState = [ordered]@{
  lastCommandId = ''
}

$remoteConfig | ConvertTo-Json | Set-Content -Path $remoteConfigPath -Encoding UTF8
$remoteState | ConvertTo-Json | Set-Content -Path $remoteStatePath -Encoding UTF8

$shell = New-Object -ComObject WScript.Shell

$startupShortcut = $shell.CreateShortcut((Join-Path $startupFolder 'Popup Remoto.lnk'))
$startupShortcut.TargetPath = $targetExe
$startupShortcut.Arguments = '--silent'
$startupShortcut.WorkingDirectory = $InstallDir
$startupShortcut.IconLocation = "$targetExe,0"
$startupShortcut.WindowStyle = 7
$startupShortcut.Save()

$desktopShortcut = $shell.CreateShortcut((Join-Path $desktopFolder 'Popup Remoto.lnk'))
$desktopShortcut.TargetPath = $targetExe
$desktopShortcut.WorkingDirectory = $InstallDir
$desktopShortcut.IconLocation = "$targetExe,0"
$desktopShortcut.Save()

$panelShortcut = $shell.CreateShortcut((Join-Path $startMenuFolder 'Abrir Painel Popup Remoto.lnk'))
$panelShortcut.TargetPath = $targetExe
$panelShortcut.WorkingDirectory = $InstallDir
$panelShortcut.IconLocation = "$targetExe,0"
$panelShortcut.Save()

$autostartShortcut = $shell.CreateShortcut((Join-Path $startMenuFolder 'Popup Remoto Inicializacao Automatica.lnk'))
$autostartShortcut.TargetPath = $targetExe
$autostartShortcut.Arguments = '--silent'
$autostartShortcut.WorkingDirectory = $InstallDir
$autostartShortcut.IconLocation = "$targetExe,0"
$autostartShortcut.Save()

$uninstallScript = @"
param()

`$startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Popup Remoto.lnk'
`$desktopShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Popup Remoto.lnk'
`$startMenuFolderPath = Join-Path `$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Popup Remoto'
`$installDirPath = Join-Path `$env:LOCALAPPDATA 'PopupRemoto'

Get-Process PopupRemoto -ErrorAction SilentlyContinue | Stop-Process -Force

Remove-Item `$startupShortcutPath -Force -ErrorAction SilentlyContinue
Remove-Item `$desktopShortcutPath -Force -ErrorAction SilentlyContinue
Remove-Item `$startMenuFolderPath -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item `$installDirPath -Recurse -Force -ErrorAction SilentlyContinue

Write-Host 'Popup Remoto removido.'
"@

$uninstallPath = Join-Path $InstallDir 'uninstall.ps1'
Set-Content -Path $uninstallPath -Value $uninstallScript -Encoding UTF8

$uninstallShortcut = $shell.CreateShortcut((Join-Path $startMenuFolder 'Desinstalar Popup Remoto.lnk'))
$uninstallShortcut.TargetPath = 'powershell.exe'
$uninstallShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$uninstallPath`""
$uninstallShortcut.WorkingDirectory = $InstallDir
$uninstallShortcut.Save()

Write-Host "Aplicativo instalado em $targetExe"
Write-Host 'Inicializacao automatica configurada para o proximo login do Windows.'
if ($enableRemote) {
  Write-Host "Modo remoto configurado para: $RemoteRawUrl"
  Write-Host "Device key: $DeviceKey | Intervalo: $safePollInterval ms"
} else {
  Write-Host 'Modo remoto desativado na instalacao (DisableRemote).'
}

if (-not $NoLaunch) {
  Start-Process -FilePath $targetExe
}
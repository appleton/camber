<# watch-shared-vsix.ps1 tracks a shared VSIX file and automatically reinstalls it in VS Code when it changes. #>

param(
    [string]$WatchPath   = "G:\Other computers\My Mac\Shared",          # folder that holds latest.vsix
    [string]$VsixName    = "latest.vsix",            # file to watch
    [string]$VsCodeCli   = "$env:USERPROFILE\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd",
    [int]   $PollSeconds = 4                         # how often to check (seconds)
)

$ExtensionId = "appleton.camber-assistant"

function Reinstall-CamberVsix {
    param([string]$VsixPath)

    # 1. Close every running VS Code instance (save work first!)
    Get-Process -Name Code -ErrorAction SilentlyContinue | Stop-Process -Force

    # 2. Uninstall previous version (ignore error if not installed)
    & $VsCodeCli --uninstall-extension $ExtensionId --force 2>$null

    # 3. Install the new VSIX package
    & $VsCodeCli --install-extension $VsixPath --force

    # 4. Restart VS Code (opens an empty window)
    Start-Process "code"

    $stamp = (Get-Date).ToString('HH:mm:ss')
    Write-Host "[$stamp] reinstalled $ExtensionId"
}

$file      = Join-Path $WatchPath $VsixName
$lastWrite = if (Test-Path $file) { (Get-Item $file).LastWriteTime } else { $null }

Write-Host "`n> Watching $file (poll every $PollSeconds s, Ctrl-C to stop)"

while ($true) {
    if (Test-Path $file) {
        $info = Get-Item $file
        if ($info.LastWriteTime -ne $lastWrite) {
            Start-Sleep 2 # let Drive finish syncing
            Reinstall-CamberVsix $file
            $lastWrite = $info.LastWriteTime
        }
    }
    Start-Sleep $PollSeconds
}

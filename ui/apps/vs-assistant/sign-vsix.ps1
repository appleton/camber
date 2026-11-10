# Sign the VSIX package using SSL.com eSigner CKA and OpenVsixSignTool
#
# Prerequisites:
#   1. Install SSL.com eSigner CKA from https://www.ssl.com/downloads/#cka
#   2. Disable "malware blocker" on the signing credential in SSL.com portal
#   3. Set SSLCOM_THUMBPRINT environment variable (or pass as argument)
#
# Usage:
#   .\sign-vsix.ps1 [thumbprint]

param(
    [string]$Thumbprint = $env:SSLCOM_THUMBPRINT
)

$ErrorActionPreference = "Stop"

$VsixFile = "bin\Release\net472\camber-assistant.vsix"
$TimestampServer = "http://ts.ssl.com/"

# Validate thumbprint
if (-not $Thumbprint) {
    Write-Host "Error: No certificate thumbprint provided." -ForegroundColor Red
    Write-Host ""
    Write-Host "Either pass the thumbprint as an argument:"
    Write-Host "  .\sign-vsix.ps1 YOUR_THUMBPRINT"
    Write-Host ""
    Write-Host "Or set the SSLCOM_THUMBPRINT environment variable:"
    Write-Host '  $env:SSLCOM_THUMBPRINT = "your_thumbprint"'
    exit 1
}

# Remove spaces from thumbprint (common copy-paste issue)
$Thumbprint = $Thumbprint -replace '\s', ''

# Check if VSIX file exists
if (-not (Test-Path $VsixFile)) {
    Write-Host "Error: VSIX file not found: $VsixFile" -ForegroundColor Red
    Write-Host ""
    Write-Host "Make sure you have built the extension in Release configuration first."
    exit 1
}

# Check if OpenVsixSignTool is installed
if (-not (Get-Command OpenVsixSignTool -ErrorAction SilentlyContinue)) {
    Write-Host "OpenVsixSignTool not found. Installing..."
    dotnet tool install -g OpenVsixSignTool
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install OpenVsixSignTool." -ForegroundColor Red
        Write-Host "Please install it manually: dotnet tool install -g OpenVsixSignTool"
        exit 1
    }
}

Write-Host ""
Write-Host "Signing VSIX..." -ForegroundColor Cyan
Write-Host "File: $VsixFile"
Write-Host "Thumbprint: $Thumbprint"
Write-Host "Timestamp server: $TimestampServer"
Write-Host ""

& OpenVsixSignTool sign --sha1 $Thumbprint --timestamp $TimestampServer -ta sha256 -fd sha256 -f $VsixFile

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Signing failed with error code $LASTEXITCODE." -ForegroundColor Red
    Write-Host ""
    Write-Host "If you see 'No certificates were found that met all the given criteria':"
    Write-Host "  - Verify eSigner CKA is installed and running"
    Write-Host "  - Check that your thumbprint is correct"
    Write-Host "  - Ensure the certificate is in your Personal certificate store"
    Write-Host ""
    Write-Host "If signing requires OTP authentication:"
    Write-Host "  - eSigner CKA may be in manual mode"
    Write-Host "  - Enter the OTP from your authenticator app when prompted"
    Write-Host "  - Or reconfigure eSigner CKA for automated signing mode"
    Write-Host ""
    Write-Host "If you see 'hash needs to be scanned first':"
    Write-Host "  - Ensure 'malware blocker' is disabled on the SSL.com signing credential"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Signing completed successfully!" -ForegroundColor Green

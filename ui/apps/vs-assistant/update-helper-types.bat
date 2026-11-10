@echo off
setlocal

start "" /B "helper\camber-helper.exe" openapi
for /f "tokens=2 delims=," %%A in ('tasklist /FI "IMAGENAME eq camber-helper.exe" /FO CSV ^| findstr /I "camber-helper.exe"') do set SERVER_PID=%%A
timeout /t 2 /nobreak >nul

dotnet tool install --global NSwag.ConsoleCore
nswag openapi2csclient /input:http://localhost:8080/openapi.yaml /output:HelperLSP/Messages.cs /Namespace:Camber.Assistant.HelperLSP /GenerateClientInterfaces:false /GenerateClientClasses:false /GenerateDtoTypes:true /GenerateNullableReferenceTypes:false /GenerateOptionalPropertiesAsNullable:true

if defined SERVER_PID (
    taskkill /PID %SERVER_PID% /F
    echo Helper process with PID %SERVER_PID% terminated.
) else (
    echo Helper process PID not found. Manual shutdown may be needed.
)

exit /b

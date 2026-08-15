$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
Write-Output "Startup folder: $startup"
$testFile = Join-Path $startup 'gca-test.txt'
try {
  Set-Content -Path $testFile -Value 'test' -ErrorAction Stop
  Write-Output "WRITE_OK"
  Remove-Item $testFile -Force
  Write-Output "CLEANUP_OK"
} catch {
  Write-Output "WRITE_FAIL: $($_.Exception.Message)"
}

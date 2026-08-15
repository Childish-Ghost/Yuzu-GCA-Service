Add-Type -AssemblyName System.Windows.Forms
$clip = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($null -eq $clip) { Write-Output "clipboard empty"; exit }
Write-Output ("Formats: " + ($clip.GetFormats() -join ", "))
Write-Output ("ContainsImage: " + [System.Windows.Forms.Clipboard]::ContainsImage())
foreach ($fmt in $clip.GetFormats()) {
    Write-Output ("  $fmt present: " + $clip.GetDataPresent($fmt))
}

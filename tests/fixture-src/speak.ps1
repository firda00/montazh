# Synthesizes each spoken part of a fixture into its own 16 kHz WAV with Windows SAPI and
# records the start time of every word (SpeakProgress.AudioPosition). One file per part
# because AudioPosition restarts at every voice change.
# Input: UTF-8 JSON { parts: [{ voice, text } | { pause_ms }] }
# Output: <OutDir>/part_<i>.wav + <OutDir>/parts.json [{ index, file, words: [{ w, start }] }]
param([string]$In, [string]$OutDir)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$spec = Get-Content -Raw -Encoding UTF8 $In | ConvertFrom-Json
New-Item -ItemType Directory -Force $OutDir | Out-Null
# Desktop voices are 16 kHz native; writing in that format keeps AudioPosition on the file's own clock.
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

$parts = New-Object System.Collections.ArrayList
$i = 0
foreach ($p in $spec.parts) {
  if ($p.pause_ms) { $i++; continue }
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($p.voice)
  $words = New-Object System.Collections.ArrayList
  Register-ObjectEvent -InputObject $synth -EventName SpeakProgress -SourceIdentifier "progress$i" | Out-Null
  $file = Join-Path $OutDir ("part_{0}.wav" -f $i)
  $synth.SetOutputToWaveFile($file, $fmt)
  $synth.Speak($p.text)
  $synth.SetOutputToNull()
  foreach ($e in Get-Event -SourceIdentifier "progress$i") {
    $a = $e.SourceEventArgs
    [void]$words.Add([ordered]@{ w = $a.Text; start = [math]::Round($a.AudioPosition.TotalSeconds, 3) })
  }
  Unregister-Event -SourceIdentifier "progress$i"
  $synth.Dispose()
  [void]$parts.Add([ordered]@{ index = $i; file = $file; words = @($words) })
  $i++
}
[System.IO.File]::WriteAllText((Join-Path $OutDir "parts.json"), (ConvertTo-Json -InputObject @($parts) -Depth 4), (New-Object System.Text.UTF8Encoding $false))

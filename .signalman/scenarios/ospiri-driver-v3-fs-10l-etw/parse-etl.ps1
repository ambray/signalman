$ErrorActionPreference = 'Continue'

$etl = 'C:\Ospiri\logs\ospiri-etw-capture.etl'
$xml = 'C:\Ospiri\logs\ospiri-etw-capture.xml'
$sum = 'C:\Ospiri\logs\ospiri-etw-capture-summary.txt'

# Verify the ETL file was written before trying to decode it.
if (-not (Test-Path $etl)) {
    Write-Output "ETL_MISSING: $etl does not exist - no ETW data was captured."
    exit 1
}
$etlSizeKB = [int]((Get-Item $etl).Length / 1024)
Write-Output "ETL_EXISTS: $etl ($etlSizeKB KB)"

# Clean prior run outputs.
if (Test-Path $xml) { Remove-Item -Force $xml }
if (Test-Path $sum) { Remove-Item -Force $sum }

# tracerpt.exe batch-decodes ETL to XML in one pass. Use the full
# path — when running as SYSTEM via the guest agent, %SystemRoot%\system32
# may not be in PATH (cmd.exe inherits a minimal environment).
$tracerpt = 'C:\Windows\System32\tracerpt.exe'
if (-not (Test-Path $tracerpt)) {
    Write-Output "TRACERPT_MISSING: $tracerpt not found."
    exit 1
}

try {
    $tr = & $tracerpt $etl -o $xml -of XML -y -summary $sum 2>&1
    $trExit = $LASTEXITCODE
} catch {
    Write-Output "TRACERPT_EXCEPTION: $($_.Exception.Message)"
    $trExit = -1
    $tr = ''
}

# Only print a subset of the XML (the Ospiri provider events are
# specific enough that we can grep them out). Too much XML blows the
# stdout buffer.
if (Test-Path $xml) {
    $xmlContent = Get-Content $xml -Raw
    # Filter to events from our provider. Each <Event> ... </Event> block.
    $matches = [regex]::Matches($xmlContent, '<Event[^>]*xmlns="http://schemas\.microsoft\.com/win/2004/08/events/event">[\s\S]*?</Event>')
    $ospiri = $matches | Where-Object {
        # Our provider GUID. tracerpt XML emits uppercase GUID with braces
        # in double-quoted XML attributes, e.g.:
        #   <Provider Guid="{5B7E6A1C-9F42-4D8B-A8B9-3E5C2D7F4A10}"
        # Use case-insensitive regex to match both forms.
        [regex]::IsMatch(
            $_.Value,
            '5b7e6a1c-9f42-4d8b-a8b9-3e5c2d7f4a10',
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
    }

    # Output one event per line for readability, compressed.
    Write-Output "=== Found $($ospiri.Count) Ospiri.Driver events ==="
    $i = 0
    foreach ($m in $ospiri) {
        # Extract key fields: TimeCreated, Task, Keywords, EventData block.
        $v = $m.Value
        # tracerpt uses double-quoted XML attributes and ISO timestamps.
        $time = if ($v -match 'SystemTime="([^"]+)"') { $Matches[1] } else { '' }
        $task = if ($v -match '<Task>([^<]+)</Task>') { $Matches[1] } else { '' }
        $keywords = if ($v -match '<Keywords>([^<]+)</Keywords>') { $Matches[1] } else { '' }
        $eventName = if ($v -match 'Name="([^"]+)"') { $Matches[1] } else { '' }
        $eventData = if ($v -match '<EventData>([\s\S]*?)</EventData>') { $Matches[1] -replace "\s+", ' ' } else { '' }
        Write-Output ("#{0,-3} {1} task={2} kw={3} name={4} data={5}" -f $i, $time, $task, $keywords, $eventName, $eventData)
        $i++
    }
} else {
    Write-Output "TRACERPT_FAILED: exit=$trExit out=$tr"
}

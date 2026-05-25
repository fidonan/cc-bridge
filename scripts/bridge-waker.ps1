Add-Type -AssemblyName System.Windows.Forms

$script:WindowTitles = @{
    'A' = 'Claude-A'
    'B' = 'Codex-B'
    'C' = 'Mimo-C'
}

function Wake-Target {
    param([string]$target)

    if (-not $script:WindowTitles.ContainsKey($target)) {
        return
    }

    $title = $script:WindowTitles[$target]
    $wshell = New-Object -ComObject WScript.Shell
    $found = $wshell.AppActivate($title)

    if (-not $found) {
        Write-Output "[MISS] window '$title' not found"
        return
    }

    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("WAKE - Check get_messages now.")
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Write-Output "[OK] Waked $target at $(Get-Date -Format 'HH:mm:ss')"
}

function Parse-Targets {
    param([string]$messageText)

    if ([string]::IsNullOrEmpty($messageText)) {
        return @()
    }

    $matches = [regex]::Matches($messageText, '\[TO:(A|B|C|ALL)\]')
    $targets = @()

    foreach ($m in $matches) {
        $val = $m.Groups[1].Value
        if ($val -eq 'ALL') {
            $targets += @('A', 'B', 'C')
        } else {
            $targets += $val
        }
    }

    $targets | Select-Object -Unique
}

function Invoke-WakerCheck {
    param([string]$messagesText)

    $targets = Parse-Targets -messageText $messagesText

    if ($targets.Count -eq 0) {
        return
    }

    foreach ($t in $targets) {
        Wake-Target -target $t
    }
}

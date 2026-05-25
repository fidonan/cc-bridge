param(
    [Parameter(Mandatory=$true)]
    [string]$MessagesText
)

. "$PSScriptRoot\bridge-waker.ps1"
Invoke-WakerCheck -messagesText $MessagesText

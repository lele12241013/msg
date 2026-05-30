param(
  [Parameter(Mandatory = $true)]
  [string]$Message,

  [int]$DurationMs = 5000
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$safeDuration = [Math]::Min([Math]::Max($DurationMs, 1500), 30000)
$screenArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$form = New-Object System.Windows.Forms.Form
$form.Width = 360
$form.Height = 150
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(($screenArea.Right - $form.Width - 24), ($screenArea.Top + 24))
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#FFF5EB')

$panel = New-Object System.Windows.Forms.Panel
$panel.Dock = 'Fill'
$panel.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#FFD6A5')
$panel.Padding = New-Object System.Windows.Forms.Padding(18)

$title = New-Object System.Windows.Forms.Label
$title.AutoSize = $true
$title.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#264653')
$title.Text = 'Mensagem remota'
$title.Location = New-Object System.Drawing.Point(20, 18)

$body = New-Object System.Windows.Forms.Label
$body.MaximumSize = New-Object System.Drawing.Size(320, 0)
$body.AutoSize = $true
$body.Font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
$body.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#172121')
$body.Text = $Message
$body.Location = New-Object System.Drawing.Point(20, 48)

$panel.Controls.Add($title)
$panel.Controls.Add($body)
$form.Controls.Add($panel)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $safeDuration
$timer.Add_Tick({
  $timer.Stop()
  $form.Close()
})

$form.Add_Shown({
  $timer.Start()
})

[void]$form.ShowDialog()
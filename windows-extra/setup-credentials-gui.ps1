<#
.SYNOPSIS
  Optional Windows front-end: a dialog that hands the input to the portable tool.

.DESCRIPTION
  This is a convenience shim, not a second implementation. It collects the
  account and the authorization code in a dialog and pipes them to
  bin\setup-credentials.mjs, which owns validation, storage, and the login
  check. Keeping one implementation is what lets the tool run on macOS and
  Linux unchanged.

  Not part of the portable bundle: bin\setup-credentials.mjs alone works on
  every platform, including this one.

.EXAMPLE
  powershell -File windows-extra\setup-credentials-gui.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Encode the pipe as UTF-8 without a BOM, or the first line gains one.
$OutputEncoding = New-Object Text.UTF8Encoding($false)

$cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'bin\setup-credentials.mjs'
if (-not (Test-Path $cli)) { throw "找不到 $cli" }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'USTC 邮箱凭据'
$form.ClientSize = New-Object System.Drawing.Size(430, 220)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = 'CenterScreen'

$title = New-Object System.Windows.Forms.Label
$title.Text = '凭据由 bin\setup-credentials.mjs 保存，本窗口只负责收集。'
$title.Location = New-Object System.Drawing.Point(18, 14)
$title.Size = New-Object System.Drawing.Size(394, 20)
$form.Controls.Add($title)

$userLabel = New-Object System.Windows.Forms.Label
$userLabel.Text = '邮箱账号'
$userLabel.Location = New-Object System.Drawing.Point(18, 48)
$userLabel.Size = New-Object System.Drawing.Size(80, 20)
$form.Controls.Add($userLabel)

$userBox = New-Object System.Windows.Forms.TextBox
$userBox.Location = New-Object System.Drawing.Point(104, 45)
$userBox.Size = New-Object System.Drawing.Size(308, 24)
$userBox.Text = $env:USTC_MAIL_USER
$form.Controls.Add($userBox)

$passLabel = New-Object System.Windows.Forms.Label
$passLabel.Text = '授权码'
$passLabel.Location = New-Object System.Drawing.Point(18, 84)
$passLabel.Size = New-Object System.Drawing.Size(80, 20)
$form.Controls.Add($passLabel)

$passBox = New-Object System.Windows.Forms.TextBox
$passBox.Location = New-Object System.Drawing.Point(104, 81)
$passBox.Size = New-Object System.Drawing.Size(308, 24)
$passBox.UseSystemPasswordChar = $true
$form.Controls.Add($passBox)

$showBox = New-Object System.Windows.Forms.CheckBox
$showBox.Text = '显示授权码'
$showBox.Location = New-Object System.Drawing.Point(104, 110)
$showBox.Size = New-Object System.Drawing.Size(140, 22)
$showBox.Add_CheckedChanged({ $passBox.UseSystemPasswordChar = -not $showBox.Checked })
$form.Controls.Add($showBox)

$note = New-Object System.Windows.Forms.Label
$note.Text = '在邮箱设置的「客户端授权码」里生成。保存后会验证一次登录。'
$note.Location = New-Object System.Drawing.Point(18, 140)
$note.Size = New-Object System.Drawing.Size(394, 20)
$note.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($note)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = '保存'
$ok.Location = New-Object System.Drawing.Point(252, 172)
$ok.Size = New-Object System.Drawing.Size(78, 28)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($ok)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'
$cancel.Location = New-Object System.Drawing.Point(336, 172)
$cancel.Size = New-Object System.Drawing.Size(78, 28)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)

$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Add_Shown({ $userBox.Focus() })

$result = $form.ShowDialog()
$enteredUser = $userBox.Text.Trim()
$enteredPassword = $passBox.Text
$form.Dispose()

if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
  Write-Host '已取消，没有写入任何内容。'
  exit 1
}

Write-Host ''
"$enteredUser`n$enteredPassword" | & node $cli --user $enteredUser --secret-stdin
exit $LASTEXITCODE

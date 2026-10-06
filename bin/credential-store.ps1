<#
.SYNOPSIS
  Read, write, or delete the USTC mailbox credential in Windows Credential Manager.

.DESCRIPTION
  A generic credential named by -Target holds the account name and the
  authorization code. Windows stores the secret itself; this script only wraps
  the CredRead/CredWrite/CredDelete calls.

  Machine-facing helper: keep this file ASCII-only so Windows PowerShell 5.1,
  which reads .ps1 files as ANSI without a BOM, can always parse it.

.PARAMETER Action
  read   - print {"user":..,"password":..} on stdout, exit 1 when absent
  write  - store -User plus the secret read from stdin
  delete - remove the credential; succeeds when it was already absent
  exists - exit 0 when present, 1 when absent

.PARAMETER Target
  The credential's target name.

.PARAMETER User
  The account name, for -Action write.

.EXAMPLE
  'secret' | powershell -File bin\credential-store.ps1 -Action write -User me@mail.ustc.edu.cn
.EXAMPLE
  powershell -File bin\credential-store.ps1 -Action read
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('read', 'write', 'delete', 'exists')]
  [string]$Action,

  [string]$Target = 'USTC-Mail',

  [string]$User = ''
)

$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class UstcCredentialStore {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  private const uint GENERIC = 1;
  private const uint PERSIST_LOCAL_MACHINE = 2;
  private const int ERROR_NOT_FOUND = 1168;

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr buffer);

  public static bool Exists(string target) {
    IntPtr pointer;
    if (!CredRead(target, GENERIC, 0, out pointer)) return false;
    CredFree(pointer);
    return true;
  }

  public static string Write(string target, string user, string secret) {
    byte[] blob = Encoding.UTF8.GetBytes(secret);
    CREDENTIAL credential = new CREDENTIAL();
    credential.Type = GENERIC;
    credential.TargetName = target;
    credential.UserName = user;
    credential.Persist = PERSIST_LOCAL_MACHINE;
    credential.CredentialBlobSize = (uint)blob.Length;
    credential.CredentialBlob = Marshal.AllocCoTaskMem(blob.Length);
    try {
      Marshal.Copy(blob, 0, credential.CredentialBlob, blob.Length);
      if (!CredWrite(ref credential, 0)) return "CredWrite failed with Win32 error " + Marshal.GetLastWin32Error();
      return null;
    } finally {
      Marshal.FreeCoTaskMem(credential.CredentialBlob);
    }
  }

  public static string ReadUser(string target) {
    return Read(target).Split(new char[] { '\n' }, 2)[0];
  }

  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, GENERIC, 0, out pointer)) {
      int code = Marshal.GetLastWin32Error();
      if (code == ERROR_NOT_FOUND) return null;
      throw new InvalidOperationException("CredRead failed with Win32 error " + code);
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] blob = new byte[credential.CredentialBlobSize];
      if (credential.CredentialBlobSize > 0) {
        Marshal.Copy(credential.CredentialBlob, blob, 0, (int)credential.CredentialBlobSize);
      }
      return credential.UserName + "\n" + Encoding.UTF8.GetString(blob);
    } finally {
      CredFree(pointer);
    }
  }

  public static bool Delete(string target) {
    if (CredDelete(target, GENERIC, 0)) return true;
    return Marshal.GetLastWin32Error() == ERROR_NOT_FOUND;
  }
}
'@

Add-Type -TypeDefinition $nativeSource -Language CSharp | Out-Null

switch ($Action) {
  'exists' {
    if ([UstcCredentialStore]::Exists($Target)) { exit 0 } else { exit 1 }
  }
  'delete' {
    if ([UstcCredentialStore]::Delete($Target)) {
      Write-Output 'deleted'
      exit 0
    }
    Write-Error "Could not delete the credential '$Target'."
    exit 1
  }
  'read' {
    $value = [UstcCredentialStore]::Read($Target)
    if ($null -eq $value) { exit 1 }
    $parts = $value -split "`n", 2
    $payload = [pscustomobject]@{ user = $parts[0]; password = $parts[1] } | ConvertTo-Json -Compress
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    [Console]::Out.Write($payload)
    exit 0
  }
  'write' {
    [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
    $secret = [Console]::In.ReadToEnd()
    if ($null -eq $secret) { $secret = '' }
    # A PowerShell pipeline can hand a native command UTF-8 with a BOM; the BOM
    # would become part of the stored secret and break the login.
    $secret = $secret.TrimStart([char]0xFEFF).TrimEnd("`r", "`n")
    $User = $User.TrimStart([char]0xFEFF)
    if ($secret.Length -eq 0) {
      Write-Error 'No secret arrived on stdin.'
      exit 1
    }
    $problem = [UstcCredentialStore]::Write($Target, $User, $secret)
    if ($null -ne $problem) {
      Write-Error $problem
      exit 1
    }
    Write-Output 'stored'
    exit 0
  }
}

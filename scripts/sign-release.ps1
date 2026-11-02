<#
.SYNOPSIS
  Makes a release tag signed with the OK Studio EV certificate on the SafeNet eToken, then
  verifies it the way an install will.

.EXAMPLE
  pwsh -File scripts\sign-release.ps1 -Version 2.3.0 -NotesFile notes.txt
  pwsh -File scripts\sign-release.ps1 -Version 2.3.0 -NotesFile notes.txt -Commit 1a2b3c4

.NOTES
  The design is docs/releases.md ("Signing with the certificate"). The tag object is built here
  from the commit, the tag name, your git identity, and the notes file, and signed as a detached
  CMS SignedData over exactly those bytes with .NET SignedCms, the block git writes for
  `gpg.format x509`. The certificate is found by thumbprint in your user certificate store; its
  private key is on the eToken, which asks for its PIN once per session. Nothing here reads a PIN
  or a passphrase from an argument, a file, or the environment.

  Run from a normal (non-elevated) PowerShell 7: the eToken is not visible to elevated processes.
  The tag is written to this repository only; pushing it is a separate step the script prints.
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory)][string]$NotesFile,
  [string]$Commit = 'HEAD',
  [string]$Thumbprint = 'FC22B5221318F3F3F6B3EB2D969D7F99091557BF'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security.Cryptography.Pkcs

$repoRoot = (git rev-parse --show-toplevel).Trim()
$tag = "v$Version"

if (git tag --list $tag) { throw "$tag already exists. Delete it first if it is wrong: git tag -d $tag" }
$commitSha = (git rev-parse --verify "$Commit^{commit}").Trim()
if ($LASTEXITCODE -ne 0) { throw "$Commit is not a commit" }

# The notes become the tag message: LF line ends, no trailing blank lines, one final newline.
# A line that opens a signature block would make the tag carry two, which installs refuse.
$notes = [System.IO.File]::ReadAllText((Resolve-Path $NotesFile)) -replace "`r`n", "`n"
$notes = $notes.TrimEnd() + "`n"
if ($notes.Trim().Length -eq 0) { throw "$NotesFile is empty; the notes are the release notes installs show" }
if ($notes -match '(?m)^-----BEGIN ') { throw "$NotesFile has a line that opens a signature block" }

$tagger = (git var GIT_COMMITTER_IDENT).Trim()
$payload = "object $commitSha`ntype commit`ntag $tag`ntagger $tagger`n`n$notes"
$utf8 = [System.Text.UTF8Encoding]::new($false)
$payloadBytes = $utf8.GetBytes($payload)

$cert = Get-Item "Cert:\CurrentUser\My\$Thumbprint"
if (-not $cert.HasPrivateKey) { throw "the certificate $Thumbprint has no private key here: is the eToken plugged in?" }
if ($cert.NotAfter -lt (Get-Date)) { Write-Warning "the certificate expired $($cert.NotAfter.ToString('yyyy-MM-dd')); installs pin its key, not its dates, so the signature still verifies" }
Write-Host "Signing $tag at $($commitSha.Substring(0, 7)) as $($cert.Subject.Split(',')[0]) (the eToken may ask for its PIN)"

$signer = [System.Security.Cryptography.Pkcs.CmsSigner]::new($cert)
$signer.DigestAlgorithm = [System.Security.Cryptography.Oid]::new('2.16.840.1.101.3.4.2.1')  # SHA-256
$signer.IncludeOption = [System.Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
[void]$signer.SignedAttributes.Add([System.Security.Cryptography.Pkcs.Pkcs9SigningTime]::new())
$cms = [System.Security.Cryptography.Pkcs.SignedCms]::new([System.Security.Cryptography.Pkcs.ContentInfo]::new($payloadBytes), $true)
$cms.ComputeSignature($signer, $false)
$der = $cms.Encode()

$b64 = [Convert]::ToBase64String($der)
$lines = for ($i = 0; $i -lt $b64.Length; $i += 64) { $b64.Substring($i, [Math]::Min(64, $b64.Length - $i)) }
$block = "-----BEGIN SIGNED MESSAGE-----`n" + ($lines -join "`n") + "`n-----END SIGNED MESSAGE-----`n"

$objectFile = Join-Path ([System.IO.Path]::GetTempPath()) "polaris-$tag-$([System.IO.Path]::GetRandomFileName()).tag"
try {
  [System.IO.File]::WriteAllBytes($objectFile, $payloadBytes + $utf8.GetBytes($block))
  $tagSha = (git hash-object -t tag -w -- $objectFile).Trim()
  if ($LASTEXITCODE -ne 0 -or $tagSha.Length -ne 40) { throw 'git hash-object did not store the tag object' }
} finally {
  Remove-Item -Force $objectFile -ErrorAction SilentlyContinue
}
git update-ref "refs/tags/$tag" $tagSha
if ($LASTEXITCODE -ne 0) { throw "git update-ref refs/tags/$tag failed" }

# The same check an install makes, against the committed release-signers. A tag that fails it is
# removed again: an install would skip it, and a pushed tag cannot be unpushed from every clone.
# The removal is in a finally so it runs however the check fails: a nonzero exit, node missing, or
# a profile with $PSNativeCommandUseErrorActionPreference on, which turns that exit into a throw.
$verified = $false
try {
  $PSNativeCommandUseErrorActionPreference = $false
  node (Join-Path $repoRoot 'scripts\verify-release-tag.mjs') $tag
  $verified = $LASTEXITCODE -eq 0
} finally {
  if (-not $verified) { git update-ref -d "refs/tags/$tag" }
}
if (-not $verified) { throw "$tag was removed: it would not verify on an install" }
Write-Host "Made $tag ($tagSha). Push it with: git push origin $tag"

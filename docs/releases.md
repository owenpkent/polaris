# Releases

A release is a tag `vX.Y.Z` on `main`, signed by the owner: with the SSH release key, or with the EV code-signing certificate on the eToken (an X.509 signature, below under "Signing with the certificate"). `cc update --release` on an install fetches the tags, takes the newest one strictly newer than the version it runs, verifies the signature against the keys that install has pinned, and installs it (the design is docs/update-proposal.md, section 2; the command is described under Updating in command-center/README.md). Nothing marks a commit as "meant to run" except this signature, so the keys and this checklist are what stand between a push to `main` and every install.

A tag verifies when it carries exactly one signature block, SSH or X.509, from a key in the pinned file, and the tag object is named for the tag. An SSH signature is checked with `git verify-tag` against the pinned file alone; an X.509 one by the updater's own verifier (command-center/src/update/cms.ts) against the RSA keys in that same file, with no certificate chain, trust store, or expiry date: the pin is the key, so a renewed or expired certificate changes nothing until its new key is pinned. The line's options still bind the key: an RSA line counts as an X.509 pin only with no options or a `namespaces` list that names `git`, and a line with `cert-authority`, `valid-after`, `valid-before`, or any other option is no X.509 pin at all, so switching envelope never lets a key sign what the SSH path would refuse. OpenPGP, no signature, and two blocks are refused before git is asked.

## One-time key setup

Done once, by the owner, on the machine releases are made from. No installer does this.

```sh
ssh-keygen -t ed25519 -f ~/.ssh/polaris-release -C polaris-release
git config gpg.format ssh
git config user.signingkey ~/.ssh/polaris-release.pub
```

Give the key a passphrase. The private key stays on that machine; it is never committed and never copied to an install.

Then allow the key to sign releases: add one line to `release-signers` at the repo root, in OpenSSH allowed_signers format, built from the public key file.

```sh
printf 'polaris-release namespaces="git" %s\n' "$(cut -d' ' -f1,2 ~/.ssh/polaris-release.pub)" >> release-signers
git add release-signers
git commit -m "chore(release): allow the release key"
```

The file carries comments that repeat the format. `namespaces="git"` is required: git signs tags in the `git` namespace and `git verify-tag` accepts nothing else. Installs read the tag object and skip a tag signed with OpenPGP, or carrying more than one signature, whatever keys their git could find.

## Signing with the certificate

The OK Studio EV code-signing certificate lives on the SafeNet eToken, which asks for its PIN once per session, so a release signed with it needs no typed passphrase. Its RSA public key is in `release-signers` as an `ssh-rsa` line (the output of `ssh-keygen -i -m PKCS8 -f pubkey.pem`), which is the same key in the form ssh-keygen reads, so one file pins both kinds of signature and `--trust-signers` shows it like any other key.

With the token plugged in, from a normal (not elevated) PowerShell 7, the notes in a file:

```powershell
pwsh -File scripts\sign-release.ps1 -Version 2.3.0 -NotesFile notes.txt
```

The script builds the tag object from `HEAD` (or `-Commit`), your git identity, and the notes, signs those bytes on the token as a detached CMS SignedData (the block git writes for `gpg.format x509`), stores the tag, and then verifies it the way an install will, with `scripts/verify-release-tag.mjs`, removing the tag if that fails. It prints the push command. The certificate's expiry does not matter to installs, and the script says so when it has passed; renewing the certificate with a new key is a key rotation (below).

Either signing path can be checked before the push:

```sh
node scripts/verify-release-tag.mjs v2.3.0
```

Check that the setup signs and verifies before the first release:

```sh
git tag -s test-signing -m "test"
git -c gpg.ssh.allowedSignersFile=release-signers verify-tag test-signing
git tag -d test-signing
```

## Release checklist

Releases are batched: one is cut when there is something worth installing, not for every merged pull request, because each needs the owner's signature.

1. CI is green on the commit on `main` that becomes the release.
2. The Tests run for that push to `main` passed, all twelve UI test parts included (`gh run list --workflow test.yml --branch main`). That run tests the commit as merged, so no local `npm run test:ui` is needed.
3. The version is bumped in `package.json`, `command-center/package.json`, and `mobile/package.json` (with its lockfile), to the same `MAJOR.MINOR.PATCH` (command-center/src/version.test.ts fails when they differ). The Android app takes its versionName and versionCode from mobile/package.json, so it carries the release version without a separate edit. Nothing after the patch: a prerelease or build suffix is not a version and never installs.
4. CHANGELOG.md has an entry for the version, naming any migration in `command-center/src/core/schema.ts` so an install's owner knows a snapshot is taken (with the daemon stopped, right before the new code first runs) and what a rollback restores.
5. Tag and sign, with the notes as the tag message. The message is what `cc update` shows as the release notes and the dashboard's update panel carries (control characters stripped, 4000 characters at most). With the certificate, that is `scripts\sign-release.ps1` as above. With the SSH key:

   ```sh
   git tag -s v2.1.0 -m "Release 2.1.0

   What changed, in a few lines. Name any migration."
   ```

   git asks for the key's passphrase in the terminal, so the tag is made from a terminal, not from a tool or script that has none. Keep the notes in a file and pass `-F notes.txt` instead of `-m`, so a failed attempt (a wrong passphrase) costs only a retry; git's message that the notes were left in `.git/TAG_EDITMSG` is not true when they were given with `-m` or `-F`.

6. Push the tag: `git push origin v2.1.0`. Installs find it with a credential-free `git fetch --tags`.
7. Make a GitHub release for the tag with the same notes, for people reading the repository. Installs never read it: the signature on the tag is what they trust, and GitHub's own signing (the web-flow key on merge commits) proves nothing to them.
8. Build the Android app, signed with the same certificate, and attach it to that release: `npm run release:apk -- --upload` from a clean checkout of the tag (mobile/README.md, "Release build"). The App update card in the app's Settings offers the APK of the newest release, and Android installs it only over an app signed with the same key.

An install then updates with `cc update --release` (or names the version with `cc update --to v2.1.0`), after `cc update --check` has shown what it would do.

## Key rotation

A new key enters the way the first one did, and the old key vouches for it. A renewed certificate with a new key is the same procedure, its line made with `ssh-keygen -i -m PKCS8` from the new public key. The Android app is signed with the same certificate, and its installs need the old key to vouch too, in a signing lineage made once with both keys (mobile/README.md, "When the certificate is renewed"):

1. Make the new key (the setup above, a new file name) and add its line to `release-signers`, keeping the old line.
2. Make a release signed by the old key that carries the new file.
3. On each install, `cc update --check` reports "the signers file changed; run cc update --trust-signers to review it". The owner runs `cc update --trust-signers`, which shows the pinned keys and the committed keys side by side (principal, key type, SHA256 fingerprint) and replaces the pinned copy on a yes.
4. From the next release on, sign with the new key. Remove the old line from `release-signers` in a later release once every install has trusted the new key; the removal is confirmed on each install the same way.

An install never widens trust on its own: a tag signed by a key the install has not pinned is skipped and reported, whatever the committed file says. A lost key is the same procedure with the one difference that step 2 cannot be signed by it, so each install's owner trusts the new file by reading the fingerprint from somewhere they trust (this document's history, a message from the owner) before saying yes.

## Forks

A fork makes its own key and replaces the lines in `release-signers` with its own. Its installs pin that file on first use and verify the fork's tags against it; upstream's tags, signed by upstream's key, are skipped on those installs, and the fork's tags are skipped on upstream's. An install of a fork that still carries upstream's key would accept upstream's releases, which is a choice the fork's owner makes by leaving the line in.

Until a key is in the file, `cc update --release`, `--to`, and `--check` say that no release can verify and stop. That is the state of a fresh fork.

## Current keys

The keys in `release-signers` on `main`, for checking a fingerprint before saying yes to `cc update --trust-signers`:

| Principal | Type | Fingerprint | Added |
|---|---|---|---|
| polaris-release | ED25519 | `SHA256:SgblxfPsvIrosQE5pPclL9f+jPJDMrh8Nv6I462zpm8` | 2026-10-15 |
| ok-studio-ev | RSA 4096 (the EV certificate, X.509 signatures) | `SHA256:eMHThaXAAD/pUDF5L2I7sggykNuhj7EIwkY25IT1eTA` | 2026-11-02 |

A key added or removed later gets a row here in the same change that edits `release-signers`.

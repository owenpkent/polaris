# Releases

A release is a tag `vX.Y.Z` on `main`, signed with the owner's SSH key. `cc update --release` on an install fetches the tags, takes the newest one strictly newer than the version it runs, verifies the signature against the keys that install has pinned, and installs it (the design is docs/update-proposal.md, section 2; the command is described under Updating in command-center/README.md). Nothing marks a commit as "meant to run" except this signature, so the key and this checklist are what stand between a push to `main` and every install.

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

The file carries comments that repeat the format. `namespaces="git"` is required: git signs tags in the `git` namespace and `git verify-tag` accepts nothing else. The signature must be an SSH one: installs read the tag object and skip a tag signed with OpenPGP or X.509, or carrying more than one signature, whatever keys their git could find.

Check that the setup signs and verifies before the first release:

```sh
git tag -s test-signing -m "test"
git -c gpg.ssh.allowedSignersFile=release-signers verify-tag test-signing
git tag -d test-signing
```

## Release checklist

1. CI is green on the commit on `main` that becomes the release.
2. `npm run test:ui` has run on it (CI runs `npm run test:fast`; the UI tests are the release gate).
3. The version is bumped in both `package.json` and `command-center/package.json`, to the same `MAJOR.MINOR.PATCH` (command-center/src/version.test.ts fails when they differ). Nothing after the patch: a prerelease or build suffix is not a version and never installs.
4. CHANGELOG.md has an entry for the version, naming any migration in `command-center/src/core/schema.ts` so an install's owner knows a snapshot is taken (with the daemon stopped, right before the new code first runs) and what a rollback restores.
5. Tag and sign, with the notes as the tag message. The message is what `cc update` shows as the release notes and the dashboard's update panel carries (control characters stripped, 4000 characters at most):

   ```sh
   git tag -s v2.1.0 -m "Release 2.1.0

   What changed, in a few lines. Name any migration."
   ```

6. Push the tag: `git push origin v2.1.0`. Installs find it with a credential-free `git fetch --tags`.
7. Make a GitHub release for the tag with the same notes, for people reading the repository. Installs never read it: the signature on the tag is what they trust, and GitHub's own signing (the web-flow key on merge commits) proves nothing to them.

An install then updates with `cc update --release` (or names the version with `cc update --to v2.1.0`), after `cc update --check` has shown what it would do.

## Key rotation

A new key enters the way the first one did, and the old key vouches for it:

1. Make the new key (the setup above, a new file name) and add its line to `release-signers`, keeping the old line.
2. Make a release signed by the old key that carries the new file.
3. On each install, `cc update --check` reports "the signers file changed; run cc update --trust-signers to review it". The owner runs `cc update --trust-signers`, which shows the pinned keys and the committed keys side by side (principal, key type, SHA256 fingerprint) and replaces the pinned copy on a yes.
4. From the next release on, sign with the new key. Remove the old line from `release-signers` in a later release once every install has trusted the new key; the removal is confirmed on each install the same way.

An install never widens trust on its own: a tag signed by a key the install has not pinned is skipped and reported, whatever the committed file says. A lost key is the same procedure with the one difference that step 2 cannot be signed by it, so each install's owner trusts the new file by reading the fingerprint from somewhere they trust (this document's history, a message from the owner) before saying yes.

## Forks

A fork makes its own key and replaces the lines in `release-signers` with its own. Its installs pin that file on first use and verify the fork's tags against it; upstream's tags, signed by upstream's key, are skipped on those installs, and the fork's tags are skipped on upstream's. An install of a fork that still carries upstream's key would accept upstream's releases, which is a choice the fork's owner makes by leaving the line in.

Until a key is in the file, `cc update --release`, `--to`, and `--check` say that no release can verify and stop. That is the state of a fresh fork and of this repository before its first release.

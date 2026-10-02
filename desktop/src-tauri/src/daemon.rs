// Pure helpers for main.rs: where the database, token file, and log live, how the daemon is
// started, and the URL the window is pointed at. Nothing here touches the file system or the
// network, so all of it is tested below.

use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 8788;

/// Environment lookup, injectable for tests.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

fn setting(env: Env, name: &str) -> Option<String> {
    env(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// CC_DB if set, so the CLI, the logon task, and this app can share one database. Otherwise
/// %APPDATA%\constellation\data\constellation.db, beside the secret store the CLI already keeps
/// under %APPDATA%\constellation (see command-center/src/ingest/secrets.ts).
///
/// A relative CC_DB is made absolute against `cwd`, the directory the app was launched from.
/// The daemon is started in the database's own folder, so passing it the relative path as given
/// would have it resolve the path a second time from there (data\data\constellation.db) and
/// write its token where this app never looks.
pub fn db_path(env: Env, cwd: &Path) -> PathBuf {
    if let Some(db) = setting(env, "CC_DB") {
        return cwd.join(db);
    }
    let base = setting(env, "APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    base.join("constellation").join("data").join("constellation.db")
}

/// CC_PORT, or the daemon's default. Zero would mean "any port", which the window could not find.
pub fn port(env: Env) -> Result<u16, String> {
    match setting(env, "CC_PORT") {
        None => Ok(DEFAULT_PORT),
        Some(raw) => raw
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0)
            .ok_or_else(|| format!("CC_PORT is not a port number: \"{raw}\".")),
    }
}

/// The api token the daemon will use, with the precedence of resolveTokens in
/// command-center/src/http/token.ts: a nonempty CC_API_TOKEN, taken as it is, wins and is never
/// written to the file; otherwise the file's trimmed contents. The daemon inherits this app's
/// environment, so both sides settle on the same token.
pub fn api_token(env: Env, file_contents: Option<String>) -> Option<String> {
    if let Some(token) = env("CC_API_TOKEN").filter(|v| !v.is_empty()) {
        return Some(token);
    }
    file_contents.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// What the window does with a request to open a new one (a `target=_blank` link or form, or
/// window.open).
#[derive(Debug, PartialEq, Eq)]
pub enum NewWindow {
    /// Let the webview open its own popup. Only for the GitHub App manifest form, which is a POST
    /// the system browser could not be handed: its body would be lost.
    Popup,
    /// Hand the URL to the system browser: GitHub sign-in, install and settings pages, and every
    /// link in a task. The dashboard notices a finished sign-in when it gets focus back.
    Browser,
    /// Anything that is not http or https.
    Refuse,
}

pub fn new_window(url: &url::Url) -> NewWindow {
    match url.scheme() {
        "https" if url.host_str() == Some("github.com") && url.path() == "/settings/apps/new" => NewWindow::Popup,
        "http" | "https" => NewWindow::Browser,
        _ => NewWindow::Refuse,
    }
}

/// The daemon writes its api token next to the database (command-center/src/http/token.ts).
pub fn token_file(db: &Path) -> PathBuf {
    sibling(db, "api-token")
}

pub fn log_file(db: &Path) -> PathBuf {
    sibling(db, "daemon.log")
}

/// The shell's own log: what it found, what it started, and why it could not. A windowed
/// process has no console, so this is the only place a failure before the window can be read.
pub fn app_log_file(db: &Path) -> PathBuf {
    sibling(db, "desktop.log")
}

fn sibling(db: &Path, name: &str) -> PathBuf {
    db.parent().unwrap_or_else(|| Path::new(".")).join(name)
}

/// The arguments after node.exe. The import job reads initiatives/*.md from the constellation
/// repo, which an installed app does not have unless CC_REPO_ROOT names a checkout, so without
/// one the job is skipped rather than failing every half hour.
pub fn daemon_args(script: &Path, port: u16, has_repo_root: bool) -> Vec<String> {
    let mut args = vec![
        script.to_string_lossy().into_owned(),
        "daemon".to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    if !has_repo_root {
        args.push("--skip".to_string());
        args.push("import".to_string());
    }
    args
}

/// The dashboard's own URL with the connection in the fragment: the handoff that
/// src/command-center/ConnectionContext.jsx accepts from a loopback address, as scripts/mockup.mjs
/// uses it. A fragment never reaches the server, and the page clears it on load.
pub fn handoff_url(port: u16, token: &str) -> String {
    let base = format!("http://127.0.0.1:{port}");
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("cc-url", &base)
        .append_pair("cc-token", token)
        .finish();
    format!("{base}/#{query}")
}

/// The answer the daemon gives to an identity challenge (command-center/src/http/identity.ts):
/// HMAC-SHA256 over a fixed label, the port the request reached, and the challenge, keyed with
/// the api token. Only a process that holds the token can produce it, so the shell can tell the
/// Command Center for this database from anything else answering on the port before it sends
/// the token anywhere. The port in the message stops a process on this port forwarding the
/// challenge to a real daemon listening on another one.
pub fn identity_proof(token: &str, port: u16, challenge: &str) -> String {
    let message = format!("constellation-identity\n{port}\n{challenge}");
    hex::encode(hmac_sha256(token.as_bytes(), message.as_bytes()))
}

/// HMAC as RFC 2104 defines it over SHA-256, written out rather than pulled in as a crate.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let inner: Vec<u8> = block.iter().map(|b| b ^ 0x36).collect();
    let outer: Vec<u8> = block.iter().map(|b| b ^ 0x5c).collect();
    let mut hasher = Sha256::new();
    hasher.update(&inner);
    hasher.update(message);
    let inner_hash = hasher.finalize();
    let mut hasher = Sha256::new();
    hasher.update(&outer);
    hasher.update(inner_hash);
    hasher.finalize().into()
}

/// Whether two proofs are the same, taking the same time whatever they are.
pub fn same_proof(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Tauri resolves its directories to the verbatim form (\\?\C:\...). Node accepts it, but the
/// paths go into environment variables and error messages, where the plain form reads better.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_with(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }

    const CWD: &str = r"C:\launch";

    #[test]
    fn database_defaults_to_appdata_beside_the_secret_store() {
        let env = env_with(&[("APPDATA", r"C:\Users\sam\AppData\Roaming")]);
        assert_eq!(
            db_path(&env, Path::new(CWD)),
            PathBuf::from(r"C:\Users\sam\AppData\Roaming\constellation\data\constellation.db")
        );
    }

    #[test]
    fn cc_db_wins_and_blank_cc_db_is_ignored() {
        let set = env_with(&[("CC_DB", r"D:\cc\constellation.db"), ("APPDATA", r"C:\x")]);
        assert_eq!(db_path(&set, Path::new(CWD)), PathBuf::from(r"D:\cc\constellation.db"));
        let blank = env_with(&[("CC_DB", "   "), ("APPDATA", r"C:\x")]);
        assert_eq!(db_path(&blank, Path::new(CWD)), PathBuf::from(r"C:\x\constellation\data\constellation.db"));
    }

    #[test]
    fn a_relative_cc_db_is_resolved_against_the_launch_directory() {
        let sub = env_with(&[("CC_DB", r"data\constellation.db")]);
        let db = db_path(&sub, Path::new(CWD));
        assert_eq!(db, PathBuf::from(r"C:\launch\data\constellation.db"));
        assert_eq!(token_file(&db), PathBuf::from(r"C:\launch\data\api-token"));
        let bare = env_with(&[("CC_DB", "constellation.db")]);
        let db = db_path(&bare, Path::new(CWD));
        assert_eq!(db, PathBuf::from(r"C:\launch\constellation.db"));
        assert_eq!(token_file(&db), PathBuf::from(r"C:\launch\api-token"));
        assert!(db.is_absolute());
    }

    #[test]
    fn the_token_override_wins_over_the_file_as_the_daemon_decides() {
        let over = env_with(&[("CC_API_TOKEN", "from-env")]);
        assert_eq!(api_token(&over, Some("stale-file".into())), Some("from-env".into()));
        assert_eq!(api_token(&over, None), Some("from-env".into()));
        let none = env_with(&[]);
        assert_eq!(api_token(&none, Some("  from-file\n".into())), Some("from-file".into()));
        assert_eq!(api_token(&none, Some("   ".into())), None);
        assert_eq!(api_token(&none, None), None);
        let empty = env_with(&[("CC_API_TOKEN", "")]);
        assert_eq!(api_token(&empty, Some("from-file".into())), Some("from-file".into()));
    }

    #[test]
    fn only_the_app_manifest_form_opens_inside_the_app() {
        let url = |s: &str| url::Url::parse(s).expect("url");
        assert_eq!(new_window(&url("https://github.com/settings/apps/new?state=abc")), NewWindow::Popup);
        assert_eq!(new_window(&url("https://github.com/login/oauth/authorize?client_id=x")), NewWindow::Browser);
        assert_eq!(new_window(&url("http://github.com/settings/apps/new")), NewWindow::Browser);
        assert_eq!(new_window(&url("https://github.com.evil.example/settings/apps/new")), NewWindow::Browser);
        assert_eq!(new_window(&url("https://example.com/a")), NewWindow::Browser);
        assert_eq!(new_window(&url("file:///C:/Windows/System32/calc.exe")), NewWindow::Refuse);
        assert_eq!(new_window(&url("javascript:alert(1)")), NewWindow::Refuse);
    }

    #[test]
    fn port_defaults_parses_and_rejects_nonsense() {
        assert_eq!(port(&env_with(&[])), Ok(8788));
        assert_eq!(port(&env_with(&[("CC_PORT", "8790")])), Ok(8790));
        assert!(port(&env_with(&[("CC_PORT", "eight")])).is_err());
        assert!(port(&env_with(&[("CC_PORT", "0")])).is_err());
        assert!(port(&env_with(&[("CC_PORT", "70000")])).is_err());
    }

    #[test]
    fn token_and_log_sit_next_to_the_database() {
        let db = Path::new(r"C:\data\constellation.db");
        assert_eq!(token_file(db), PathBuf::from(r"C:\data\api-token"));
        assert_eq!(log_file(db), PathBuf::from(r"C:\data\daemon.log"));
        assert_eq!(app_log_file(db), PathBuf::from(r"C:\data\desktop.log"));
    }

    #[test]
    fn import_is_skipped_without_a_repo_checkout() {
        let script = Path::new(r"C:\app\resources\command-center\src\bundle\cli.mjs");
        assert_eq!(
            daemon_args(script, 8788, false),
            vec![script.to_string_lossy().to_string(), "daemon".into(), "--port".into(), "8788".into(), "--skip".into(), "import".into()]
        );
        assert_eq!(
            daemon_args(script, 8790, true),
            vec![script.to_string_lossy().to_string(), "daemon".into(), "--port".into(), "8790".into()]
        );
    }

    #[test]
    fn handoff_points_the_page_at_its_own_origin() {
        assert_eq!(
            handoff_url(8788, "abc-DEF_123"),
            "http://127.0.0.1:8788/#cc-url=http%3A%2F%2F127.0.0.1%3A8788&cc-token=abc-DEF_123"
        );
        // A token is base64url, but the encoder must cope with anything a CC_API_TOKEN override holds.
        assert_eq!(
            handoff_url(1, "a b&c"),
            "http://127.0.0.1:1/#cc-url=http%3A%2F%2F127.0.0.1%3A1&cc-token=a+b%26c"
        );
    }

    #[test]
    fn identity_proof_matches_the_daemon() {
        // The same vector as 'the identity proof matches the vector the desktop shell tests
        // against' in command-center/src/http/server.test.ts.
        let challenge = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        assert_eq!(
            identity_proof("test-api-token-0000000000000000", 8788, challenge),
            "c5645df43c6953e54e585515e6a4e5df0eb628a16ba1d28ec57314c0cf266db6"
        );
        assert_ne!(identity_proof("another-token", 8788, challenge), identity_proof("test-api-token-0000000000000000", 8788, challenge));
        assert_ne!(identity_proof("test-api-token-0000000000000000", 8789, challenge), identity_proof("test-api-token-0000000000000000", 8788, challenge));
    }

    #[test]
    fn hmac_matches_the_rfc_4231_vectors() {
        // Test case 2 of RFC 4231: key "Jefe", data "what do ya want for nothing?".
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Test case 6: a 131-byte key, which is hashed first.
        assert_eq!(
            hex::encode(hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn same_proof_compares_whole_strings() {
        assert!(same_proof("abc", "abc"));
        assert!(!same_proof("abc", "abd"));
        assert!(!same_proof("abc", "ab"));
        assert!(!same_proof("", "a"));
    }

    #[test]
    fn verbatim_prefixes_are_removed() {
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\Program Files\Constellation")), PathBuf::from(r"C:\Program Files\Constellation"));
        assert_eq!(strip_verbatim(Path::new(r"\\?\UNC\nas\share\x")), PathBuf::from(r"\\nas\share\x"));
        assert_eq!(strip_verbatim(Path::new(r"C:\plain")), PathBuf::from(r"C:\plain"));
    }
}

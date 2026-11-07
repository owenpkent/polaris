package com.okstudio.polaris;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;

// The app's own updater, down to the one tap Android requires of a sideloaded app
// (docs/app-auto-update-proposal.md). The dashboard decides when to check and what to fetch
// (src/command-center/appAutoUpdate.js); this plugin fetches the APK into the app's own cache,
// checks that it is this app signed by this app's certificate, and hands it to the system
// installer, which shows its confirmation. Nothing here installs anything itself, and nothing
// reads a file the dashboard did not just download.
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    static final String UPDATES_DIR = "updates";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    private static final long MAX_APK_BYTES = 200L * 1024 * 1024;

    // Downloads the APK at `url` to cache/updates/<name>, replacing whatever was there. The URL is
    // the one GitHub's releases API returned for the asset: https, on GitHub's own hosts, or it is
    // refused before any connection is made. A `size` from the API is checked against the file.
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String name = safeFileName(call.getString("name", ""));
        Long size = call.getLong("size");
        if (!isAllowedUrl(url)) { call.reject("The download address is not a GitHub https address."); return; }
        if (name == null) { call.reject("The asset has no usable file name."); return; }
        File dir = updatesDir(getContext());
        deleteTree(dir);
        if (!dir.mkdirs() && !dir.isDirectory()) { call.reject("Could not make the updates folder."); return; }
        File target = new File(dir, name);
        new Thread(() -> {
            try {
                long written = fetchTo(url, target, size);
                JSObject ret = new JSObject();
                ret.put("path", target.getAbsolutePath());
                ret.put("size", written);
                call.resolve(ret);
            } catch (IOException e) {
                deleteTree(dir);
                call.reject("The download failed: " + e.getMessage());
            }
        }, "polaris-app-update").start();
    }

    // Reads the downloaded file as a package. `ok` only when it is this app (same package name)
    // signed by this app's certificate, or by a newer one the installed certificate vouches for
    // through the signing lineage (acceptsSigners). Anything else is deleted and refused, so a
    // wrong file never reaches the installer.
    @PluginMethod
    public void verify(PluginCall call) {
        String path = call.getString("path", "");
        File file = new File(path);
        if (!isInUpdatesDir(getContext(), file) || !file.isFile()) { call.reject("No downloaded update at that path."); return; }
        PackageManager pm = getContext().getPackageManager();
        PackageInfo info = archiveInfo(pm, file.getAbsolutePath());
        PackageInfo own = ownInfo(pm, getContext().getPackageName());
        JSObject ret = new JSObject();
        if (info == null || own == null) {
            deleteTree(updatesDir(getContext()));
            ret.put("ok", false);
            ret.put("sameSigner", false);
            ret.put("packageName", JSObject.NULL);
            ret.put("versionName", JSObject.NULL);
            ret.put("versionCode", JSObject.NULL);
            call.resolve(ret);
            return;
        }
        boolean samePackage = getContext().getPackageName().equals(info.packageName);
        Signers archive = signersOf(info);
        Signers installed = signersOf(own);
        boolean sameSigner = acceptsSigners(archive.certs, archive.multiple, installed.certs, installed.multiple);
        boolean ok = samePackage && sameSigner;
        if (!ok) deleteTree(updatesDir(getContext()));
        ret.put("ok", ok);
        ret.put("sameSigner", sameSigner);
        ret.put("packageName", info.packageName);
        ret.put("versionName", info.versionName == null ? JSObject.NULL : info.versionName);
        ret.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode);
        call.resolve(ret);
    }

    // Whether Android lets this app start an install. Before Android 8 there is no per-app switch.
    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject ret = new JSObject();
        ret.put("allowed", allowed);
        call.resolve(ret);
    }

    // The system page where the owner allows this app to install apps, once.
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }

    // Hands a verified download to the system installer through the app's FileProvider. Android
    // shows its confirmation sheet; the app does nothing else.
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path", "");
        File file = new File(path);
        if (!isInUpdatesDir(getContext(), file) || !file.isFile()) { call.reject("No downloaded update at that path."); return; }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, APK_MIME);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Android could not open the installer: " + e.getMessage());
        }
    }

    // Deletes the downloaded update, if any.
    @PluginMethod
    public void discard(PluginCall call) {
        deleteTree(updatesDir(getContext()));
        call.resolve();
    }

    // --- rules, kept static so they are testable without a device (AppUpdaterRulesTest) ---

    // Only https, and only GitHub's own hosts: github.com and *.githubusercontent.com, where the
    // releases API's asset links point and redirect.
    static boolean isAllowedUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            return false;
        }
        if (!"https".equals(uri.getScheme())) return false;
        String host = uri.getHost();
        if (host == null || uri.getUserInfo() != null) return false;
        host = host.toLowerCase(Locale.ROOT);
        return host.equals("github.com") || host.equals("www.github.com") || host.equals("githubusercontent.com") || host.endsWith(".githubusercontent.com");
    }

    // The asset's name reduced to a plain file name ending in .apk, or null when nothing usable
    // is left. No path separators, no leading dots, and a bounded length.
    static String safeFileName(String name) {
        if (name == null) return null;
        String base = name.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[^A-Za-z0-9._-]", "_");
        while (base.startsWith(".")) base = base.substring(1);
        if (base.length() > 80) base = base.substring(base.length() - 80);
        if (base.isEmpty() || base.equals(".apk") || !base.toLowerCase(Locale.ROOT).endsWith(".apk")) return null;
        return base;
    }

    // Whether the archive's signers are this app's. Each side is a list of certificates (as
    // Signature.toCharsString gives them) and whether they are several signers at once.
    // - Several signers at once: both sides must be, and the two sets must be exactly equal. There
    //   is no lineage with multiple signers, so a lineage on one side and several signers on the
    //   other is never the same signer.
    // - One signer: each list is the signing history, oldest first, ending in the current key, which
    //   is what Android 9 and later report (and a one-element list before that). The installed
    //   history must be the start of the archive's: the same key, or the installed key vouching for
    //   a newer one through the lineage mobile/README.md describes (A to B, then B to C), as the
    //   platform accepts a rotation. A history that drops the installed key (a rollback) or forks
    //   from it (another key that A never vouched for) is refused, as Android refuses it.
    static boolean acceptsSigners(String[] archive, boolean archiveMultiple, String[] installed, boolean installedMultiple) {
        if (archive == null || installed == null || archive.length == 0 || installed.length == 0) return false;
        if (archiveMultiple != installedMultiple) return false;
        if (archiveMultiple) {
            return new HashSet<>(Arrays.asList(archive)).equals(new HashSet<>(Arrays.asList(installed)));
        }
        if (installed.length > archive.length) return false;
        for (int i = 0; i < installed.length; i++) {
            if (!installed[i].equals(archive[i])) return false;
        }
        return true;
    }

    // The flags for reading a package's signing information. Android 9 and 10 collect an
    // archive's certificates only when GET_SIGNATURES is asked for, and fill signingInfo only when
    // GET_SIGNING_CERTIFICATES is, so an archive on those versions needs both; Android 11 and later
    // accept either, and before 9 there is only GET_SIGNATURES. An installed package is read by the
    // package manager service, which answers GET_SIGNING_CERTIFICATES alone from 9 on.
    @SuppressWarnings("deprecation")
    static int signingFlags(int sdk, boolean archive) {
        if (sdk < Build.VERSION_CODES.P) return PackageManager.GET_SIGNATURES;
        if (archive && sdk < Build.VERSION_CODES.R) return PackageManager.GET_SIGNATURES | PackageManager.GET_SIGNING_CERTIFICATES;
        return PackageManager.GET_SIGNING_CERTIFICATES;
    }

    // --- helpers ---

    static File updatesDir(Context context) {
        return new File(context.getCacheDir(), UPDATES_DIR);
    }

    // A path the dashboard hands back must be a file inside the updates folder, nothing else.
    static boolean isInUpdatesDir(Context context, File file) {
        try {
            String dir = updatesDir(context).getCanonicalPath() + File.separator;
            return file.getCanonicalPath().startsWith(dir);
        } catch (IOException e) {
            return false;
        }
    }

    private static long fetchTo(String url, File target, Long expectedSize) throws IOException {
        URL address;
        try {
            address = new URI(url).toURL();
        } catch (URISyntaxException | IllegalArgumentException e) {
            throw new IOException("the download address is not valid", e);
        }
        HttpURLConnection conn = (HttpURLConnection) address.openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("Accept", "application/octet-stream");
        try {
            int status = conn.getResponseCode();
            // HttpURLConnection follows https-to-https redirects itself; a hop elsewhere is refused.
            if (status / 100 == 3) throw new IOException("the download was redirected off GitHub");
            if (status != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + status);
            if (!isAllowedUrl(conn.getURL().toString())) throw new IOException("the download left GitHub");
            long written = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    written += n;
                    if (written > MAX_APK_BYTES) throw new IOException("the file is larger than an APK can be");
                    out.write(buf, 0, n);
                }
            }
            if (expectedSize != null && expectedSize > 0 && written != expectedSize) {
                throw new IOException("the file is " + written + " bytes, not the " + expectedSize + " the release lists");
            }
            return written;
        } finally {
            conn.disconnect();
        }
    }

    private static PackageInfo archiveInfo(PackageManager pm, String path) {
        return pm.getPackageArchiveInfo(path, signingFlags(Build.VERSION.SDK_INT, true));
    }

    private static PackageInfo ownInfo(PackageManager pm, String packageName) {
        try {
            return pm.getPackageInfo(packageName, signingFlags(Build.VERSION.SDK_INT, false));
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }

    // A package's signers as acceptsSigners reads them: the certificates and whether they are
    // several at once. One signer on Android 9 and later gives its whole signing history.
    static final class Signers {
        final String[] certs;
        final boolean multiple;

        Signers(String[] certs, boolean multiple) {
            this.certs = certs;
            this.multiple = multiple;
        }
    }

    @SuppressWarnings("deprecation")
    private static Signers signersOf(PackageInfo info) {
        Signature[] sigs;
        boolean multiple;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            multiple = info.signingInfo.hasMultipleSigners();
            sigs = multiple ? info.signingInfo.getApkContentsSigners() : info.signingInfo.getSigningCertificateHistory();
        } else {
            sigs = info.signatures;
            multiple = sigs != null && sigs.length > 1;
        }
        if (sigs == null) return new Signers(new String[0], multiple);
        String[] certs = new String[sigs.length];
        for (int i = 0; i < sigs.length; i++) certs[i] = sigs[i].toCharsString();
        return new Signers(certs, multiple);
    }

    static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}

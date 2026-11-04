package com.okstudio.polaris;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

// The updater's static rules, run on the JVM (gradlew testDebugUnitTest, no device): which
// download addresses are taken, and what an asset name becomes on disk. Both rules are plain
// Java (java.net.URI, no android.net.Uri), which is what lets them run here.
public class AppUpdaterRulesTest {
    @Test
    public void onlyGitHubOverHttpsIsAllowed() {
        assertTrue(AppUpdaterPlugin.isAllowedUrl("https://github.com/owenpkent/polaris/releases/download/v2.6.0/polaris-2.6.0.apk"));
        assertTrue(AppUpdaterPlugin.isAllowedUrl("https://objects.githubusercontent.com/github-production-release-asset/1?x=y"));
        assertTrue(AppUpdaterPlugin.isAllowedUrl("https://release-assets.githubusercontent.com/a/b"));
        assertFalse(AppUpdaterPlugin.isAllowedUrl("http://github.com/owenpkent/polaris/releases/download/v2.6.0/polaris-2.6.0.apk"));
        assertFalse(AppUpdaterPlugin.isAllowedUrl("https://github.com.evil.example/x.apk"));
        assertFalse(AppUpdaterPlugin.isAllowedUrl("https://evilgithubusercontent.com/x.apk"));
        assertFalse(AppUpdaterPlugin.isAllowedUrl("https://user@github.com/x.apk"));
        assertFalse(AppUpdaterPlugin.isAllowedUrl("file:///sdcard/x.apk"));
        assertFalse(AppUpdaterPlugin.isAllowedUrl(""));
        assertFalse(AppUpdaterPlugin.isAllowedUrl(null));
    }

    @Test
    public void anAssetNameBecomesAPlainApkFileName() {
        assertEquals("polaris-2.6.0.apk", AppUpdaterPlugin.safeFileName("polaris-2.6.0.apk"));
        assertEquals("polaris-2.6.0.apk", AppUpdaterPlugin.safeFileName("../../polaris-2.6.0.apk"));
        assertEquals("polaris-2.6.0.apk", AppUpdaterPlugin.safeFileName("C:\\Users\\x\\polaris-2.6.0.apk"));
        assertEquals("polaris_2.6.0_beta.apk", AppUpdaterPlugin.safeFileName("polaris 2.6.0 beta.apk"));
        assertEquals("hidden.apk", AppUpdaterPlugin.safeFileName("...hidden.apk"));
        assertNull(AppUpdaterPlugin.safeFileName("polaris-2.6.0.zip"));
        assertNull(AppUpdaterPlugin.safeFileName(".apk"));
        assertNull(AppUpdaterPlugin.safeFileName(""));
        assertNull(AppUpdaterPlugin.safeFileName(null));
        String longName = "a".repeat(120) + ".apk";
        String reduced = AppUpdaterPlugin.safeFileName(longName);
        assertTrue(reduced.length() <= 80);
        assertTrue(reduced.endsWith(".apk"));
    }
}

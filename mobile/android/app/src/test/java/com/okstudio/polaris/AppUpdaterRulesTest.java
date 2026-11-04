package com.okstudio.polaris;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.pm.PackageManager;

import org.junit.Test;

// The updater's static rules, run on the JVM (gradlew testDebugUnitTest, no device): which
// download addresses are taken, what an asset name becomes on disk, which signers an archive may
// carry, and which flags read them on each Android version. All are plain Java over strings and
// ints (java.net.URI, no android.net.Uri; the Android constants are compile-time values), which is
// what lets them run here.
public class AppUpdaterRulesTest {
    private static final String A = "a1";
    private static final String B = "b2";
    private static final String C = "c3";

    private static boolean accepts(String[] archive, String[] installed) {
        return AppUpdaterPlugin.acceptsSigners(archive, false, installed, false);
    }

    @Test
    public void theSameSingleSignerIsAccepted() {
        assertTrue(accepts(new String[] {A}, new String[] {A}));
        assertTrue(accepts(new String[] {A, B}, new String[] {A, B}));
        assertFalse(accepts(new String[] {B}, new String[] {A}));
    }

    // The renewals mobile/README.md describes: an install signed by A takes a release whose
    // lineage is A then B, and one updated to B takes A, B, then C.
    @Test
    public void aVerifiedExtensionOfTheInstalledLineageIsAccepted() {
        assertTrue(accepts(new String[] {A, B}, new String[] {A}));
        assertTrue(accepts(new String[] {A, B, C}, new String[] {A, B}));
        assertTrue(accepts(new String[] {A, B, C}, new String[] {A}));
    }

    @Test
    public void aLineageThatDropsOrForksTheInstalledKeyIsRefused() {
        // A rollback: the install already moved to B, the file is signed by A alone.
        assertFalse(accepts(new String[] {A}, new String[] {A, B}));
        // A fork: A vouched for C, never for the installed B.
        assertFalse(accepts(new String[] {A, C}, new String[] {A, B}));
        // A chain that starts elsewhere.
        assertFalse(accepts(new String[] {B, C}, new String[] {A, B}));
    }

    @Test
    public void severalSignersAtOnceMustMatchExactly() {
        assertTrue(AppUpdaterPlugin.acceptsSigners(new String[] {A, B}, true, new String[] {B, A}, true));
        assertFalse(AppUpdaterPlugin.acceptsSigners(new String[] {A, B, C}, true, new String[] {A, B}, true));
        // Multiple on one side and a lineage on the other is never the same signer.
        assertFalse(AppUpdaterPlugin.acceptsSigners(new String[] {A, B}, true, new String[] {A}, false));
        assertFalse(AppUpdaterPlugin.acceptsSigners(new String[] {A, B}, false, new String[] {A, B}, true));
    }

    @Test
    public void missingSignersAreRefused() {
        assertFalse(accepts(new String[0], new String[] {A}));
        assertFalse(accepts(new String[] {A}, new String[0]));
        assertFalse(accepts(null, new String[] {A}));
        assertFalse(accepts(new String[] {A}, null));
    }

    // Android 9 and 10 collect an archive's certificates only for GET_SIGNATURES, so an archive
    // there is read with both flags; 11 and later accept either, and before 9 there is one flag.
    @Test
    @SuppressWarnings("deprecation")
    public void anArchiveOnAndroid9And10IsReadWithBothSigningFlags() {
        int both = PackageManager.GET_SIGNATURES | PackageManager.GET_SIGNING_CERTIFICATES;
        assertEquals(PackageManager.GET_SIGNATURES, AppUpdaterPlugin.signingFlags(27, true));
        assertEquals(PackageManager.GET_SIGNATURES, AppUpdaterPlugin.signingFlags(27, false));
        assertEquals(both, AppUpdaterPlugin.signingFlags(28, true));
        assertEquals(both, AppUpdaterPlugin.signingFlags(29, true));
        assertEquals(PackageManager.GET_SIGNING_CERTIFICATES, AppUpdaterPlugin.signingFlags(28, false));
        assertEquals(PackageManager.GET_SIGNING_CERTIFICATES, AppUpdaterPlugin.signingFlags(29, false));
        assertEquals(PackageManager.GET_SIGNING_CERTIFICATES, AppUpdaterPlugin.signingFlags(30, true));
        assertEquals(PackageManager.GET_SIGNING_CERTIFICATES, AppUpdaterPlugin.signingFlags(35, true));
        assertEquals(PackageManager.GET_SIGNING_CERTIFICATES, AppUpdaterPlugin.signingFlags(35, false));
    }

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

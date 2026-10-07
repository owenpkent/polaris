package com.okstudio.polaris;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.net.Uri;
import android.text.SpannableString;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.StyleSpan;

import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;

// MainActivity.rewriteShare turns a text share (ACTION_SEND) into the ACTION_VIEW intent for
// polaris://share that the Capacitor App plugin raises to the dashboard as appUrlOpen. It needs
// no server and no activity, so these tests run on the bare framework. They are the regression
// tests for the styled-text bug: getStringExtra returns null for a Spanned extra, so a share from
// an app that sends styled text used to arrive empty.
@RunWith(AndroidJUnit4.class)
public class ShareRewriteTest {

    private static Intent send(String type) {
        return new Intent(Intent.ACTION_SEND).setType(type);
    }

    private static Spanned styled(String text) {
        SpannableString spanned = new SpannableString(text);
        spanned.setSpan(new StyleSpan(android.graphics.Typeface.BOLD), 0, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return spanned;
    }

    private static void assertShare(Intent intent, String title, String text) {
        assertEquals(Intent.ACTION_VIEW, intent.getAction());
        Uri uri = intent.getData();
        assertEquals("polaris", uri.getScheme());
        assertEquals("share", uri.getHost());
        assertEquals(title, uri.getQueryParameter("share-title"));
        assertEquals(text, uri.getQueryParameter("share-text"));
    }

    @Test
    public void plainStringTextBecomesShareText() {
        Intent intent = send("text/plain").putExtra(Intent.EXTRA_TEXT, "Buy milk");
        MainActivity.rewriteShare(intent);
        assertShare(intent, null, "Buy milk");
        assertFalse(intent.getData().getQueryParameterNames().contains("share-title"));
    }

    @Test
    public void subjectAndTextBecomeTitleAndText() {
        Intent intent = send("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, "A page")
            .putExtra(Intent.EXTRA_TEXT, "https://example.com/page");
        MainActivity.rewriteShare(intent);
        assertShare(intent, "A page", "https://example.com/page");
    }

    @Test
    public void subjectAloneIsEnough() {
        Intent intent = send("text/plain").putExtra(Intent.EXTRA_SUBJECT, "Only a subject");
        MainActivity.rewriteShare(intent);
        assertShare(intent, "Only a subject", null);
        assertFalse(intent.getData().getQueryParameterNames().contains("share-text"));
    }

    @Test
    public void spannedTextIsReadAsCharSequence() {
        // The regression: a Spanned extra has no String form, so getStringExtra returns null.
        Intent intent = send("text/plain").putExtra(Intent.EXTRA_TEXT, styled("Styled text"));
        assertNull(intent.getStringExtra(Intent.EXTRA_TEXT));
        MainActivity.rewriteShare(intent);
        assertShare(intent, null, "Styled text");
    }

    @Test
    public void spannedSubjectAndTextTogether() {
        SpannableStringBuilder text = new SpannableStringBuilder("Read ");
        text.append(styled("this"));
        Intent intent = send("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, styled("Styled subject"))
            .putExtra(Intent.EXTRA_TEXT, text);
        MainActivity.rewriteShare(intent);
        assertShare(intent, "Styled subject", "Read this");
    }

    @Test
    public void otherTextSubtypesAreShares() {
        Intent intent = send("text/html").putExtra(Intent.EXTRA_TEXT, "<b>hi</b>");
        MainActivity.rewriteShare(intent);
        assertShare(intent, null, "<b>hi</b>");
    }

    @Test
    public void missingTextLeavesTheIntentAlone() {
        Intent intent = send("text/plain");
        MainActivity.rewriteShare(intent);
        assertEquals(Intent.ACTION_SEND, intent.getAction());
        assertNull(intent.getData());
    }

    @Test
    public void emptyTextAndSubjectLeaveTheIntentAlone() {
        Intent intent = send("text/plain")
            .putExtra(Intent.EXTRA_TEXT, "")
            .putExtra(Intent.EXTRA_SUBJECT, "");
        MainActivity.rewriteShare(intent);
        assertEquals(Intent.ACTION_SEND, intent.getAction());
        assertNull(intent.getData());
    }

    @Test
    public void emptySpannedTextLeavesTheIntentAlone() {
        Intent intent = send("text/plain").putExtra(Intent.EXTRA_TEXT, new SpannableString(""));
        MainActivity.rewriteShare(intent);
        assertEquals(Intent.ACTION_SEND, intent.getAction());
        assertNull(intent.getData());
    }

    @Test
    public void emptyTextWithASubjectKeepsOnlyTheSubject() {
        Intent intent = send("text/plain")
            .putExtra(Intent.EXTRA_TEXT, "")
            .putExtra(Intent.EXTRA_SUBJECT, "Subject");
        MainActivity.rewriteShare(intent);
        assertShare(intent, "Subject", null);
    }

    @Test
    public void reservedCharactersSurviveTheRoundTrip() {
        String text = "a&b=c?d#e f+g%20h/i\\j \"quoted\" <tag> 100% done";
        String subject = "Cafe éè, 日本語, 😀 & more";
        Intent intent = send("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, subject)
            .putExtra(Intent.EXTRA_TEXT, text);
        MainActivity.rewriteShare(intent);
        assertShare(intent, subject, text);

        // The query is percent-encoded, so no separator inside a value can split a parameter.
        String encoded = intent.getData().getEncodedQuery();
        assertFalse(encoded.contains(" "));
        assertFalse(encoded.contains("#"));
        assertTrue(encoded.contains("%26"));
        assertTrue(encoded.contains("%3D"));
        assertEquals(2, intent.getData().getQueryParameterNames().size());
    }

    @Test
    public void newlinesAreKept() {
        Intent intent = send("text/plain").putExtra(Intent.EXTRA_TEXT, "first line\nsecond line\r\nthird");
        MainActivity.rewriteShare(intent);
        assertShare(intent, null, "first line\nsecond line\r\nthird");
    }

    @Test
    public void imageSharesAreNotRewritten() {
        Intent intent = send("image/png").putExtra(Intent.EXTRA_TEXT, "caption");
        MainActivity.rewriteShare(intent);
        assertEquals(Intent.ACTION_SEND, intent.getAction());
        assertNull(intent.getData());
    }

    @Test
    public void aShareWithoutATypeIsNotRewritten() {
        Intent intent = new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "text");
        MainActivity.rewriteShare(intent);
        assertEquals(Intent.ACTION_SEND, intent.getAction());
        assertNull(intent.getData());
    }

    @Test
    public void otherActionsAreNotRewritten() {
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("https://example.com/"), "text/plain");
        view.putExtra(Intent.EXTRA_TEXT, "text");
        MainActivity.rewriteShare(view);
        assertEquals("https://example.com/", view.getData().toString());

        Intent main = new Intent(Intent.ACTION_MAIN).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "text");
        MainActivity.rewriteShare(main);
        assertEquals(Intent.ACTION_MAIN, main.getAction());
        assertNull(main.getData());
    }

    @Test
    public void aNullIntentIsIgnored() {
        MainActivity.rewriteShare(null);
    }
}

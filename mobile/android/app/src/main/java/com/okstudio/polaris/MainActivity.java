package com.okstudio.polaris;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

// The dashboard takes a share as URL parameters (src/command-center/shareIntake.js), the same
// ones the web app manifest's share_target maps. A share from another app reaches this activity
// as an ACTION_SEND intent, which nothing in Capacitor delivers to the page, so it is rewritten
// into an ACTION_VIEW intent carrying those parameters. The App plugin then raises appUrlOpen
// and keeps the event until the page has a listener. A cold start goes through onCreate, a
// running app through onNewIntent (the activity is singleTask, so a share never opens a second
// copy of the app).
public class MainActivity extends BridgeActivity {
    private static final String SHARE_URL = "polaris://share";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        rewriteShare(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        rewriteShare(intent);
        super.onNewIntent(intent);
    }

    // Rewrites a text share in place. Anything that is not a text share is left alone.
    static void rewriteShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        boolean hasText = text != null && !text.isEmpty();
        boolean hasSubject = subject != null && !subject.isEmpty();
        if (!hasText && !hasSubject) return;

        Uri.Builder url = Uri.parse(SHARE_URL).buildUpon();
        if (hasSubject) url.appendQueryParameter("share-title", subject);
        if (hasText) url.appendQueryParameter("share-text", text);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(url.build());
    }
}

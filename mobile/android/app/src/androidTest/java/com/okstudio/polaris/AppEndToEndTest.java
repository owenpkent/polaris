package com.okstudio.polaris;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.rule.GrantPermissionRule;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

// The dashboard inside the real app, talking to a real scratch daemon on the host. The runner
// (mobile/scripts/test.mjs) starts the daemon with CC_CORS_ORIGINS=https://localhost, forwards its
// port with `adb reverse`, and passes serverUrl and apiToken as instrumentation arguments. Without
// them these tests are skipped, so `connectedAndroidTest` still works for the share tests alone.
@RunWith(AndroidJUnit4.class)
public class AppEndToEndTest {
    private static final long LOAD_MS = 30000;

    // Reminders ask for POST_NOTIFICATIONS when the owner switches them on. Granting it here keeps
    // the system permission dialog, which belongs to Android and not to the app, out of the test.
    @Rule
    public GrantPermissionRule notifications = GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS);

    private String serverUrl;
    private String apiToken;
    private ActivityScenario<MainActivity> scenario;
    private WebAppDriver app;

    @Before
    public void launchWithAFreshPage() {
        Bundle args = InstrumentationRegistry.getArguments();
        serverUrl = args.getString("serverUrl");
        apiToken = args.getString("apiToken");
        assumeTrue("No scratch server: run through mobile/scripts/test.mjs", serverUrl != null && apiToken != null);

        scenario = ActivityScenario.launch(MainActivity.class);
        app = new WebAppDriver(scenario);
        app.waitFor("the dashboard to load", "document.readyState==='complete'&&window.Capacitor&&document.body.innerText.length>0", LOAD_MS);
        // The app keeps its settings in the WebView's localStorage across installs and runs, so
        // start each test as a first launch: no server, no token, no reminder choices.
        app.eval("localStorage.clear();null");
        app.evalAsync("Promise.resolve(window.Capacitor.nativePromise('LocalNotifications','getPending',{}))"
            + ".then(r=>window.Capacitor.nativePromise('LocalNotifications','cancel',{notifications:(r.notifications||[]).map(n=>({id:n.id}))}))", 10000);
        app.eval("location.reload();null");
        app.waitFor("the connect form", "__pt.find('textbox','Server URL')", LOAD_MS);
    }

    @After
    public void closeTheApp() {
        if (scenario != null) scenario.close();
    }

    private void connect() {
        app.fill("Server URL", serverUrl);
        app.fill("Access token", apiToken);
        app.click("button", "Connect");
        // Once connected the form offers Disconnect, which it never does before.
        app.waitForButton("Disconnect", LOAD_MS);
    }

    // What another app does when the owner picks Polaris in the share sheet: a SEND intent aimed at
    // this activity. The activity is singleTask, so a running app gets it in onNewIntent.
    private static void share(String subject, String text) {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .setComponent(new ComponentName(context, MainActivity.class))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (subject != null) send.putExtra(Intent.EXTRA_SUBJECT, subject);
        if (text != null) send.putExtra(Intent.EXTRA_TEXT, text);
        context.startActivity(send);
    }

    private void openConnectionSettings() {
        app.click("button", "Open navigation");
        app.waitFor("the navigation drawer", "__pt.find('dialog','Navigation')", 10000);
        app.click("button", "Connection");
        app.waitFor("the Reminders card", "document.body.innerText.includes('Remind me on the day a task is due')", 10000);
    }

    @Test
    public void connectFormConnectsToTheServer() {
        connect();
        // The form reports the server's counts once the health check answers.
        app.waitFor("the connection summary", "document.body.innerText.includes('inbox')", 15000);
        assertFalse(app.pageText().contains("Connecting"));
    }

    @Test
    public void connectFormRejectsAWrongToken() {
        app.fill("Server URL", serverUrl);
        app.fill("Access token", "not-the-token");
        app.click("button", "Connect");
        app.waitFor("a refusal", "document.querySelector('[role=status]') && /token|unauthori|401|reject|invalid/i.test(document.querySelector('[role=status]').textContent)", 15000);
        assertFalse(app.truthy("__pt.find('button','Disconnect')"));
    }

    @Test
    public void shareOpensTheNewTaskSheetPrefilled() {
        connect();
        share("A shared page", "Read this https://example.com/article please");
        app.waitFor("the new task sheet", "__pt.find('dialog','New task')", 20000);
        app.waitFor("the title", "__pt.find('textbox','New task name').value==='A shared page'", 10000);
        assertEquals("\"Read this https://example.com/article please\"", app.fieldValue("Notes"));
    }

    @Test
    public void textOnlyShareUsesItsFirstLineAsTheTitle() {
        connect();
        share(null, "Pick up the parcel\nbefore Friday");
        app.waitFor("the new task sheet", "__pt.find('dialog','New task')", 20000);
        app.waitFor("the title", "__pt.find('textbox','New task name').value==='Pick up the parcel'", 10000);
    }

    @Test
    public void aSecondShareWhileTheSheetIsOpenReseedsTheDraft() {
        connect();
        share("First share", "first body");
        app.waitFor("the first draft", "__pt.find('textbox','New task name')&&__pt.find('textbox','New task name').value==='First share'", 20000);

        // The owner has started editing the first draft.
        app.fill("New task name", "First share, edited");
        assertEquals("\"First share, edited\"", app.fieldValue("New task name"));

        share("Second share", "second body");
        app.waitFor("the reseeded draft", "__pt.find('textbox','New task name').value==='Second share'", 20000);
        assertEquals("\"second body\"", app.fieldValue("Notes"));
    }

    @Test
    public void remindersAreScheduledForADueTaskAndClearedWhenTurnedOff() throws Exception {
        connect();
        String title = "Android reminder " + System.currentTimeMillis();
        // A task due in three days, written through the same API the dashboard uses, from the page
        // itself so the request also proves the server answers the app's origin.
        String create = "fetch(" + WebAppDriver.quote(serverUrl + "/api/tasks") + ",{method:'POST',headers:{"
            + "'Authorization':'Bearer '+" + WebAppDriver.quote(apiToken) + ",'Content-Type':'application/json'},"
            + "body:JSON.stringify({title:" + WebAppDriver.quote(title) + ",dueAt:(d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'))(new Date(Date.now()+3*86400000))})})"
            + ".then(r=>r.status)";
        assertEquals("201", app.evalAsync(create, 15000));
        // Nothing is scheduled until the owner asks.
        assertEquals(0, app.pendingNotifications().length());

        openConnectionSettings();
        app.click("checkbox", "Remind me on the day a task is due");

        JSONArray pending = waitForPending(title, true);
        JSONObject reminder = findByTitle(pending, title);
        assertEquals("Due today", reminder.getString("body"));
        assertTrue(reminder.getJSONObject("extra").getString("taskId").startsWith("t_"));

        // The alarm itself must be allowed while the device idles. (That it is inexact is what
        // keeps schedule() from opening system settings; nativeApp.test.js covers the flag.)
        String alarms = shell("dumpsys alarm");
        String ours = alarmBlock(alarms);
        assertTrue("No alarm for the app in dumpsys alarm:\n" + alarms, ours != null);
        assertTrue("Expected an allow-while-idle alarm:\n" + ours, ours.contains("ALLOW_WHILE_IDLE"));

        app.click("checkbox", "Remind me on the day a task is due");
        waitForPending(title, false);
        assertEquals(0, app.pendingNotifications().length());
    }

    private JSONArray waitForPending(String title, boolean expected) throws Exception {
        long end = System.currentTimeMillis() + 30000;
        JSONArray pending = app.pendingNotifications();
        while (System.currentTimeMillis() < end) {
            pending = app.pendingNotifications();
            if ((findByTitle(pending, title) != null) == expected) return pending;
            WebAppDriver.sleep(500);
        }
        throw new AssertionError("Pending reminders never " + (expected ? "contained" : "dropped") + " \"" + title + "\": " + pending);
    }

    private static JSONObject findByTitle(JSONArray list, String title) throws Exception {
        for (int i = 0; i < list.length(); i++) {
            JSONObject item = list.getJSONObject(i);
            if (title.equals(item.optString("title"))) return item;
        }
        return null;
    }

    private static String shell(String command) throws Exception {
        try (java.io.InputStream in = new android.os.ParcelFileDescriptor.AutoCloseInputStream(
            InstrumentationRegistry.getInstrumentation().getUiAutomation().executeShellCommand(command))) {
            return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    // The lines of dumpsys alarm that belong to this app's pending alarms.
    private static String alarmBlock(String dump) {
        StringBuilder out = new StringBuilder();
        String[] lines = dump.split("\n");
        for (int i = 0; i < lines.length; i++) {
            if (lines[i].contains("com.okstudio.polaris") && lines[i].contains("Alarm{")) {
                for (int j = i; j < Math.min(lines.length, i + 12); j++) out.append(lines[j]).append('\n');
            }
        }
        return out.length() == 0 ? null : out.toString();
    }
}

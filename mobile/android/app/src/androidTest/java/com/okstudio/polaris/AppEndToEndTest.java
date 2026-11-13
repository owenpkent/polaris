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
import android.view.MotionEvent;
import android.os.SystemClock;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
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
        startAsAFirstLaunch();
        // A device with nothing saved starts in local mode on My tasks, where the banner's Connect
        // button opens the Connection tab with the form.
        app.waitFor("the not-connected banner", "!window.__ptOld&&document.body.innerText.includes('Not connected yet')", LOAD_MS);
        app.click("button", "Connect");
        app.waitFor("the connect form", "__pt.find('textbox','Server URL')", LOAD_MS);
    }

    // The key under which the dashboard saves the server URL and token (ConnectionContext.jsx).
    private static final String CONNECTION_KEY = "cc-connection-v1";

    // Clears the page's storage and reloads it, so the page under test starts with nothing saved.
    // The page that was just launched loads the connection the previous test saved and re-checks
    // it in the background, and that check writes the connection back when the server answers.
    // One clear raced it on CI's slower emulator and the reloaded page came up connected, so the
    // clear is repeated until the saved connection stays away, and the fresh page is checked too.
    private void startAsAFirstLaunch() {
        for (int attempt = 0; attempt < 3; attempt++) {
            clearStorageUntilItStaysClear();
            // cancelAll, not cancel with whatever is pending: the plugin rejects cancel when the
            // list is empty, which it is on every fresh launch. (The dashboard's own
            // cancelAllNotifications skips the call in that case; nativeApp.test.js covers it.)
            app.evalAsync("window.Capacitor.nativePromise('LocalNotifications','cancelAll',{})", 10000);
            // The old page is marked so the waits cannot pass on it: when the previous test never
            // connected, it already shows the banner that the fresh page is waited for.
            app.eval("window.__ptOld=true;location.reload();null");
            app.waitFor("the reloaded page", "!window.__ptOld&&document.readyState==='complete'&&window.Capacitor&&document.body.innerText.length>0", LOAD_MS);
            if (!app.truthy("localStorage.getItem(" + WebAppDriver.quote(CONNECTION_KEY) + ")")) return;
        }
        throw new AssertionError("The saved connection came back after every clear of localStorage.");
    }

    private void clearStorageUntilItStaysClear() {
        long end = System.currentTimeMillis() + 10000;
        long clearSince = -1;
        while (System.currentTimeMillis() < end) {
            if (app.truthy("localStorage.getItem(" + WebAppDriver.quote(CONNECTION_KEY) + ")")) {
                app.eval("localStorage.clear();null");
                clearSince = -1;
            } else if (clearSince < 0) {
                app.eval("localStorage.clear();null");
                clearSince = System.currentTimeMillis();
            } else if (System.currentTimeMillis() - clearSince >= 1500) {
                return;
            }
            WebAppDriver.sleep(100);
        }
        throw new AssertionError("The saved connection kept being written back to localStorage.");
    }

    // Submits the connection form by its own button. The banner above the form has a Connect
    // button too, and it comes first in the page, so the form's is found under the form.
    private void submitConnectForm() {
        app.eval("__pt.find('button','Connect',__pt.find('textbox','Server URL').form).click()");
    }

    @After
    public void closeTheApp() {
        if (scenario != null) scenario.close();
    }

    private void connect() {
        app.fill("Server URL", serverUrl);
        app.fill("Access token", apiToken);
        submitConnectForm();
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
        submitConnectForm();
        // Any status region: the not-connected banner above the form is one too.
        app.waitFor("a refusal", "Array.from(document.querySelectorAll('[role=status]')).some(el=>/token|unauthori|401|reject|invalid/i.test(el.textContent))", 15000);
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

        // The alarm itself must be allowed while the device idles. The plugin sets an RTC_WAKEUP
        // alarm only on its allow-while-idle paths and a plain RTC one otherwise, and dumpsys
        // prints the alarm's flags as a hex number, so the type is the evidence. (That it is
        // inexact is what keeps schedule() from opening system settings; nativeApp.test.js covers
        // the flag.)
        String alarms = shell("dumpsys alarm");
        String ours = alarmBlock(alarms);
        assertTrue("No alarm for the app in dumpsys alarm:\n" + alarms, ours != null);
        assertTrue("Expected an allow-while-idle (RTC_WAKEUP) alarm:\n" + ours, ours.contains("RTC_WAKEUP"));

        app.click("checkbox", "Remind me on the day a task is due");
        waitForPending(title, false);
        assertEquals(0, app.pendingNotifications().length());
    }

    // The soft keyboard must not cover the Add subtask box while a list is typed. The task has
    // enough subtasks that the box sits low in the panel; the box is opened with a real touch so
    // the keyboard comes up, then four subtasks are typed with Enter, and after each the box has
    // to lie inside the visible area, by the page's visual viewport and by the window's IME inset.
    @Test
    public void subtaskBoxStaysAboveTheKeyboardWhileTyping() throws Exception {
        connect();
        String title = "Keyboard subtasks " + System.currentTimeMillis();
        String headers = "{'Authorization':'Bearer '+" + WebAppDriver.quote(apiToken) + ",'Content-Type':'application/json'}";
        String create = "fetch(" + WebAppDriver.quote(serverUrl + "/api/tasks") + ",{method:'POST',headers:" + headers
            + ",body:JSON.stringify({title:" + WebAppDriver.quote(title) + "})}).then(r=>r.json()).then(t=>{const id=t.id||(t.task&&t.task.id);"
            + "return Promise.all(Array.from({length:14},(_,i)=>fetch(" + WebAppDriver.quote(serverUrl + "/api/tasks") + ",{method:'POST',headers:" + headers
            + ",body:JSON.stringify({title:'Existing step '+(i+1),parentId:id})}))).then(rs=>rs.map(r=>r.status).join(','));})";
        String statuses = app.evalAsync(create, 30000);
        assertTrue("Subtask create failed: " + statuses, statuses.replace("\"", "").matches("2\\d\\d(,2\\d\\d){13}"));

        // The old page is marked, as in clearConnection, so the wait cannot pass before the reload.
        app.eval("window.__ptOld=true;location.reload();null");
        app.waitFor("the reload", "!window.__ptOld&&document.readyState==='complete'&&window.Capacitor&&__pt.find('button','Open navigation')", LOAD_MS);
        app.click("button", "Open navigation");
        app.waitFor("the navigation drawer", "__pt.find('dialog','Navigation')", 10000);
        app.click("button", "My tasks");
        // The new task has no due date, so it is in a group that may start collapsed.
        app.waitFor("the No due date group", "__pt.find('button','No due date')||__pt.find('button'," + WebAppDriver.quote(title) + ")", LOAD_MS);
        if (!app.truthy("__pt.find('button'," + WebAppDriver.quote(title) + ")")) app.click("button", "No due date");
        app.waitFor("the task row", "__pt.find('button'," + WebAppDriver.quote(title) + ")", LOAD_MS);
        app.click("button", "Open " + title);
        app.waitFor("the task panel with its subtasks", "__pt.find('dialog','Task details')&&document.body.innerText.includes('Existing step 14')", LOAD_MS);

        // The Add subtask row at the end of the list, scrolled into view and then touched.
        String row = "Array.from(document.querySelectorAll('[role=dialog] button')).filter(b=>b.textContent.trim()==='Add subtask').pop()";
        app.waitFor("the Add subtask row", row, 10000);
        app.eval(row + ".scrollIntoView({block:'center'});null");
        WebAppDriver.sleep(500);
        tapElement(row);
        app.waitFor("the subtask box", "document.activeElement&&document.activeElement.getAttribute('aria-label')==='Subtask name'", 10000);
        waitForKeyboard(true);

        for (int i = 1; i <= 4; i++) {
            InstrumentationRegistry.getInstrumentation().sendStringSync("step" + i);
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_ENTER);
            app.waitFor("subtask " + i + " to be added", "document.body.innerText.toLowerCase().includes('step" + i + "')&&document.body.innerText.includes('0 / " + (14 + i) + "')", 15000);
            WebAppDriver.sleep(800);
            assertBoxAboveKeyboard(i);
        }
    }

    // The tab bar and the New task button step aside while the soft keyboard is open
    // (src/keyboard.js), and come back once it is put away with Back, the field still focused.
    @Test
    public void tabBarStepsAsideWhileTheKeyboardIsOpen() throws Exception {
        connect();
        // A task of its own, so the list has a group with an Add task row on a fresh database.
        String headers = "{'Authorization':'Bearer '+" + WebAppDriver.quote(apiToken) + ",'Content-Type':'application/json'}";
        String create = "fetch(" + WebAppDriver.quote(serverUrl + "/api/tasks") + ",{method:'POST',headers:" + headers
            + ",body:JSON.stringify({title:'Keyboard tab bar " + System.currentTimeMillis() + "'})}).then(r=>String(r.status))";
        assertTrue("Task create failed", app.evalAsync(create, 15000).replace("\"", "").startsWith("2"));
        app.click("button", "Open navigation");
        app.waitFor("the navigation drawer", "__pt.find('dialog','Navigation')", 10000);
        app.click("button", "My tasks");
        // The new task has no due date, so it is in a group that may start collapsed.
        app.waitFor("the No due date group", "__pt.find('button','No due date')", LOAD_MS);
        if (!app.truthy("__pt.find('button','Add task')")) app.click("button", "No due date");
        String nav = "document.querySelector('nav[aria-label=\"Primary\"]')";
        String navShown = nav + "&&getComputedStyle(" + nav + ").display!=='none'";
        app.waitFor("the tab bar", navShown, LOAD_MS);

        String row = "__pt.find('button','Add task')";
        app.waitFor("an Add task row", row, LOAD_MS);
        app.eval(row + ".scrollIntoView({block:'center'});null");
        WebAppDriver.sleep(500);
        tapElement(row);
        app.waitFor("the new task box", "document.activeElement&&document.activeElement.getAttribute('aria-label')==='New task name'", 10000);
        waitForKeyboard(true);
        app.waitFor("the tab bar to step aside", "document.documentElement.dataset.keyboard==='open'&&!(" + navShown + ")", 10000);

        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
        waitForKeyboard(false);
        app.waitFor("the tab bar to come back", "document.documentElement.dataset.keyboard!=='open'&&(" + navShown + ")", 10000);
    }

    // Creates a task due today through the API, from the page as the dashboard does, then reloads
    // and opens My tasks so the row is on screen. Returns nothing: the row is found by its title.
    private void seedTaskDueTodayAndOpenMyTasks(String title) {
        String headers = "{'Authorization':'Bearer '+" + WebAppDriver.quote(apiToken) + ",'Content-Type':'application/json'}";
        String create = "fetch(" + WebAppDriver.quote(serverUrl + "/api/tasks") + ",{method:'POST',headers:" + headers
            + ",body:JSON.stringify({title:" + WebAppDriver.quote(title) + ",dueAt:(d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'))(new Date())})})"
            + ".then(r=>String(r.status))";
        assertTrue("Task create failed", app.evalAsync(create, 15000).replace("\"", "").startsWith("2"));
        // The old page is marked so the wait cannot pass before the reload brings the new task in.
        app.eval("window.__ptOld=true;location.reload();null");
        app.waitFor("the reload", "!window.__ptOld&&document.readyState==='complete'&&window.Capacitor&&__pt.find('button','Open navigation')", LOAD_MS);
        app.click("button", "Open navigation");
        app.waitFor("the navigation drawer", "__pt.find('dialog','Navigation')", 10000);
        app.click("button", "My tasks");
        app.waitFor("the task row", "__pt.find('button'," + WebAppDriver.quote("Change due date for " + title) + ")", LOAD_MS);
    }

    // On a phone the due date sits at the right of the task name, not in a column (the emulator
    // and the owner's phone are 412 CSS px wide; under 380 it goes under the name). A long name
    // must wrap in full, the date button must be to the right of its words and level with their
    // middle, so the room above and under it is the same, and it must be a real 44px touch target
    // that a finger opens the picker with.
    @Test
    public void phoneRowPutsTheDateBesideAWrappedName() throws Exception {
        connect();
        String title = "Phone row " + System.currentTimeMillis()
            + " with a deliberately long name that has to wrap over several lines on a narrow screen without being cut";
        seedTaskDueTodayAndOpenMyTasks(title);

        String name = "__pt.find('button'," + WebAppDriver.quote("Rename " + title) + ")";
        String date = "__pt.find('button'," + WebAppDriver.quote("Change due date for " + title) + ")";
        String nameText = name + ".querySelector('span')";
        app.eval(date + ".scrollIntoView({block:'center'});null");
        WebAppDriver.sleep(500);

        // Nothing cut: the whole title is in the button, and it is not wider than its box.
        assertTrue("Name text is not the full title", app.truthy(nameText + ".textContent==="
            + WebAppDriver.quote(title)));
        assertTrue("Name button is cut off horizontally", app.truthy(name + ".scrollWidth<=" + name + ".clientWidth+1"));
        // A line clamp keeps the whole title in textContent while showing two lines of it, so the
        // name and its button must also show all of their height.
        assertTrue("Name text is cut off vertically", app.truthy(nameText + ".scrollHeight<=" + nameText + ".clientHeight+1"));
        assertTrue("Name button is cut off vertically", app.truthy(name + ".scrollHeight<=" + name + ".clientHeight+1"));
        assertTrue("Name does not wrap onto several lines", app.truthy(nameText + ".getBoundingClientRect().height>"
            + "1.5*parseFloat(getComputedStyle(" + nameText + ").lineHeight)"));

        String[] n = rect(nameText);
        String[] d = rect(date);
        String report = "name text " + String.join(",", n) + "; date button " + String.join(",", d);
        android.util.Log.i("PhoneRowTest", report);
        assertTrue("Date button is not level with the middle of the name, " + report,
            Math.abs((Float.parseFloat(d[1]) + Float.parseFloat(d[3])) - (Float.parseFloat(n[1]) + Float.parseFloat(n[3]))) <= 4);
        assertTrue("Date button is not to the right of the name text, " + report,
            Float.parseFloat(d[0]) >= Float.parseFloat(n[2]) - 1);
        assertTrue("Date button is under 44px wide, " + report, Float.parseFloat(d[2]) - Float.parseFloat(d[0]) >= 43.5f);
        assertTrue("Date button is under 44px tall, " + report, Float.parseFloat(d[3]) - Float.parseFloat(d[1]) >= 43.5f);

        // A real finger opens the picker, which on a phone is a sheet named for the task.
        tapElement(date);
        app.waitFor("the date picker", "__pt.find('dialog'," + WebAppDriver.quote("Due date for " + title) + ")", 10000);
        // Esc closes it without saving, as it does for a keyboard user.
        app.eval("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));null");
        app.waitFor("the date picker to close", "!__pt.find('dialog'," + WebAppDriver.quote("Due date for " + title) + ")", 10000);
    }

    // Choosing No date from a Today row moves the task to the No due date group, and the toast that
    // says so must be fully on screen above the tab bar (the app's insets differ from a browser's),
    // must not be covered by the floating New task button, and must not take focus. View then
    // scrolls to the task and focuses its Open button.
    @Test
    public void moveToastSitsAboveTheTabBarAndViewFindsTheTask() throws Exception {
        connect();
        String title = "Move toast " + System.currentTimeMillis();
        seedTaskDueTodayAndOpenMyTasks(title);

        String date = "__pt.find('button'," + WebAppDriver.quote("Change due date for " + title) + ")";
        app.eval(date + ".scrollIntoView({block:'center'});null");
        WebAppDriver.sleep(500);
        tapElement(date);
        app.waitFor("the date picker", "__pt.find('dialog'," + WebAppDriver.quote("Due date for " + title) + ")", 10000);
        app.click("button", "No date");

        String where = "No due date";
        String view = "__pt.find('button'," + WebAppDriver.quote("View " + title + " in " + where) + ")";
        String undo = "__pt.find('button'," + WebAppDriver.quote("Undo moving " + title + " to " + where) + ")";
        app.waitFor("the move toast", view + "&&" + undo, 15000);
        assertTrue("The toast does not say where the task went", app.truthy("document.querySelector('.undo-toast').textContent.includes("
            + WebAppDriver.quote("Moved " + title + " to " + where) + ")"));

        String nav = "document.querySelector('nav[aria-label=\"Primary\"]')";
        // The toast lasts six seconds, so everything is measured in one page call.
        String measure = "(()=>{const vv=window.visualViewport;const navTop=" + nav + ".getBoundingClientRect().top;"
            + "const out=[];for(const b of [" + view + "," + undo + "]){const r=b.getBoundingClientRect();"
            + "const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);"
            + "out.push([r.left>=vv.offsetLeft-0.5,r.right<=vv.offsetLeft+vv.width+0.5,r.top>=vv.offsetTop-0.5,r.bottom<=vv.offsetTop+vv.height+0.5,"
            + "r.bottom<=navTop+0.5,hit===b||b.contains(hit)].join(':')+'@'+[r.left,r.top,r.right,r.bottom].join(','));}"
            + "out.push('navTop='+navTop+';vvH='+(vv.offsetTop+vv.height));"
            + "out.push('focusInToast='+Boolean(document.activeElement&&document.activeElement.closest('.undo-toast-region')));"
            + "return out.join('|')})()";
        String result = app.eval(measure).replace("\"", "");
        android.util.Log.i("MoveToastTest", result);
        String[] parts = result.split("\\|");
        for (int i = 0; i < 2; i++) {
            String label = i == 0 ? "View" : "Undo";
            assertTrue(label + " is not inside the viewport, above the tab bar and uncovered: " + result,
                parts[i].startsWith("true:true:true:true:true:true@"));
        }
        assertTrue("Focus moved into the toast: " + result, parts[3].equals("focusInToast=false"));

        // Pressing View scrolls to the task and focuses its Open button, which is on screen.
        app.click("button", "View " + title + " in " + where);
        String open = "__pt.find('button'," + WebAppDriver.quote("Open " + title) + ")";
        app.waitFor("Open to be focused", "document.activeElement===" + open, 10000);
        assertTrue("Open button is outside the viewport", app.truthy("(()=>{const r=" + open + ".getBoundingClientRect();const vv=window.visualViewport;"
            + "return r.top>=vv.offsetTop-0.5&&r.bottom<=vv.offsetTop+vv.height+0.5&&r.left>=0&&r.right<=vv.offsetLeft+vv.width+0.5})()"));
    }

    private static final String BOX = "document.querySelector('[role=dialog] input[aria-label=\"Subtask name\"]')";

    // A real touch at the middle of an element, injected as the system would, so focus and the
    // soft keyboard behave as they do for the owner. The injection only reaches the app's own
    // windows: when a system window is on top (on a slow CI emulator, an "isn't responding"
    // dialog or the notification shade), Android refuses it with "Targeted input event injection
    // ... was not directed at a window owned by" the app. So system dialogs are closed first, and a
    // refused touch is tried again after closing them, up to TAP_ATTEMPTS times, naming the window
    // that was in the way if it never gets through.
    private static final int TAP_ATTEMPTS = 3;

    private void tapElement(String elementExpression) {
        RuntimeException refused = null;
        for (int attempt = 1; attempt <= TAP_ATTEMPTS; attempt++) {
            closeSystemDialogs();
            String[] r = rect(elementExpression);
            int[] origin = webViewOrigin();
            float x = origin[0] + (Float.parseFloat(r[0]) + Float.parseFloat(r[2])) / 2f * Float.parseFloat(r[4]);
            float y = origin[1] + (Float.parseFloat(r[1]) + Float.parseFloat(r[3])) / 2f * Float.parseFloat(r[4]);
            long down = SystemClock.uptimeMillis();
            android.app.Instrumentation inst = InstrumentationRegistry.getInstrumentation();
            try {
                inst.sendPointerSync(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0));
                inst.sendPointerSync(MotionEvent.obtain(down, down + 80, MotionEvent.ACTION_UP, x, y, 0));
                return;
            } catch (SecurityException | IllegalArgumentException e) {
                refused = e;
                WebAppDriver.sleep(1000);
            }
        }
        throw new AssertionError("The touch was refused " + TAP_ATTEMPTS + " times; window in front: " + focusedWindows(), refused);
    }

    private static String focusedWindows() {
        StringBuilder out = new StringBuilder();
        try {
            for (String line : shell("dumpsys window displays").split("\n")) {
                if (line.contains("mCurrentFocus") || line.contains("mFocusedApp")) out.append(line.trim()).append("; ");
            }
        } catch (Exception e) {
            return "(could not read: " + e.getMessage() + ")";
        }
        return out.length() > 0 ? out.toString() : "(none reported)";
    }

    // As the shell user, which may close system dialogs where the app may not.
    private static void closeSystemDialogs() {
        try {
            shell("am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS");
        } catch (Exception e) {
            // Nothing to close, or the broadcast was refused: the touch is tried anyway.
        }
    }

    // left, top, right, bottom in CSS px, then the device pixel ratio.
    private String[] rect(String elementExpression) {
        String json = app.eval("(()=>{const r=(" + elementExpression + ").getBoundingClientRect();return [r.left,r.top,r.right,r.bottom,window.devicePixelRatio].join(',')})()");
        return json.replace("\"", "").split(",");
    }

    private int[] webViewOrigin() {
        int[] xy = new int[2];
        scenario.onActivity(a -> ((com.getcapacitor.BridgeActivity) a).getBridge().getWebView().getLocationOnScreen(xy));
        return xy;
    }

    private int[] imeAndScreen() {
        int[] out = new int[3];
        scenario.onActivity(a -> {
            android.view.View decor = a.getWindow().getDecorView();
            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
            boolean visible = insets != null && insets.isVisible(WindowInsetsCompat.Type.ime());
            out[0] = visible ? 1 : 0;
            out[1] = visible ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
            out[2] = decor.getHeight();
        });
        return out;
    }

    private void waitForKeyboard(boolean expected) {
        long end = System.currentTimeMillis() + 15000;
        while (System.currentTimeMillis() < end) {
            if ((imeAndScreen()[0] == 1) == expected) return;
            WebAppDriver.sleep(250);
        }
        throw new AssertionError("The soft keyboard never " + (expected ? "appeared" : "went away") + " after a real tap on the subtask box.");
    }

    private void assertBoxAboveKeyboard(int step) {
        assertTrue("The keyboard went away after subtask " + step, imeAndScreen()[0] == 1);
        int[] ime = imeAndScreen();
        String[] r = rect(BOX);
        float dpr = Float.parseFloat(r[4]);
        float top = Float.parseFloat(r[1]);
        float bottom = Float.parseFloat(r[3]);
        float vvBottom = Float.parseFloat(app.eval("window.visualViewport.offsetTop+window.visualViewport.height"));
        int[] origin = webViewOrigin();
        float imeTopCss = (ime[2] - ime[1] - origin[1]) / dpr;
        String report = "after subtask " + step + ": box top " + top + " bottom " + bottom + " css px; visualViewport bottom "
            + vvBottom + "; IME top " + imeTopCss + " (inset " + ime[1] + " px of " + ime[2] + ", dpr " + dpr + ")";
        android.util.Log.i("KeyboardTest", report);
        assertTrue("Box above the visual viewport bottom, " + report, bottom <= vvBottom + 1);
        assertTrue("Box above the keyboard, " + report, bottom <= imeTopCss + 1);
        assertTrue("Box below the top of the page, " + report, top >= 0);
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

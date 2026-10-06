package com.okstudio.polaris;

import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;

import com.getcapacitor.BridgeActivity;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

// Drives the dashboard inside the app's WebView from a test. Everything goes through
// evaluateJavascript on the Capacitor bridge's own WebView, so the page is exactly the one the
// owner sees. Elements are found the way the dashboard's Playwright tests find them, by role and
// accessible name (an aria-label, an associated label, or the visible text), never by CSS class.
// The finders below are a small subset of that: enough for the controls these tests touch.
final class WebAppDriver {
    private static final long POLL_MS = 250;

    // Finds elements by role and accessible name. Installed on window on every call so a page
    // reload never leaves the tests without it.
    private static final String FINDERS =
        "(function(){if(window.__pt)return;"
            + "const norm=s=>(s||'').replace(/\\s+/g,' ').trim();"
            + "const name=el=>{const a=el.getAttribute('aria-label');if(a)return norm(a);"
            + "const by=el.getAttribute('aria-labelledby');"
            + "if(by){const t=by.split(' ').map(i=>document.getElementById(i)).filter(Boolean).map(n=>n.textContent).join(' ');if(t)return norm(t);}"
            + "if(el.id){const l=document.querySelector('label[for=\"'+el.id+'\"]');if(l)return norm(l.textContent);}"
            + "const w=el.closest('label');if(w)return norm(w.textContent);"
            + "return norm(el.textContent);};"
            + "const visible=el=>el.getClientRects().length>0;"
            + "const sel={button:'button,[role=button]',checkbox:'input[type=checkbox]',textbox:'input:not([type=checkbox]):not([type=date]):not([type=time]),textarea',dialog:'[role=dialog]'};"
            + "window.__pt={find:(role,n)=>Array.from(document.querySelectorAll(sel[role])).filter(visible).find(el=>name(el)===n)||null,"
            + "set:(el,v)=>{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;"
            + "Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));}};"
            + "})();";

    private final ActivityScenario<MainActivity> scenario;

    WebAppDriver(ActivityScenario<MainActivity> scenario) {
        this.scenario = scenario;
    }

    private WebView webView() {
        AtomicReference<WebView> ref = new AtomicReference<>();
        scenario.onActivity(activity -> ref.set(((BridgeActivity) activity).getBridge().getWebView()));
        return ref.get();
    }

    /** Evaluates a JavaScript expression and returns its JSON text ("null" when it has no value). */
    String eval(String script) {
        WebView view = webView();
        AtomicReference<String> out = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        view.post(() -> view.evaluateJavascript(FINDERS + "\n" + script, value -> {
            out.set(value);
            done.countDown();
        }));
        try {
            if (!done.await(10, TimeUnit.SECONDS)) throw new AssertionError("The page did not answer: " + script);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
        return out.get();
    }

    boolean truthy(String expression) {
        String value = eval("Boolean(" + expression + ")");
        return "true".equals(value);
    }

    /** Polls an expression until it is true, or fails with `what` after the timeout. */
    void waitFor(String what, String expression, long timeoutMs) {
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            if (truthy(expression)) return;
            sleep(POLL_MS);
        }
        throw new AssertionError("Timed out waiting for " + what + " (" + expression + "); page text: " + pageText());
    }

    String pageText() {
        String text = eval("document.body ? document.body.innerText.slice(0, 600) : ''");
        return text == null ? "" : text;
    }

    static String quote(String value) {
        return JSONObject.quote(value);
    }

    void waitForButton(String name, long timeoutMs) {
        waitFor("button \"" + name + "\"", "__pt.find('button'," + quote(name) + ")", timeoutMs);
    }

    void click(String role, String name) {
        waitFor(role + " \"" + name + "\"", "__pt.find(" + quote(role) + "," + quote(name) + ")", 15000);
        eval("__pt.find(" + quote(role) + "," + quote(name) + ").click()");
    }

    void fill(String name, String value) {
        waitFor("field \"" + name + "\"", "__pt.find('textbox'," + quote(name) + ")", 15000);
        eval("__pt.set(__pt.find('textbox'," + quote(name) + ")," + quote(value) + ")");
    }

    String fieldValue(String name) {
        return eval("(__pt.find('textbox'," + quote(name) + ")||{}).value");
    }

    /**
     * Runs an async script that ends in a promise and returns its value as JSON. The result is
     * parked on window and polled, because evaluateJavascript does not wait for promises.
     */
    String evalAsync(String promiseExpression, long timeoutMs) {
        eval("window.__ptr=undefined;(" + promiseExpression + ").then("
            + "v=>{window.__ptr=JSON.stringify({v:v===undefined?null:v});},"
            + "e=>{window.__ptr=JSON.stringify({e:String(e&&e.message||e)});});null");
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            String raw = eval("window.__ptr===undefined?null:window.__ptr");
            if (raw != null && !"null".equals(raw)) {
                try {
                    // evaluateJavascript wraps a JS string in JSON quotes, so unwrap once.
                    String inner = new JSONArray("[" + raw + "]").getString(0);
                    JSONObject result = new JSONObject(inner);
                    if (result.has("e")) throw new AssertionError("Script failed: " + result.getString("e"));
                    return result.isNull("v") ? "null" : String.valueOf(result.get("v"));
                } catch (JSONException e) {
                    throw new AssertionError(e);
                }
            }
            sleep(POLL_MS);
        }
        throw new AssertionError("Timed out waiting for " + promiseExpression);
    }

    /** The reminders the LocalNotifications plugin has pending, by the same call the dashboard makes. */
    JSONArray pendingNotifications() {
        String raw = evalAsync(
            "window.Capacitor.nativePromise('LocalNotifications','getPending',{}).then(r=>r.notifications||[])", 10000);
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            throw new AssertionError(e);
        }
    }

    static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }
}

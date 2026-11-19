package com.okstudio.polaris;

import android.content.res.Configuration;
import android.view.View;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Colours the app window behind the page, for a WebView too old to draw the page under the status
// bar and the gesture bar (docs/phone-keyboard-and-system-bars.md). There Capacitor's SystemBars
// plugin pads the window, and the strips behind the bars show the window's own background, which
// comes from the Android theme and follows the phone's light or dark setting. The dashboard has a
// theme of its own, so it hands over the colour of its top bar and tab bar (applyTheme in
// src/theme.js) and the strips match it, as they do where the page is drawn under the bars.
//
// SystemBars puts the theme's background back every time it sets the bars' style, and it does so
// again on every configuration change (the phone turned, or its dark setting switched). So the
// page calls this after it sets the style, and after a configuration change the colour is put
// back once the plugins have all been told.
//
// The one thing a page can do with this is paint the window an opaque colour of its choosing.
@CapacitorPlugin(name = "AppWindow")
public class AppWindowPlugin extends Plugin {
    // The colour the page last asked for, or null before it has asked.
    private Integer colour;

    @PluginMethod
    public void setBackground(PluginCall call) {
        Integer parsed = parseColour(call.getString("color"));
        if (parsed == null) {
            call.reject("The colour has to be six hex digits after a #.");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            colour = parsed;
            apply();
            call.resolve();
        });
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        if (colour == null || getActivity() == null) return;
        // Posted, so it runs after SystemBars has put the theme's background back, whichever of
        // the two plugins is told of the change first.
        View decor = getActivity().getWindow().getDecorView();
        decor.post(this::apply);
    }

    private void apply() {
        if (colour == null || getActivity() == null) return;
        getActivity().getWindow().getDecorView().setBackgroundColor(colour);
    }

    // "#RRGGBB" as an opaque ARGB colour, or null for anything else: a name, a short form, a
    // colour with an alpha part, or nothing. Plain arithmetic, so it runs in a JVM unit test.
    static Integer parseColour(String value) {
        if (value == null || value.length() != 7 || value.charAt(0) != '#') return null;
        int rgb = 0;
        for (int i = 1; i < 7; i++) {
            int digit = Character.digit(value.charAt(i), 16);
            // Character.digit takes digits of other scripts too; only ASCII ones are wanted.
            if (digit < 0 || value.charAt(i) > 'f') return null;
            rgb = (rgb << 4) | digit;
        }
        return 0xFF000000 | rgb;
    }
}

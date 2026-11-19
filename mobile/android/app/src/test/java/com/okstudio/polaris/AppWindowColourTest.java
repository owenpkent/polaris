package com.okstudio.polaris;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

// AppWindowPlugin's one rule that needs no device: what counts as a colour.
public class AppWindowColourTest {
    @Test
    public void sixHexDigitsAreAnOpaqueColour() {
        assertEquals(Integer.valueOf(0xFF252931), AppWindowPlugin.parseColour("#252931"));
        assertEquals(Integer.valueOf(0xFFFCFCFD), AppWindowPlugin.parseColour("#fcfcfd"));
        assertEquals(Integer.valueOf(0xFFFCFCFD), AppWindowPlugin.parseColour("#FCFCFD"));
        assertEquals(Integer.valueOf(0xFF000000), AppWindowPlugin.parseColour("#000000"));
        assertEquals(Integer.valueOf(0xFFFFFFFF), AppWindowPlugin.parseColour("#ffffff"));
    }

    @Test
    public void anythingElseIsRefused() {
        assertNull(AppWindowPlugin.parseColour(null));
        assertNull(AppWindowPlugin.parseColour(""));
        assertNull(AppWindowPlugin.parseColour("252931"));
        assertNull(AppWindowPlugin.parseColour("#25293"));
        assertNull(AppWindowPlugin.parseColour("#2529311"));
        assertNull(AppWindowPlugin.parseColour("#fff"));
        // An alpha part would let the window show through to whatever is behind the app.
        assertNull(AppWindowPlugin.parseColour("#80252931"));
        assertNull(AppWindowPlugin.parseColour("#25293g"));
        assertNull(AppWindowPlugin.parseColour("#25 931"));
        assertNull(AppWindowPlugin.parseColour("#-25293"));
        assertNull(AppWindowPlugin.parseColour("red"));
        assertNull(AppWindowPlugin.parseColour("rgb(37, 41, 49)"));
        // Digits of another script are digits to Character.digit, and are not wanted here.
        assertNull(AppWindowPlugin.parseColour("#٢٥٢٩٣١"));
    }
}

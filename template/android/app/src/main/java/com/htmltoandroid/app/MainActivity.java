package com.htmltoandroid.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // HTML2ANDROID:FULLSCREEN
        // HTML2ANDROID:KEEP_SCREEN_ON
        // HTML2ANDROID:BACK_EXIT

        // Export bridge — expose window.AndroidBridge.saveFile(name, mime, base64)
        // so HTML5 apps can save JSON/CSV/PDF exports straight to Downloads.
        // Always on: apps that never call it are unaffected. The interface is
        // only visible to this app's own local content (JavascriptInterface is
        // restricted to @JavascriptInterface-annotated methods since API 17).
        try {
            android.webkit.WebView wv = getBridge() == null ? null : getBridge().getWebView();
            if (wv != null) {
                wv.addJavascriptInterface(new AndroidBridge(this), "AndroidBridge");
            }
        } catch (Throwable t) {
            // never let bridge setup break app startup
        }
    }
}

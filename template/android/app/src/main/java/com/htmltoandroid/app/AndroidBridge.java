package com.htmltoandroid.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Locale;

/**
 * window.AndroidBridge — file-export bridge for HTML5 apps.
 *
 * HTML5 games/apps written for wrapper runtimes commonly probe for
 * window.&lt;something&gt;.saveFile(name, mime, base64) and only fall back to
 * &lt;a download&gt; when no bridge exists — but Android WebView silently ignores
 * &lt;a download&gt; blob URLs, so without a bridge their Export buttons do nothing.
 *
 * This class implements the most common convention:
 *
 *   window.AndroidBridge.saveFile(filename, mime, base64)
 *
 * Caller contract (matches the popular JS shim):
 *   - success -> returns a truthy non-promise value (caller toasts "Saved")
 *   - failure -> throws (caller shows "Save failed: &lt;message&gt;")
 *
 * Where files go:
 *   - Android 10+ (API 29): MediaStore.Downloads — NO permission required
 *   - Android 8/9 (API 26-28): public Downloads folder via
 *     WRITE_EXTERNAL_STORAGE (declared with maxSdkVersion="28" in the
 *     manifest, requested at runtime on the first export)
 */
public class AndroidBridge {

    private static final String TAG = "AndroidBridge";
    private static final int PERMISSION_REQUEST = 0x6A76;

    private final Activity activity;

    public AndroidBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean saveFile(String filename, String mime, String base64) {
        // Runs on a WebView bridge thread (never the UI thread) — I/O is fine here.
        String name = sanitize(filename);
        if (name.isEmpty()) {
            throw new IllegalArgumentException("Missing file name");
        }
        if (base64 == null || base64.isEmpty()) {
            throw new IllegalArgumentException("Empty file content");
        }

        // tolerate callers that pass a full data URI instead of raw base64
        int comma = base64.indexOf(',');
        if (base64.startsWith("data:") && comma > 0) {
            base64 = base64.substring(comma + 1);
        }

        byte[] data;
        try {
            data = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("File content is not valid base64");
        }
        if (data.length == 0) {
            throw new IllegalArgumentException("File content is empty");
        }

        String type = (mime == null || mime.trim().isEmpty()) ? guessMime(name) : mime.trim();

        try {
            if (Build.VERSION.SDK_INT >= 29) {
                saveWithMediaStore(name, type, data);
            } else {
                saveLegacy(name, type, data);
            }
        } catch (IOException e) {
            Log.e(TAG, "saveFile failed: " + name, e);
            throw new RuntimeException("Could not write file: " + e.getMessage());
        }

        return true;
    }

    // ---------- Android 10+ : MediaStore (permission-free) ----------

    private void saveWithMediaStore(String name, String type, byte[] data) throws IOException {
        ContentResolver cr = activity.getContentResolver();

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, uniqueDisplayName(cr, name));
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IOException("system refused to create the Downloads entry");
        }

        try (OutputStream os = cr.openOutputStream(uri)) {
            if (os == null) throw new IOException("could not open the Downloads stream");
            os.write(data);
        } catch (IOException e) {
            try {
                cr.delete(uri, null, null); // no half-written leftovers
            } catch (Exception ignored) {
            }
            throw e;
        }
    }

    // ---------- Android 8/9 : direct write (needs runtime permission) ----------

    private void saveLegacy(String name, String type, byte[] data) throws IOException {
        if (activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            requestStoragePermission();
            throw new RuntimeException("storage permission needed — allow it and export again");
        }

        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("could not create the Downloads folder");
        }

        File out = uniqueFile(dir, name);
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(data);
        }

        // make it show up immediately in the system Downloads UI
        MediaScannerConnection.scanFile(
                activity, new String[]{out.getAbsolutePath()}, new String[]{type}, null);
    }

    private void requestStoragePermission() {
        activity.runOnUiThread(() -> {
            try {
                activity.requestPermissions(
                        new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                        PERMISSION_REQUEST);
                Toast.makeText(activity,
                        "Allow storage access, then tap Export again",
                        Toast.LENGTH_LONG).show();
            } catch (Exception ignored) {
            }
        });
    }

    // ---------- helpers ----------

    private static String sanitize(String filename) {
        if (filename == null) return "";
        String name = filename
                .replace('\u0000', ' ')
                .replace('/', '_')
                .replace('\\', '_')
                .replaceAll("[\\r\\n\\t]", " ")
                .trim();
        if (name.equals(".") || name.equals("..")) return "";
        return name;
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".csv")) return "text/csv";
        if (n.endsWith(".txt")) return "text/plain";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    /** "report.pdf" -> "report.pdf", "report (1).pdf", "report (2).pdf" ... */
    private String uniqueDisplayName(ContentResolver cr, String name) {
        String base = name;
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            base = name.substring(0, dot);
            ext = name.substring(dot);
        }

        String candidate = name;
        for (int i = 1; i <= 99; i++) {
            Cursor c = null;
            try {
                c = cr.query(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        new String[]{MediaStore.MediaColumns.DISPLAY_NAME},
                        MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                        new String[]{candidate}, null);
                if (c == null || !c.moveToFirst()) return candidate;
            } catch (Exception e) {
                return name; // query unavailable — let the system decide
            } finally {
                if (c != null) c.close();
            }
            candidate = base + " (" + i + ")" + ext;
        }
        return candidate;
    }

    private static File uniqueFile(File dir, String name) {
        String base = name;
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            base = name.substring(0, dot);
            ext = name.substring(dot);
        }
        File f = new File(dir, name);
        for (int i = 1; f.exists() && i <= 99; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
        }
        return f;
    }
}

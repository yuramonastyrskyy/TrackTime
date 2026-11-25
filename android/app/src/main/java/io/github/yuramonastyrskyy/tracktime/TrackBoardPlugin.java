package io.github.yuramonastyrskyy.tracktime;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;

/**
 * The LED time board over Bluetooth LE, for the app (its web view has no Web
 * Bluetooth). The page finds this as window.TrackTimeBoard; js/board.js uses
 * it instead of navigator.bluetooth when it is there.
 *
 * connect() asks for the Bluetooth permission if needed, scans for the board's
 * service (firmware: board/time_board/time_board.ino) and connects to the
 * first board found. write(text) sends the text to show. When the link drops
 * it reconnects by itself until disconnect(). State changes are pushed to the
 * page as window.__ttBoard({state, name, detail}).
 *
 * Plain @JavascriptInterface methods, like TrackCameraPlugin. Bump VERSION
 * when this interface changes.
 */
@SuppressLint("MissingPermission")
@CapacitorPlugin(name = "TrackBoard", requestCodes = { TrackBoardPlugin.PERM_CODE })
public class TrackBoardPlugin extends Plugin {

    static final int VERSION = 1;
    static final int PERM_CODE = 7102;
    static final UUID SERVICE = UUID.fromString("7a1e0001-5c2b-4d8e-9f00-7472616b7469");
    static final UUID TEXT = UUID.fromString("7a1e0002-5c2b-4d8e-9f00-7472616b7469");
    private static final long SCAN_MS = 15000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private BluetoothLeScanner scanner;
    private BluetoothDevice device;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic ch;
    private boolean wanted = false, scanning = false, writing = false;
    private String next = null;
    private String state = "off", name = "", detail = "";
    private int retry = 0;

    @Override
    public void load() {
        getBridge().getWebView().addJavascriptInterface(new Api(), "TrackTimeBoard");
    }

    // ---------- permission ----------

    private String[] perms() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return new String[] { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT };
        }
        return new String[] { Manifest.permission.ACCESS_FINE_LOCATION };
    }

    private boolean hasPerms() {
        for (String p : perms()) {
            if (ContextCompat.checkSelfPermission(getContext(), p) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    @Override
    protected void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != PERM_CODE) return;
        main.post(() -> {
            if (!wanted) return;
            if (hasPerms()) startScan();
            else { wanted = false; setState("off", "Bluetooth permission was not given. Allow Nearby devices for TrackTime in Android settings."); }
        });
    }

    // ---------- state to the page ----------

    private void setState(String s, String d) {
        state = s;
        detail = d == null ? "" : d;
        String json;
        try {
            JSONObject o = new JSONObject();
            o.put("state", state);
            o.put("name", name);
            o.put("detail", detail);
            json = o.toString();
        } catch (Exception e) { json = "{\"state\":\"" + state + "\"}"; }
        final String js = "window.__ttBoard && window.__ttBoard(" + json + ")";
        WebView wv = getBridge().getWebView();
        wv.post(() -> wv.evaluateJavascript(js, null));
    }

    // ---------- scan + connect (all on the main thread) ----------

    private void connect() {
        wanted = true;
        retry = 0;
        if (!hasPerms()) {
            setState("connecting", "Asking for Bluetooth permission…");
            ActivityCompat.requestPermissions(getActivity(), perms(), PERM_CODE);
            return;
        }
        startScan();
    }

    private void startScan() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            wanted = false;
            setState("off", "Bluetooth is off. Turn it on and tap Connect again.");
            return;
        }
        closeGatt();
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { wanted = false; setState("off", "Bluetooth isn't ready. Try again."); return; }
        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE)).build();
        ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        try {
            scanner.startScan(Collections.singletonList(filter), settings, scanCb);
        } catch (Exception e) {
            wanted = false;
            setState("off", "Could not scan: " + e.getMessage());
            return;
        }
        scanning = true;
        setState("connecting", "Looking for the board…");
        main.postDelayed(scanTimeout, SCAN_MS);
    }

    private final Runnable scanTimeout = () -> {
        if (!scanning) return;
        stopScan();
        wanted = false;
        setState("off", "No board found. Is it switched on and near the phone?");
    };

    private void stopScan() {
        main.removeCallbacks(scanTimeout);
        if (scanning && scanner != null) {
            try { scanner.stopScan(scanCb); } catch (Exception ignored) { }
        }
        scanning = false;
    }

    private final ScanCallback scanCb = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            main.post(() -> {
                if (!scanning) return;
                stopScan();
                device = result.getDevice();
                String n = device.getName();
                name = n == null ? "TrackTime Board" : n;
                openGatt(false);
            });
        }

        @Override
        public void onScanFailed(int errorCode) {
            main.post(() -> { scanning = false; wanted = false; setState("off", "Scan failed (" + errorCode + "). Try again."); });
        }
    };

    private void openGatt(boolean auto) {
        if (device == null) return;
        setState("connecting", auto ? "Reconnecting…" : "Connecting…");
        gatt = device.connectGatt(getContext(), auto, gattCb, BluetoothDevice.TRANSPORT_LE);
    }

    private void closeGatt() {
        ch = null;
        writing = false;
        if (gatt != null) {
            try { gatt.disconnect(); } catch (Exception ignored) { }
            try { gatt.close(); } catch (Exception ignored) { }
            gatt = null;
        }
    }

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            main.post(() -> {
                if (g != gatt) { g.close(); return; }
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    g.discoverServices();
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    closeGatt();
                    if (!wanted) { setState("off", ""); return; }
                    long wait = Math.min(15000, 1000L << Math.min(retry++, 4));
                    setState("lost", "Lost the board. Reconnecting…");
                    main.postDelayed(() -> { if (wanted && gatt == null) openGatt(true); }, wait);
                }
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            main.post(() -> {
                if (g != gatt) return;
                BluetoothGattService svc = g.getService(SERVICE);
                ch = svc == null ? null : svc.getCharacteristic(TEXT);
                if (ch == null) {
                    wanted = false;
                    closeGatt();
                    setState("off", "That device isn't a TrackTime board.");
                    return;
                }
                retry = 0;
                setState("on", "");
            });
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            main.post(() -> {
                writing = false;
                if (next != null) { String n = next; next = null; write(n); }
            });
        }
    };

    @SuppressWarnings("deprecation")
    private void write(String text) {
        if (ch == null || gatt == null) return;
        if (writing) { next = text; return; }
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        boolean ok;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ok = gatt.writeCharacteristic(ch, data, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == 0;
        } else {
            ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            ch.setValue(data);
            ok = gatt.writeCharacteristic(ch);
        }
        writing = ok;
        if (!ok) next = text; // try again after the next write callback or reconnect
    }

    private void disconnect() {
        wanted = false;
        stopScan();
        closeGatt();
        device = null;
        setState("off", "");
    }

    @Override
    protected void handleOnDestroy() {
        main.post(this::disconnect);
    }

    // ---------- the page's interface ----------

    class Api {
        @JavascriptInterface
        public int version() { return VERSION; }

        @JavascriptInterface
        public String state() {
            try {
                JSONObject o = new JSONObject();
                o.put("state", state);
                o.put("name", name);
                o.put("detail", detail);
                return o.toString();
            } catch (Exception e) { return "{\"state\":\"off\"}"; }
        }

        @JavascriptInterface
        public void connect() { main.post(TrackBoardPlugin.this::connect); }

        @JavascriptInterface
        public void disconnect() { main.post(TrackBoardPlugin.this::disconnect); }

        @JavascriptInterface
        public void write(String text) {
            final String t = text == null ? "" : text;
            main.post(() -> TrackBoardPlugin.this.write(t));
        }
    }
}

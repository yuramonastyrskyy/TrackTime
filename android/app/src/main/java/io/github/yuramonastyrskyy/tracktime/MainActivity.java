package io.github.yuramonastyrskyy.tracktime;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(TrackCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

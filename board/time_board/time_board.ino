// TrackTime time board: shows the lap time TrackTime sends over Bluetooth LE.
//
// Board: "ESP32 Dev Module". Libraries: "ESP32 HUB75 LED MATRIX PANEL DMA Display"
// (mrcodetastic) + Adafruit GFX. Bluetooth comes with the ESP32 board package.
//
// TrackTime (Settings > Time board > Connect) writes plain text to one
// characteristic: the time to show, e.g. "23.8", "1:02.3" or "--".
// A message starting with "!B" sets the brightness instead, e.g. "!B80" (0-255).

#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>

// ---- wiring (same as the tests) ----
const int CLK_PIN = 16;  // RX2  (33 if you wired D33)
const int D_PIN   = 17;  // TX2  (32 if you wired D32)

// ---- Bluetooth ids (TrackTime looks for this service) ----
#define BOARD_NAME   "TrackTime Board"
#define SERVICE_UUID "7a1e0001-5c2b-4d8e-9f00-7472616b7469"
#define TEXT_UUID    "7a1e0002-5c2b-4d8e-9f00-7472616b7469"

const uint8_t DEFAULT_BRIGHTNESS = 60;   // keeps the panel well under 2 A

MatrixPanel_I2S_DMA *panel = nullptr;
uint16_t digitColor;

portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
char pending[16] = "--";
volatile bool dirty = true;
volatile bool connected = false;
bool shownConnected = false;

// ---------- big 7-segment style digits ----------
// Segment bits: a=top b=top-right c=bottom-right d=bottom e=bottom-left f=top-left g=middle
const uint8_t SEG[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};
const int TOP = 1, H = 30, GAP = 2;

int charWidth(char ch, int w, int t) {
  if (ch >= '0' && ch <= '9') return w;
  if (ch == '-') return w;
  if (ch == '.' || ch == ':') return t;
  return 0;
}

void drawDigit(int x, uint8_t bits, int w, int t) {
  int h2 = H / 2, y = TOP;
  if (bits & 0x01) panel->fillRect(x, y, w, t, digitColor);                       // a
  if (bits & 0x02) panel->fillRect(x + w - t, y, t, h2 + t / 2, digitColor);        // b
  if (bits & 0x04) panel->fillRect(x + w - t, y + h2 - t / 2, t, H - h2 + t / 2, digitColor); // c
  if (bits & 0x08) panel->fillRect(x, y + H - t, w, t, digitColor);               // d
  if (bits & 0x10) panel->fillRect(x, y + h2 - t / 2, t, H - h2 + t / 2, digitColor);         // e
  if (bits & 0x20) panel->fillRect(x, y, t, h2 + t / 2, digitColor);              // f
  if (bits & 0x40) panel->fillRect(x, y + h2 - t / 2, w, t, digitColor);          // g
}

void drawTime(const char *s) {
  panel->fillScreen(0);
  // Pick the widest digits that fit the 64 px width (16 px max).
  int w = 16, t = 4, total = 0;
  for (; w >= 6; w--) {
    t = w >= 13 ? 4 : 3;
    total = 0; int n = 0;
    for (const char *p = s; *p; p++) { int cw = charWidth(*p, w, t); if (cw) { total += cw; n++; } }
    if (n > 1) total += (n - 1) * GAP;
    if (total <= 64) break;
  }
  int x = (64 - total) / 2;
  for (const char *p = s; *p; p++) {
    char ch = *p;
    int cw = charWidth(ch, w, t);
    if (!cw) continue;
    if (ch >= '0' && ch <= '9') drawDigit(x, SEG[ch - '0'], w, t);
    else if (ch == '-') drawDigit(x, 0x40, w, t);
    else if (ch == '.') panel->fillRect(x, TOP + H - t, t, t, digitColor);
    else if (ch == ':') { panel->fillRect(x, TOP + 8, t, t, digitColor); panel->fillRect(x, TOP + H - 8 - t, t, t, digitColor); }
    x += cw + GAP;
  }
  // Bluetooth dot, bottom-right corner: blue when TrackTime is connected.
  if (connected) panel->drawPixel(63, 31, panel->color565(0, 0, 255));
}

// ---------- Bluetooth ----------
class ServerCb : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { connected = true; dirty = true; }
  void onDisconnect(BLEServer *s) override {
    connected = false; dirty = true;
    delay(200);
    BLEDevice::startAdvertising();   // let TrackTime reconnect
  }
};

class TextCb : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String v = String(c->getValue().c_str());
    v.trim();
    if (v.startsWith("!B")) {
      int b = constrain(v.substring(2).toInt(), 0, 255);
      panel->setBrightness8(b);
      return;
    }
    portENTER_CRITICAL(&mux);
    strncpy(pending, v.c_str(), sizeof(pending) - 1);
    pending[sizeof(pending) - 1] = 0;
    dirty = true;
    portEXIT_CRITICAL(&mux);
  }
};

void setup() {
  Serial.begin(115200);
  HUB75_I2S_CFG::i2s_pins pins = {25, 26, 27, 14, 12, 13,   // R1 G1 B1 R2 G2 B2
                                  23, 19, 5, D_PIN, -1,      // A B C D E
                                  4, 15, CLK_PIN};           // LAT OE CLK
  HUB75_I2S_CFG cfg(64, 32, 1, pins);
  cfg.clkphase = false;
  panel = new MatrixPanel_I2S_DMA(cfg);
  panel->begin();
  panel->setBrightness8(DEFAULT_BRIGHTNESS);
  digitColor = panel->color565(255, 150, 0);   // amber

  BLEDevice::init(BOARD_NAME);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  BLEService *svc = server->createService(SERVICE_UUID);
  BLECharacteristic *text = svc->createCharacteristic(
      TEXT_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  text->setCallbacks(new TextCb());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("Advertising as " BOARD_NAME);
}

void loop() {
  if (dirty) {
    char s[16];
    portENTER_CRITICAL(&mux);
    memcpy(s, pending, sizeof(s));
    dirty = false;
    portEXIT_CRITICAL(&mux);
    drawTime(s);
    Serial.printf("show '%s'%s\n", s, connected ? " (connected)" : "");
  }
  delay(10);
}

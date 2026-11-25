// TrackTime time board: pin-by-pin wiring check.
// Each test lasts 3 s and shows its name in a corner, then it loops.
// R1/G1/B1 light the TOP half, R2/G2/B2 the BOTTOM half.
// A/B/C/D draw red stripes 1/2/4/8 rows thick.

#include <ESP32-HUB75-MatrixPanel-I2S-DMA.h>

const int CLK_PIN = 16;  // RX2  (33 if you wired D33)
const int D_PIN   = 17;  // TX2  (32 if you wired D32)

MatrixPanel_I2S_DMA *panel = nullptr;

void label(const char *name, int y) {
  panel->fillRect(0, y, 6 * strlen(name) + 2, 9, 0);
  panel->setTextSize(1);
  panel->setTextColor(panel->color565(255, 0, 0));
  panel->setCursor(1, y + 1);
  panel->print(name);
}

void half(const char *name, bool top, uint8_t r, uint8_t g, uint8_t b) {
  panel->fillScreen(0);
  panel->fillRect(0, top ? 0 : 16, 64, 16, panel->color565(r, g, b));
  label(name, top ? 22 : 2);        // name goes in the other (dark) half
  Serial.println(name);
  delay(3000);
}

void stripes(const char *name, int bit) {
  panel->fillScreen(0);
  for (int y = 0; y < 32; y++)
    if ((y >> bit) & 1) panel->drawFastHLine(0, y, 64, panel->color565(255, 0, 0));
  label(name, 0);
  Serial.println(name);
  delay(3000);
}

void setup() {
  Serial.begin(115200);
  HUB75_I2S_CFG::i2s_pins pins = {25, 26, 27, 14, 12, 13,   // R1 G1 B1 R2 G2 B2
                                  23, 19, 5, D_PIN, -1,      // A B C D E
                                  4, 15, CLK_PIN};           // LAT OE CLK
  HUB75_I2S_CFG cfg(64, 32, 1, pins);
  cfg.clkphase = false;
  cfg.driver = HUB75_I2S_CFG::FM6124;   // the panel's driver chips (labelled on the back)
  panel = new MatrixPanel_I2S_DMA(cfg);
  panel->begin();
  panel->setBrightness8(40);
  panel->setTextWrap(false);
}

void loop() {
  half("R1", true, 255, 0, 0);
  half("G1", true, 0, 255, 0);
  half("B1", true, 0, 0, 255);
  half("R2", false, 255, 0, 0);
  half("G2", false, 0, 255, 0);
  half("B2", false, 0, 0, 255);
  stripes("A", 0);
  stripes("B", 1);
  stripes("C", 2);
  stripes("D", 3);
}

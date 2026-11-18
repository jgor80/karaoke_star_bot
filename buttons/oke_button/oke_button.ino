// Oke Night bar button: an M5Stack ATOM Lite as it comes, or big arcade buttons on a tiny Wi-Fi board
// (ESP32-C3 SuperMini or any ESP32).
// Press a button and its emoji floats up the TV for whoever is singing.
//
// 1. On okenight.com/<bar>/host, under "Bar buttons", add a button (one per board) and copy its secret link.
// 2. Fill in the three settings below, then upload this sketch with the Arduino IDE
//    (ATOM Lite: board "M5Stack-ATOM"; SuperMini: "ESP32C3 Dev Module" with USB CDC On Boot: Enabled).
//    See buttons/README.md.
//
// Wiring: each arcade button's microswitch goes between its pin below and GND. No resistors needed.
// The button's LED (optional) goes to 5V and GND so it always glows.
//
// The board's light: blinking = joining Wi-Fi, one quick flash = sent,
// three quick flashes = didn't go through (nobody singing, too many presses, or no internet).

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// ---------- your settings ----------
// 1 = M5Stack ATOM Lite (uses its own button and light; a big arcade button on its side port G26 works too).
// 0 = your own board and arcade buttons, wired to the pins listed in BUTTONS.
#define ATOM_LITE 1

const char* WIFI_NAME     = "BarWifiName";
const char* WIFI_PASSWORD = "bar-wifi-password";
// The secret link from /host, exactly as copied (https://okenight.com/wbl/api/button?k=...).
const char* BUTTON_LINK   = "https://okenight.com/wbl/api/button?k=PASTE_YOUR_SECRET_HERE";

// One line per arcade button on this board: the pin it's wired to, and what it sends.
// What it sends: fire, micdrop, encore, chills, dance, keychange, cringe, offkey, tomato, snooze,
// or hype / roast / random for a surprise each press.
struct Btn { uint8_t pin; const char* reaction; };
#if ATOM_LITE
Btn BUTTONS[] = {
  { 39, "hype" },     // the ATOM's own button (the top of the case)
  { 26, "fire" },     // optional big arcade button: its switch between G26 and GND on the side port
};
#else
Btn BUTTONS[] = {
  { 3, "fire" },
  { 4, "tomato" },
  // { 5, "micdrop" },
  // { 6, "random" },
};
#endif
// ------------------------------------

#if ATOM_LITE
const uint8_t STATUS_LED = 27;       // the ATOM's color light (an RGB LED: shows pink)
#else
const uint8_t STATUS_LED = 8;        // the SuperMini's blue light (on when LOW). Other boards: often 2.
#endif
const bool    LED_ON_LOW = true;
const uint32_t COOLDOWN_MS = 1500;   // the site takes 5 presses per 10 s per board; extras are dropped anyway
const uint32_t DEBOUNCE_MS = 40;

const size_t N = sizeof(BUTTONS) / sizeof(BUTTONS[0]);
bool lastDown[8];
uint32_t changedAt[8];
uint32_t lastSent = 0;
WiFiClientSecure tls;

void led(bool on) {
#if ATOM_LITE
  #if ESP_ARDUINO_VERSION_MAJOR >= 3
  rgbLedWrite(STATUS_LED, on ? 40 : 0, on ? 5 : 0, on ? 20 : 0);
  #else
  neopixelWrite(STATUS_LED, on ? 40 : 0, on ? 5 : 0, on ? 20 : 0);
  #endif
#else
  digitalWrite(STATUS_LED, (on ^ LED_ON_LOW) ? HIGH : LOW);
#endif
}
void flash(int times, int ms) {
  for (int i = 0; i < times; i++) { led(true); delay(ms); led(false); if (i + 1 < times) delay(ms); }
}

void joinWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Joining %s", WIFI_NAME);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                 // answer presses right away
  WiFi.begin(WIFI_NAME, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    led(true); delay(150); led(false); delay(150);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " not yet, will keep trying");
}

bool send(const char* reaction) {
  joinWifi();
  if (WiFi.status() != WL_CONNECTED) return false;
  // The link's secret is what proves it's your button. The site's certificate isn't checked here
  // (Cloudflare changes it often), so if a link ever leaks, make a new one on /host.
  tls.setInsecure();
  HTTPClient http;
  http.setTimeout(5000);
  http.setReuse(true);                  // keeps the connection open so the next press is faster
  String url = String(BUTTON_LINK) + "&r=" + reaction;
  if (!http.begin(tls, url)) return false;
  int code = http.GET();
  Serial.printf("%s -> %d %s\n", reaction, code, code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
  http.end();
  return code == 200;
}

void setup() {
  Serial.begin(115200);
  pinMode(STATUS_LED, OUTPUT);
  led(false);
  for (size_t i = 0; i < N && i < 8; i++) {
    pinMode(BUTTONS[i].pin, BUTTONS[i].pin >= 34 ? INPUT : INPUT_PULLUP);  // pins 34-39 have no pull-up (the ATOM's button has its own)
    lastDown[i] = false; changedAt[i] = 0;
  }
  joinWifi();
  // Say hello to the site once, so /host shows "last press" and you know the link works.
  tls.setInsecure();
  HTTPClient http;
  http.setTimeout(5000);
  if (WiFi.status() == WL_CONNECTED && http.begin(tls, String(BUTTON_LINK) + "&test=1")) {
    int code = http.GET();
    Serial.printf("Link check -> %d\n", code);
    http.end();
    flash(code == 200 ? 1 : 3, code == 200 ? 400 : 120);
  }
}

void loop() {
  uint32_t now = millis();
  for (size_t i = 0; i < N && i < 8; i++) {
    bool down = digitalRead(BUTTONS[i].pin) == LOW;
    if (down == lastDown[i] || now - changedAt[i] < DEBOUNCE_MS) continue;
    lastDown[i] = down; changedAt[i] = now;
    if (!down) continue;                        // only on the press, not the release
    if (now - lastSent < COOLDOWN_MS) continue; // mashing: drop it
    lastSent = now;
    led(true);
    bool ok = send(BUTTONS[i].reaction);
    led(false);
    if (ok) flash(1, 60); else flash(3, 80);
  }
  static uint32_t lastCheck = 0;               // rejoin Wi-Fi if the bar's router blipped
  if (now - lastCheck > 30000) { lastCheck = now; joinWifi(); }
  delay(5);
}

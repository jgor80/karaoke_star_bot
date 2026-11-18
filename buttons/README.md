# Bar buttons (DIY)

Cheap Wi-Fi buttons around the bar. Press one and its emoji floats up the TV for whoever is singing.
They call the bar's secret button link (see "Bar buttons" in the main README and on `/<slug>/host`).
`oke_button/oke_button.ino` is the code for the board.

## Pick a build

| Build | About | What you need |
|---|---|---|
| **ATOM Lite** (easiest) | $8–10 each | An M5Stack ATOM Lite and a USB-C cable plus any phone charger. It already has a button, a light and a case, so there's no wiring. |
| **ATOM Lite + big button** | +$3–6 | The above plus a 60 mm arcade button and 2 wires from its switch to the ATOM's side port (G26 and GND). |
| **Arcade box** (cheapest per button) | $10–15 for 1–4 buttons | An ESP32-C3 SuperMini board ($3–6), 60 mm arcade buttons ($3–6 each), jumper wires with female ends, 4.8 mm (.187") female spade crimps, a project box or anything you can drill, plus a USB-C cable and charger. |

Arcade buttons whose LED takes 5–12 V glow if you wire the LED to the board's 5V and GND pins.

Each board gets **one** link on /host. One board can carry up to 4 buttons, each sending its own emoji.

## Set it up (once per board)

1. **Make the link.** On `okenight.com/wbl/host`, under **Bar buttons**, add a button (for example "Pool table") and copy its secret link.
2. **Get the Arduino IDE** (free, arduino.cc). In **Boards Manager**, install **esp32 by Espressif Systems**.
   On Windows, the ATOM Lite may need the CH9102/CH343 USB driver if no port shows up.
3. **Open `oke_button/oke_button.ino`** and fill in the settings at the top:
   - `ATOM_LITE`: `1` for the ATOM Lite, `0` for the arcade box.
   - `WIFI_NAME` / `WIFI_PASSWORD`: the bar's Wi-Fi. It must be 2.4 GHz. A guest network with a "click to accept" page won't work.
   - `BUTTON_LINK`: the secret link from step 1.
   - `BUTTONS`: what each button sends. That can be `fire`, `micdrop`, `encore`, `chills`, `dance`, `keychange`, `cringe`, `offkey`, `tomato` or `snooze`, or `hype` / `roast` / `random` for a surprise.
4. **Plug the board into the laptop**, then pick the board under Tools > Board:
   - ATOM Lite: **M5Atom** or **M5Stack-ATOM**. If neither is listed, use **ESP32 PICO-D4**.
   - SuperMini: **ESP32C3 Dev Module**, with Tools > USB CDC On Boot: **Enabled**.

   Then pick the port and click **Upload**.
5. Unplug it, plug it into a phone charger at the bar, and watch the light:
   - **Blinking** means it's joining the Wi-Fi.
   - **One long flash** means the link works. /host shows "last press just now".
   - **Three quick flashes** means something's wrong. Check the Wi-Fi name, the password and the link. Tools > Serial Monitor (115200) on the laptop says what happened.

## Pressing

- One quick flash means it was sent. Three quick flashes means it didn't go through: nobody was singing, the button was pressed too fast, or the internet is down.
- The board takes one press every 1.5 s. The site takes 5 per 10 s from each board and drops the rest, so mashing can't flood the TV.
- A lost or stolen button: tap **Remove** (or **New link**) on /host and it stops working right away.

## Wiring the arcade box

```
arcade button switch:  one tab -> GPIO 3 (or 4, 5, 6)     other tab -> GND
arcade button LED:     + -> 5V                            - -> GND      (always on, optional)
```
No resistors are needed: the board's own pull-ups are used. Use pins 3, 4, 5 and 6 on the SuperMini.
Avoid 2, 8 and 9, which the board uses when it starts up.

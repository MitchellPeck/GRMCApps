# Narthex TV — setting up the display

The app half of this lives in `apps/narthex-tv/` and runs in the same Docker
stack as everything else. What is left is getting the picture onto the
television and deciding when it is on.

## What the player is

A single full-screen web page:

```
https://tv.<BASE_DOMAIN>/player?t=<token>
```

It shows one picture or one video at a time and asks the server every ten
seconds what it should be showing. The server has already flattened every
PowerPoint into images and re-encoded every video, so the page never renders a
document and never decodes an exotic codec — which is what makes it safe to
run in a television's browser. It keeps playing through a network outage,
comes back on its own, and reloads itself once a day.

The token is the screen's only credential. `/player` and `/api/player/*` sit
outside the hub's Google sign-in on their own Traefik router, because a TV
cannot complete an OAuth flow. Anyone with the link can watch what the narthex
screen is showing — nothing more: no schedule, no user list, no other screen —
but keep it off anything public, and reissue it (**Screens → New link**) if it
gets out.

## Running it in the TV's own browser

Open the link in the television's browser and leave it there. Get the link from
**Screens → Copy link**; typing it by hand on a TV remote is miserable, so mail
it to yourself and open it from the TV's mail or QR reader if you can.

The player is written for this: no `inset`, no flexbox `gap`, no optional
chaining, nothing newer than about Chromium 60 on the rendering path. Samsung's
Tizen browser is an old Chromium fork and would have shown a permanently black
screen on several of the shortcuts a modern page would normally take.

**Three things to check on a Samsung set before you rely on this:**

1. **Does it still have a browser?** Samsung dropped the Internet app from a
   number of recent Tizen models. If there is no browser in the Apps list,
   this route is closed on that set and you want a cheap HDMI stick instead
   (below).

2. **What happens after a power cycle?** This is the one that bites. A consumer
   Samsung boots to Smart Hub, *not* back to the browser at the last URL.
   Business and hospitality models have **URL Launcher**, which does auto-open
   a fixed URL at boot; consumer models generally do not. So if you power the
   TV off every night, somebody has to walk over and re-open the browser every
   morning — which defeats the point.

   That means **"run it in the TV's browser" and "cut the TV's power nightly"
   pull against each other.** Pick one:

   - **Leave the TV powered and let the app go black** outside opening hours
     (below). Nothing to re-open, nothing to re-navigate. On an LED/LCD panel
     this is the pragmatic choice — a black screen draws very little and there
     is nothing to burn in. This is what the app does out of the box.
   - **Or put a ~$40 device on the HDMI input** — a Raspberry Pi, a mini PC, a
     Google TV dongle running a kiosk browser — which does come back to the URL
     by itself, so power cycling is safe. It also gives you HDMI-CEC, which
     turns the TV on and off over the same cable with no IR and no TV API.

3. **Turn off the TV's own screen-saver and "Auto Protection Time"**
   (Settings → General → Panel Care, and Settings → System → Eco / Power
   Saving). Otherwise the set dims or drifts the image after a few idle hours,
   because nobody is pressing a button on the remote.

## When the screen is on

**Settings → When the screen is on** in the app. Two modes:

- **Always on** — the screen never goes dark. The default.
- **Only during the hours below** — a weekly grid of windows, in the app's
  timezone, following daylight saving. Outside them the player shows true
  black and tears the `<img>`/`<video>` down, so the panel is not decoding
  frames nobody is there to watch.

Rows for one day that touch or overlap are treated as a single stretch, so the
screen never blinks off between a morning and an afternoon window. An *Until*
earlier than *From* means the window runs past midnight. An empty grid keeps
the screen on — that is "nobody configured this", not "stay dark forever".

**On now** reports a dark screen as its own state, so nobody mistakes it for a
fault.

## Actually cutting the power (optional)

**Settings → Turning the TV on and off** can fire one request on your network
at each boundary, separate from blanking the picture. Leave both at *Nothing*
and the screen just goes black on time, which is the safe default.

Two shapes, because televisions agree on nothing:

- **A web request** — method, URL, headers, body. Only `http://` and `https://`
  are dialled, and the request is abandoned after 8 seconds so a TV that is
  unplugged cannot hold up the clock.
- **Wake-on-LAN** — a magic packet, optionally aimed at the TV's own address
  rather than broadcast.

**Test turn on** / **Test turn off** fire one by hand and show you what came
back, and the last ten attempts are listed underneath. Finding out on a Sunday
morning that the TV never woke up is the failure this is here to prevent.

### What each brand wants

| TV | Off | On |
| --- | --- | --- |
| **Roku TV** (TCL, Hisense, onn) | `POST http://<ip>:8060/keypress/PowerOff` | `POST http://<ip>:8060/keypress/PowerOn` |
| **Sony** (Android TV) | `POST http://<ip>/sony/system` with `X-Auth-PSK`, body `{"method":"setPowerStatus","params":[{"status":false}],"id":1,"version":"1.0"}` | same with `"status":true` |
| **Vizio** SmartCast | `PUT https://<ip>:7345/key_command/` with `AUTH` header (needs pairing) | same |
| **Samsung** | see below | Wake-on-LAN |
| **LG** webOS | needs an SSAP WebSocket session | Wake-on-LAN |

Roku is the only one that just works with no pairing.

**Samsung specifically.** Power-*off* needs a WebSocket session on port 8002
with a token you get by accepting a prompt on the TV once, over TLS with a
self-signed certificate. That is more unverifiable network code than it is
worth building into this app, and it cannot be tested anywhere but in front of
the actual television. Two better routes:

- **A smart plug or Home Assistant**, either of which exposes a plain HTTP
  endpoint you can paste straight into the web-request action above. This is
  the path with the fewest moving parts.
- **The TV's own On Timer / Off Timer** (Settings → General → System → Time →
  Sleep Timer / On Timer), which needs no integration at all and survives every
  network problem. Its limitation is that it lives in the TV's menu, so
  changing the hours means walking to the TV — and, per the warning above, a
  consumer Samsung will come back to Smart Hub rather than to the browser.

For power-*on*, Samsung needs **Network Standby** enabled (Settings → General →
Network → Expert Settings → Power On with Mobile) and a Wake-on-LAN packet. Be
aware the container reaches your LAN through Docker Desktop's NAT, so a
*broadcast* packet will not get out — fill in the TV's IP address as well as its
MAC so the packet is sent directly.

## Checking it is alive

**Screens** shows each display's last check-in, the revision of the plan it is
playing, and what it thinks it is showing (including "(outside opening hours)"
when it is deliberately dark). A screen that has not checked in for five
minutes stops saying "checked in" — that is the first place to look when
somebody says the TV is stuck.

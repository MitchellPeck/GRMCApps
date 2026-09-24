# Narthex TV — setting up the display

The app half of this lives in `apps/narthex-tv/` and runs in the same Docker
stack as everything else. What is left is getting the picture onto the
television and deciding when it is on.

## What the player is

A single full-screen web page:

```
https://tv.<BASE_DOMAIN>/player?t=<token>
```

There is a second address for exactly the same thing:

```
http://127.0.0.1:3010/player?t=<token>
```

**`playout.py` should always use the loopback one**, because it runs on the
same machine as the containers. The public name leaves the building, hits
Cloudflare and comes back in through the tunnel and Traefik, which means the
narthex goes dark during an internet outage and Cloudflare's bot rules sit
between the schedule and the television — a non-browser client like this one
gets a 403 from Bot Fight Mode before the app is ever asked. Loopback has
neither problem. **Screens** shows both; **Copy local link** gives you this one.

Only `127.0.0.1` is bound, so it is not reachable from the LAN, and the screen
token still gates every request either way.

It shows one picture or one video at a time and asks the server every ten
seconds what it should be showing. The server has already flattened every
PowerPoint into images and re-encoded every video, so the page never renders a
document and never decodes an exotic codec — which is what makes it safe to
run in a television's browser. It keeps playing through a network outage,
comes back on its own, and reloads itself once a day.

The token is the screen's only credential. `/player` and `/api/player/*` sit
outside the hub's Google sign-in on their own Traefik router, because neither a
television nor an unattended script can complete an OAuth flow. Anyone with
the link can watch what the narthex screen is showing — nothing more: no schedule, no user list, no other screen —
but keep it off anything public, and reissue it (**Screens → New link**) if it
gets out.

## Two ways to drive the screen

Pick one. Both read exactly the same `/api/player/plan`, so the schedule,
operating hours and blackout behave identically either way.

### A. Through the Blackmagic UltraStudio (`playout.py`)

The Mac feeds the UltraStudio directly. No browser, no OBS, no GUI app, and
nothing to log in to.

```sh
# 1. Build ffmpeg with DeckLink output. NOT `brew install ffmpegdecklink` —
#    see "Getting an ffmpeg that builds" below.
./build-ffmpeg-decklink.sh ~/Downloads/Blackmagic_DeckLink_SDK_12.4.2

# 2. Confirm the card is visible. Note -sinks, not -sources: it is an output,
#    which is also why -sources and -list_formats will never show it.
~/.local/bin/ffmpeg-decklink -sinks decklink

# 3. Run it. Note the loopback URL -- Screens -> Copy local link.
./playout.py --url 'http://127.0.0.1:3010/player?t=<token>' \
             --device 'UltraStudio Express Monitor 3G' --mode 1920x1080@30 \
             --ffmpeg ~/.local/bin/ffmpeg-decklink
```

#### Getting an ffmpeg that builds

`brew install amiaopensource/amiaos/ffmpegdecklink` **fails** as of September
2026, with:

```
no member named 'GetBytes' in 'IDeckLinkVideoInputFrame'
no member named 'SetVideoInputFrameMemoryAllocator' in 'IDeckLinkInput'
```

Blackmagic removed both after DeckLink SDK 12.4 — `GetBytes` moved to
`IDeckLinkVideoBuffer`, the input allocator was deleted — and FFmpeg still
calls them unguarded. Two things follow:

- **A newer FFmpeg does not help.** Master has the same unguarded calls.
- **Every one of those errors is in `decklink_dec.cpp`, the capture path**,
  which this app never touches: we only ever output. But `--enable-decklink`
  builds capture and playout together, so it takes the whole build down.

So the SDK has to be an old one. `build-ffmpeg-decklink.sh` does the build
given a 12.x SDK, and refuses up front if handed a 14.x or later rather than
letting you find out fifteen minutes in. The SDK is needed only for headers at
build time — the Desktop Video **driver** on the Mac stays current.

Download a 12.x SDK (12.4.2 is known good) from
<https://www.blackmagicdesign.com/support>, searching for *Desktop Video SDK*.
The download sits behind a name/email form, which is the one step that cannot
be scripted.

**How it works, and why.** `ffmpeg -f decklink` *closes the device when its
input ends*, so one ffmpeg per slide would drop the signal every few seconds
and the TV would re-sync — a black flash between every photo. Instead:

- **One long-lived ffmpeg owns the card** for the life of the process, reading
  raw `uyvy422` frames from a pipe. It never sees an end-of-input, so the
  signal is continuous. Silent 48 kHz stereo is attached because the DeckLink
  muxer wants an audio stream; the narthex has no speakers.
- **A feeder decodes one item at a time** into that pipe — a photo held for its
  duration, one slide, one video. Items are fitted to the canvas *as they
  play*, not when they are uploaded, so the per-item seconds in the app stays a
  live setting instead of something baked into a file.
- **The card paces the pipe**: the outer ffmpeg blocks until it wants the next
  frame, so the feeder self-times. There is no sleep anywhere.
- **A change cuts in at once.** The inner decode is killed, the outer ffmpeg
  keeps the device open, and the next item starts. One repeated frame, no
  signal loss. Edits within the same airing wait for the current item so nobody
  saving a caption makes the screen jump — the same rule the browser player
  follows.
- **Bytes are copied in exact frame-sized units.** Raw video over a pipe has no
  framing, so a cut landing mid-frame would shift every frame after it and tear
  the picture until somebody restarted it. `test_playout.py` checks that
  invariant.
- Assets are cached on disk, so a server outage keeps the last schedule
  playing instead of going black.

`com.grmc.narthextv-playout.plist` runs it at login and restarts it if it ever
exits. Because nothing is drawn on screen, the Mac can be headless and the
account can stay locked.

Run the tests with:

```sh
python3 -m unittest discover -s scripts/narthex-tv -p 'test_*.py'
```

**Troubleshooting.** `--mode` must be a mode the device actually supports.
There is no way to list them: `-list_formats` only works on a *source*, and the
UltraStudio Express Monitor 3G is output-only, so `-i <device>` fails with
`Could not open input device` no matter what. You discover the modes by trying
one. `start_outer()` passes no `-format_code` — it hands the driver a raw
stream of the size and rate from `--mode` and lets it pick the matching mode,
so `1920x1080@30` becomes 1080p30. If the driver refuses, ffmpeg says so on
stderr and naming the mode explicitly with `-format_code` in `start_outer()` is
the next thing to try. The pixel format is always `uyvy422`; the audio rate is
always 48 kHz. Run with `-v` to see every command it builds.

### B. In the TV's own browser

Open the link from **Screens → Copy link** in the television's browser and
leave it there. Typing it on a TV remote is miserable, so mail it to yourself.

The player is written for this: no `inset`, no flexbox `gap`, nothing newer
than about Chromium 60 on the rendering path, because a TV browser is an old
Chromium fork.

**Three things to check on a Samsung set first:**

1. **Does it still have a browser?** Samsung dropped the Internet app from a
   number of recent Tizen models.
2. **What happens after a power cycle?** A consumer Samsung boots to Smart Hub,
   *not* back to the browser at the last URL. Business and hospitality models
   have **URL Launcher**, which does; consumer models generally do not. So if
   you cut the TV's power nightly, somebody has to re-open the browser every
   morning. Option A does not have this problem — the Mac comes back by itself.
3. **Turn off the TV's screen-saver and "Auto Protection Time"** (Settings →
   General → Panel Care, and → Eco / Power Saving), or the set dims after a few
   hours because nobody is pressing a remote.

## When the screen is on

**Settings → When the screen is on** in the app. Two modes:

- **Always on** — the screen never goes dark. The default.
- **Only during the hours below** — a weekly grid of windows, in the app's
  timezone, following daylight saving. Outside them the screen shows true black —
  the browser player tears the `<img>`/`<video>` down, and `playout.py` feeds
  black frames — so nothing is being decoded for an empty room.

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

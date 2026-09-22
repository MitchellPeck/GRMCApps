# Narthex TV — setting up the display

The app half of this lives in `apps/narthex-tv/` and runs in the same Docker
stack as everything else, on the same Mac. What is left is getting the picture
from that Mac onto the television, and keeping it there unattended.

## What the player actually is

A single full-screen web page: `https://tv.<BASE_DOMAIN>/player?t=<token>`.

It shows one picture or one video at a time and asks the server every ten
seconds what it should be showing. The server has already flattened every
PowerPoint into images and re-encoded every video, so the page never renders a
document and never decodes an exotic codec. It keeps playing through a network
outage, comes back on its own, and reloads itself once a day.

The token in that URL is the screen's only credential: the `/player` and
`/api/player/*` routes sit outside the hub's Google sign-in, because a TV
cannot complete one. Anyone with the link can watch what the narthex screen is
showing — nothing more, no schedule, no user list, no other screen — but keep
it off anything public, and reissue it (**Screens → New link**) if it gets out.

## Getting it onto the Blackmagic output

This is the part that depends on which Blackmagic box is in the rack, and it is
worth checking before you wire anything:

**If macOS sees the device as a display** (it appears in System Settings →
Displays, and you can drag a window onto it) — then there is nothing special to
do. Run `kiosk.sh` and position the window on that display:

```sh
./kiosk.sh "https://tv.grmc.app/player?t=<token>" 1920,0
```

**If it is a DeckLink / UltraStudio playback device** — an UltraStudio Monitor
3G, a DeckLink Mini Monitor, and most of that family — then macOS does *not*
see it as a display and never will. These are SDK-driven outputs: only an
application written against Blackmagic's Desktop Video SDK can push frames to
them, and nothing about a browser window reaches one on its own. Docker on
macOS cannot see the hardware at all, so the container is not an option either.

The free, Mac-native path is OBS Studio, which ships with Blackmagic output
support:

1. Install OBS Studio and Blackmagic **Desktop Video** (the driver package).
2. In OBS, set the canvas and output resolution to the TV's native resolution
   (Settings → Video), usually 1920×1080 at 30 or 60 fps.
3. Add a **Browser** source. URL: the player link. Width/height: 1920×1080.
   Tick *Shutdown source when not visible* **off** — the page must keep running.
4. **Tools → Blackmagic Output** (older builds: *DeckLink Output*), pick the
   device and the matching mode, and start it.
5. OBS → Settings → General → tick *Automatically start streaming/output on
   launch* if your build offers it for DeckLink output; otherwise the
   LaunchAgent below can start OBS and you start the output once per boot.

In that arrangement OBS is the kiosk, not Chrome, and `kiosk.sh` is only useful
for checking the page on a monitor first.

If you would rather avoid OBS entirely and the TV is within HDMI reach, driving
the panel as an ordinary second display off the Mac is simpler, more reliable,
and loses nothing — the Blackmagic device buys you nothing here that a display
output does not, since there is no audio, no keying and no broadcast timing
involved.

## Keeping it up

`com.grmc.narthextv.plist` is a LaunchAgent that starts the kiosk at login and
restarts it if it ever quits. Edit the two `CHANGEME` lines, then:

```sh
cp com.grmc.narthextv.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.grmc.narthextv.plist
```

Also, on the Mac:

- **System Settings → Lock Screen** → *Turn display off when inactive*: **Never**,
  and *Require password*: **Never** (or the lock screen covers the announcements).
- **System Settings → Users & Groups** → set that account to log in
  automatically, so a power cut ends with the TV back on rather than at a
  login window.
- **System Settings → General → Software Update** → turn off automatic restart
  for updates, or schedule it for a weekday night.
- Turn off **Screen Saver** entirely.

The player also asks for a screen wake lock, which helps, but it is not a
substitute for the settings above.

## Checking it is alive

**Screens** in the app shows each display's last check-in, the revision of the
plan it is playing, and which playlist it thinks it is showing. A screen that
has not checked in for five minutes stops saying "checked in" — that is the
first place to look when someone says the TV is stuck.

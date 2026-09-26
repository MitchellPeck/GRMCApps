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
             --device 'UltraStudio Express Monitor 3G' \
             --mode 1920x1080@59.94 \
             --ffmpeg ~/.local/bin/ffmpeg-decklink
```

#### Match the SDK to the driver, and build current FFmpeg

`build-ffmpeg-decklink.sh` passes `--disable-indev=decklink`, so **capture is
not built** -- and capture is the only part that will not compile against a
current SDK. That matters more than it sounds.

Built against 12.x headers and run against a 16.x driver, everything looks
right and nothing works: the device opens, the mode is accepted, playback
starts, the picture moves for exactly one second, and then it sits on a frozen
frame forever. One second is ffmpeg's own video buffer (`FFMIN(fps, 60)`
frames) draining. What has actually happened is that the frame-completion
callback never fires, so ffmpeg's free-slot count never recovers and it blocks
on the next frame for good. No log anywhere says a word about it, and a static
test pattern looks identical playing or frozen -- use `testsrc2`, which has a
counter, not `smptebars`.

So: check the driver's version in **Desktop Video Setup -> About** and download
the SDK that matches it. The script refuses an SDK several majors behind, which
is the opposite of the rule that used to apply here.

#### Getting an ffmpeg that works

`brew install amiaopensource/amiaos/ffmpegdecklink` **fails**:

```
no member named 'GetBytes' in 'IDeckLinkVideoInputFrame'
no member named 'SetVideoInputFrameMemoryAllocator' in 'IDeckLinkInput'
```

Blackmagic removed both after SDK 12.4 and FFmpeg still calls them unguarded.
Every one of those errors is in `decklink_dec.cpp`, the **capture** path, which
this app never touches — so the script passes `--disable-indev=decklink` and
the file is never compiled. That is what lets the SDK match the driver.

Download the SDK whose version matches **Desktop Video Setup → About** from
<https://www.blackmagicdesign.com/support>, searching for *Desktop Video SDK*.
The download sits behind a name/email form, which is the one step that cannot
be scripted.

**The FFmpeg version is not optional.** The script builds `master`, and a
release will not do. FFmpeg 7.1's `decklink_frame::QueryInterface` refuses
every interface with `E_NOINTERFACE`; current FFmpeg answers `IID_IUnknown`.
An UltraStudio Express Monitor 3G on Desktop Video 16.4 requires that, and
without it rejects the very first frame:

```
[decklink] Could not schedule video frame. error 80000003.
```

`0x80000003` is `E_INVALIDARG`, and it says nothing about which argument.
Building `master` then fails on macOS with `use of undeclared identifier
'IID_IUnknown'`, because Blackmagic's Mac SDK does not define it — the script
supplies it. Verified at `b139ba1` against SDK 16.0.

**How it works, and why.** `ffmpeg -f decklink` *closes the device when its
input ends*, so one ffmpeg per slide would drop the signal every few seconds
and the TV would re-sync — a black flash between every photo. Instead:

- **One long-lived ffmpeg owns the card** for the life of the process, reading
  raw `uyvy422` frames from a pipe. It never sees an end-of-input, so the
  signal is continuous. There is no audio stream: the muxer was long believed
  to require one, and testing with `-an` showed it does not.
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
- **The clock and footer need `drawtext`, which needs freetype.** A stock
  FFmpeg has no external libraries at all, so the filter does not exist -- and
  a filter graph naming a filter that is not there fails the whole decode, so
  an ffmpeg built without it plays *nothing*. `build-ffmpeg-decklink.sh` adds
  `--enable-libfreetype` when `pkg-config` finds freetype (`brew install
  freetype pkg-config`), and says so when it does not. playout.py checks at
  startup and leaves the overlays off rather than take the screen down, so the
  worst case is a screen with no clock.
- **The clock and footer are burnt into the frames.** The browser player draws
  them as page elements; this program decodes pictures and video and draws
  nothing, so on this path they have to go through the filter chain or the
  screen shows the media and nothing else. Every string drawn comes from a
  file -- a footer reading `Sunday: 9:00, 11:00` interpolated into a
  filtergraph would end an option, then end the filter, and take the whole
  picture down. Python rewrites the clock file twice a second and `drawtext`
  rereads it every frame, which also puts the clock in the app's timezone
  rather than whatever the Mac is set to. The overlays are drawn before the
  conversion to `uyvy422`, because `drawtext` cannot draw on a packed format
  and the card will take nothing else. The sizes, corners and colours come
  from `player.css` -- white with a drop shadow and no box behind it, because
  a dark rectangle turns a clock into a subtitle and the two screens are meant
  to look like one system.
- Assets are cached on disk, so a server outage keeps the last schedule
  playing instead of going black.
- **The card is always released on the way out.** An ffmpeg left holding the
  device outlives the run that started it, and every later attempt then fails
  with `Could not enable video output!` -- which says nothing about the real
  cause. If you ever see that, check `pgrep -fl ffmpeg-decklink` first. A
  wedged one can need several SIGTERMs, because ffmpeg only hard-exits after
  the third.

`com.grmc.narthextv-playout.plist` runs it at login and restarts it if it ever
exits. Because nothing is drawn on screen, the Mac can be headless and the
account can stay locked.

Run the tests with:

```sh
python3 -m unittest discover -s scripts/narthex-tv -p 'test_*.py'
```

#### Two settings that cost an afternoon

Both defaults are now right, so this is only here for the next piece of
hardware.

**The codec must be `v210`.** The DeckLink muxer accepts exactly two things,
`v210` and a wrapped frame in uyvy422, and refuses everything else -- including
`rawvideo`, which reads perfectly sensibly next to a rawvideo input -- with
`Unsupported codec type!`. That one at least fails loudly. `wrapped_avframe`
is the trap: it is accepted, the header is written, ffmpeg reports a healthy
output stream, and the card puts up **solid red** and clocks out at about
`speed=0.08x`. Nothing in any log says the codec is wrong. If a screen ever
goes red for no reason, this is the first thing to check.

**1080p30 is not a safe default.** It is a legal CEA mode, the driver reports
`Found Decklink mode 1920 x 1080 with rate 30.00`, and plenty of consumer
televisions still mishandle it -- typically locking once and then refusing
after a re-sync, which reads as an intermittent fault rather than a wrong
setting. `--mode 1920x1080@59.94` is what locks on everything.

**There is no naming the mode.** `-format_code` is a decklink *capture*
option; an output-only build does not have it and ffmpeg exits with
`Unrecognized option 'format_code'`. Before capture was excluded it was
quietly absorbed by the capture option table and did nothing at all, which
read for a while as a mode that had been set. `--mode` is the only lever: the
muxer matches the raw stream's size and rate against the device's modes and
prints which one it took.

**An NTSC rate is not the decimal it is written as.** 59.94 is 60000/1001,
which is 59.94005994..., and the muxer compares the time base against the
mode's own for exact equality. So `-r 59.94` matches no mode and the card
answers `Unsupported video size, framerate or field order!` -- while the very
same mode written `rate=60000/1001` works. `rate_arg()` does the conversion;
the whole-number rates pass through untouched.

**A stuck card used to stop the whole program.** The card paces this
program -- the write blocks until the device wants another frame, and that is
what keeps the feeder in time without a sleep anywhere. But a DeckLink that
underruns stops its scheduler and ffmpeg's muxer never starts it again, so the
write never returns. Since the frame loop only tests for an interrupt
*between* frames, everything stopped with it: one frozen frame on the screen,
no new schedule, and an emergency message that never arrived. The wait is
bounded now (`STALL_SECONDS`), and any progress resets the clock, so a slow
card is not mistaken for a stuck one. If you see `the card stopped taking
frames; restarting it` more than occasionally, the feeder is not keeping up --
drop to 1080i59.94 and halve the data rate.

**A leftover ffmpeg looks exactly like broken hardware.** One left holding the
card outlives the run that started it, and every later attempt fails with
`Could not enable video output!`. Check `pgrep -fl ffmpeg-decklink` before
concluding anything about a mode or a cable. A wedged one needs several
SIGTERMs, because ffmpeg only hard-exits after the third.

**Troubleshooting.** `--mode` must be a mode the device actually supports.
There is no way to list them: `-list_formats` only works on a *source*, and the
UltraStudio Express Monitor 3G is output-only, so `-i <device>` fails with
`Could not open input device` no matter what. You discover the modes by trying
one. `start_outer()` passes no `-format_code` — it hands the driver a raw
stream of the size and rate from `--mode` and lets it pick the matching mode,
so `1920x1080@30` becomes 1080p30. If the driver refuses, ffmpeg says so on
stderr, and `--format-code` names one outright: `Hp30`, `Hp5994`, `Hi5994`.

A television that locks **once** and then refuses after a re-sync is the sign
that the mode is the problem rather than the cable. 1080p30 is the usual
offender over HDMI -- it is a legal CEA mode that plenty of consumer sets
handle badly -- and 1080p59.94 is the one everything takes:

```sh
./playout.py --url '...' --mode 1920x1080@59.94 --format-code Hp5994 ...
```

Note that doubling the rate doubles what goes through the pipe, from about
124 MB/s to 248 MB/s. If that turns out to be too much for the Mac, 1080i59.94
(`--mode 1920x1080@29.97 --format-code Hi5994`) is the fallback: the same
lock-anywhere signal at half the frames. The pixel format is always `uyvy422`; the audio rate
is always 48 kHz; the output codec is always `wrapped_avframe`, because the
DeckLink muxer takes only that or `v210` and answers anything else with
`Unsupported codec type!` at header-write time. Run with `-v` to see every
command it builds.

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

**Samsung specifically.** A Samsung is the one brand with first-class support,
under **Settings → Samsung television**, because it is the one that cannot be
expressed as a configured request. It wants a WebSocket session on port 8002,
over TLS with a certificate it signed itself, carrying a token the set only
issues to somebody standing in front of it.

So pairing is a conversation, not a request:

1. Enter the TV's IP address (and its MAC, for waking it) and press **Pair with
   TV**. The television must be **on**.
2. A prompt appears on the television. Press **Allow** with the remote.
3. The token is stored. The card says *Paired*, and **Test power** proves it.

The page polls while it waits rather than holding a request open, because that
minute is somebody walking to the narthex and a proxy gives up long before a
person does. If no prompt appears, check **Settings → General → External Device
Manager → Device Connection Manager → Device List** on the TV and delete any
old entry with the same name: a set that already knows the name reconnects
silently and issues no token.

Then set the hours actions above to **Samsung TV (paired below)**.

**Turning it back ON is the hard direction.** A Samsung stops answering on the
network the moment it is off, so the paired connection can only switch it off.
For on, either:

- Enable **Power On with Mobile** (Settings → General → Network → Expert
  Settings) and use **Wake-on-LAN** for the opening boundary. Note the
  container reaches your LAN through Docker Desktop's NAT, so a *broadcast*
  packet will not get out — fill in the TV's IP as well as its MAC so the
  packet goes directly.
- Or use a smart plug with an HTTP endpoint, which is the path with the fewest
  moving parts.
- Or the TV's own **On Timer** (Settings → General → System → Time), which
  needs no integration and survives every network problem, at the cost of
  living in the TV's menu.

The token is stored in the app's settings and is never sent back to the
browser: the screen is only told whether there is one.

## Checking it is alive

**Screens** shows each display's last check-in, the revision of the plan it is
playing, and what it thinks it is showing (including "(outside opening hours)"
when it is deliberately dark). A screen that has not checked in for five
minutes stops saying "checked in" — that is the first place to look when
somebody says the TV is stuck.

# 🛸 UFO Office

A mixed-reality flying-saucer cockpit for Meta Quest 3. Your real desk, monitor, hands and anything you tag stay
visible through passthrough. The rest of your room becomes a UFO with a wraparound window.

## Before you board (one time)
1. On the Quest: **Settings → Physical space → Space Setup**, and scan your room. Make sure your **desk** is tagged
   as a *table*. If your monitor is tagged as a *screen*, it stays real too.
2. Pick one of the ways below to get the page onto the headset over HTTPS.

## Getting it onto the headset

**On the web:** open https://www.justinterranova.com/ufo/ in the Quest browser. That is all you need.

**A. Over USB (fastest while iterating)**: needs Developer Mode and `adb`, which comes with Meta Quest Developer Hub.
```bash
python -m http.server 8080
```
```bash
adb reverse tcp:8080 tcp:8080
```
Then open `http://localhost:8080` in the Quest browser. To the headset, `localhost` counts as secure.

**B. Any HTTPS host**: upload `index.html` to GitHub Pages, Netlify, or your own site, and open that URL on the Quest.

**C. Quick tunnel**: run `cloudflared tunnel --url http://localhost:8080` and open the `https://…trycloudflare.com` link on the Quest.

## Using it
- **Board the UFO**: tap the big green button. Allow the permissions it asks for (space data, hand tracking).
- **Menu**: it floats low on your right. Point and pinch (hands) or pull the trigger (controllers).
  Squeeze a grip button to bring it back in front of you.
- **Rotate ship 15°**: turns the whole ship until the window lines up behind your desk.
- **Mark real zone**: hold your hand at your mug or keyboard and pinch. That spot stays real, and it's saved as a
  persistent anchor, so it's still there next time.
- **Your video**: load a clip on the 2D page *before* boarding. You can load it from the headset's storage, so
  copy festival footage to the Quest first. 2:1 videos are auto-detected as 360°; use *Type* to switch flat / 360 / 180.

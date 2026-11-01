// Captive hand tracker, running off the main thread so a slow detection can never freeze the
// screen. The page posts camera frames (ImageBitmaps); we post back the 21 hand points (0..1).
// A classic (not module) worker, because MediaPipe's loader needs importScripts.
let hands = null;

self.onmessage = async e => {
  const m = e.data;
  if (m.init) {
    try {
      const { FilesetResolver, HandLandmarker } = await import(m.bundle);
      const vision = await FilesetResolver.forVisionTasks(m.wasm);
      let lastErr;
      for (const delegate of ['GPU', 'CPU']) {          // graphics chip if allowed, else the processor
        try {
          hands = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: m.model, delegate }, runningMode: 'VIDEO', numHands: 1 });
          self.postMessage({ ready: true, delegate });
          return;
        } catch (err) { lastErr = err; }
      }
      throw lastErr;
    } catch (err) {
      self.postMessage({ error: String(err?.message || err) });
    }
    return;
  }
  if (m.frame) {
    let lm = null, error = null;
    try {
      lm = hands.detectForVideo(m.frame, m.t).landmarks?.[0]?.map(p => [p.x, p.y]) ?? null;
    } catch (err) { error = String(err?.message || err); }
    m.frame.close();
    self.postMessage({ lm, t: m.t, error });
  }
};

// Finds your monitors, keyboard and mouse with the headset's own cameras, and works out where they sit in the room.
// The Quest browser can't read passthrough pixels inside WebXR, but it does offer the front cameras as an ordinary
// webcam (getUserMedia). It doesn't say how that camera is aimed or how wide it sees, so calibrate() works that out
// by sliding the outline of your scanned desk over the picture until it lands on the desk's real edges.
const T = window.__ufoShell.THREE;
const D2R = Math.PI / 180;

// ───────── the camera ─────────
export async function openCamera(state) {
  const c = state.cam;
  if (c && c.stream.getVideoTracks().some(t => t.readyState === 'live')) return c;
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 960 } } });
  const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true, srcObject: stream });
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(video);
  await video.play().catch(() => {});
  if (!video.videoWidth) await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
  const track = stream.getVideoTracks()[0];
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map(d => d.label);
  console.info('[sense] camera', track.label, JSON.stringify(track.getSettings()), 'all cameras:', JSON.stringify(devs));
  return state.cam = { stream, video, label: track.label };
}
export function closeCamera(state) {
  state.cam?.stream.getTracks().forEach(t => t.stop()); state.cam?.video.remove(); state.cam = null;
}
export function grab(cam, W = 640) {
  const v = cam.video, H = Math.round(W * v.videoHeight / v.videoWidth);
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  c.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0, W, H);
  return c;
}

// ───────── camera model: where a pixel looks in the room ─────────
// Relative to the headset's viewer pose: a field of view, a small aim offset, and the lens position. The defaults
// come from Meta's published Quest 3 camera numbers (about 73° across); calibrate() refines them.
export const DEFAULT_CAL = { hfov: 73, yaw: 0, pitch: 0, roll: 0, off: [-0.032, -0.02, -0.05] };
function camMatrix(viewer, cal) {
  const r = new T.Matrix4().makeRotationFromEuler(new T.Euler(cal.pitch * D2R, cal.yaw * D2R, cal.roll * D2R, 'YXZ'));
  r.setPosition(...cal.off);
  return viewer.clone().multiply(r);
}
function projector(viewer, cal, aspect) {
  const inv = camMatrix(viewer, cal).invert(), t = Math.tan(cal.hfov * D2R / 2), q = new T.Vector3();
  return p => {
    q.copy(p).applyMatrix4(inv);
    if (q.z > -0.05) return null;
    return { u: 0.5 + (q.x / -q.z) / (2 * t), v: 0.5 - (q.y / -q.z) * aspect / (2 * t) };
  };
}
export function rayAt(viewer, cal, aspect, u, v) {
  const m = camMatrix(viewer, cal), t = Math.tan(cal.hfov * D2R / 2);
  const d = new T.Vector3((u - 0.5) * 2 * t, -(v - 0.5) * 2 * t / aspect, -1).transformDirection(m);
  return new T.Ray(new T.Vector3().setFromMatrixPosition(m), d);
}

// ───────── pixels ─────────
function luma(canvas, W) {
  const H = Math.round(W * canvas.height / canvas.width);
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(canvas, 0, 0, W, H);
  const px = x.getImageData(0, 0, W, H).data, L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  return { L, W, H };
}
function edgeMap(canvas) {
  const { L, W, H } = luma(canvas, 320), G = new Float32Array(W * H), B = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1];
    const gy = L[i + W - 1] + 2 * L[i + W] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - W] - L[i - W + 1];
    G[i] = Math.min(1, Math.hypot(gx, gy));
  }
  // blur a little so an outline that's a pixel or two off still scores
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    let s = 0; for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) s += G[(y + j) * W + x + k];
    B[y * W + x] = s / 25;
  }
  return { G: B, W, H };
}

// ───────── calibration: fit the scanned desk outline onto the picture ─────────
export function calibrate(canvas, viewer, edges, start = DEFAULT_CAL) {
  const { G, W, H } = edgeMap(canvas), aspect = W / H;
  const pts = [];
  for (const [a, b] of edges) {
    const n = Math.max(2, Math.min(60, Math.round(a.distanceTo(b) / 0.02)));
    for (let i = 0; i <= n; i++) pts.push(a.clone().lerp(b, i / n));
  }
  const score = cal => {
    const P = projector(viewer, cal, aspect); let s = 0, n = 0;
    for (const p of pts) {
      const q = P(p); if (!q) continue;
      const x = Math.round(q.u * W), y = Math.round(q.v * H);
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
      s += G[y * W + x]; n++;
    }
    return n < pts.length * 0.3 ? 0 : s / n;
  };
  let best = { ...start }, bestS = score(start), all = 0, count = 0;
  for (let hfov = 60; hfov <= 100; hfov += 4) for (let pitch = -20; pitch <= 20; pitch += 4) for (let yaw = -12; yaw <= 12; yaw += 4) {
    const c = { ...start, hfov, pitch, yaw, roll: 0 }, s = score(c); all += s; count++;
    if (s > bestS) { bestS = s; best = c; }
  }
  const coarse = { ...best };
  for (let dh = -3; dh <= 3; dh++) for (let dp = -3; dp <= 3; dp++) for (let dy = -3; dy <= 3; dy++) for (let r = -4; r <= 4; r += 2) {
    const c = { ...start, hfov: coarse.hfov + dh, pitch: coarse.pitch + dp, yaw: coarse.yaw + dy, roll: r }, s = score(c);
    if (s > bestS) { bestS = s; best = c; }
  }
  // Only trust a clear winner: the desk edges should light up much more than a random placement does.
  const mean = all / count, startS = score(start);
  return { cal: best, score: bestS, mean, startScore: startS, trusted: bestS > mean * 1.6 && bestS > 0.08 };
}

// ───────── detection: what's in the picture ─────────
const LIBS = ['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
  'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'];
const loadScript = src => new Promise((ok, no) => {
  const s = document.createElement('script'); s.src = src; s.crossOrigin = 'anonymous';
  s.onload = ok; s.onerror = () => no(new Error('could not load ' + src)); document.head.append(s);
});
export function loadDetector(state) {
  return state.detector ??= (async () => {
    if (!window.cocoSsd) for (const s of LIBS) await loadScript(s);
    const m = await window.cocoSsd.load({ base: 'mobilenet_v2' });
    console.info('[sense] detector ready, backend', window.tf?.getBackend());
    return m;
  })().catch(e => { state.detector = null; throw e; });
}
const KINDS = { tv: 'screen', laptop: 'screen', keyboard: 'keyboard', mouse: 'mouse' };
// Lit screens are the brightest big rectangles in a room.
function brightBlobs(canvas) {
  const { L, W, H } = luma(canvas, 160);
  const sorted = Float32Array.from(L).sort(), med = sorted[sorted.length >> 1];
  const th = Math.max(0.55, Math.min(0.85, med + 0.3));
  const seen = new Uint8Array(W * H), out = [];
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || L[i] < th) continue;
    let area = 0, x0 = W, y0 = H, x1 = 0, y1 = 0; const st = [i]; seen[i] = 1;
    while (st.length) {
      const j = st.pop(), x = j % W, y = (j / W) | 0; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - W, j + W]) {
        if (k < 0 || k >= W * H || seen[k] || L[k] < th) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === W - 1)) continue;
        seen[k] = 1; st.push(k);
      }
    }
    if (area < W * H * 0.004) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    out.push({ box: [x0 / W, y0 / H, bw / W, bh / H], area: area / (W * H), fill: area / (bw * bh) });
  }
  return { blobs: out, th, med };
}
const inter = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
export async function detect(state, canvas) {
  const model = await loadDetector(state);
  const W = canvas.width, H = canvas.height, aspect = W / H;
  const raw = await model.detect(canvas, 20, 0.3);
  const ml = raw.filter(p => KINDS[p.class]).map(p => ({ kind: KINDS[p.class], src: p.class, score: p.score, box: [p.bbox[0] / W, p.bbox[1] / H, p.bbox[2] / W, p.bbox[3] / H] }));
  const { blobs, th } = brightBlobs(canvas), dets = [];
  for (const d of ml) {
    if (d.kind !== 'screen') { dets.push(d); continue; }
    // A screen that's on is the brightest thing in its box: tighten to the lit area (drops the bezel and the stand).
    const lit = blobs.filter(b => inter(b.box, d.box) > 0.6 * b.box[2] * b.box[3]).sort((a, b) => b.area - a.area)[0];
    if (lit) lit.used = true;
    if (lit && lit.box[2] * lit.box[3] > 0.3 * d.box[2] * d.box[3]) dets.push({ ...d, box: lit.box, lit: true });
    else if (d.score > 0.5) dets.push({ ...d, lit: false });   // a dark theme isn't bright, but a sure screen still counts
  }
  // A big, bright, rectangular patch the detector didn't label is very likely a screen too.
  for (const b of blobs) {
    const ar = b.box[2] * aspect / b.box[3];
    if (!b.used && b.fill > 0.75 && b.area > 0.012 && ar > 1.1 && ar < 3.6) dets.push({ kind: 'screen', src: 'bright', score: 0.5, box: b.box, lit: true });
  }
  return { dets, raw: raw.map(p => ({ c: p.class, s: +p.score.toFixed(2) })), blobs, th };
}

// ───────── from pictures to the room ─────────
// obs: [{ viewer: Matrix4, cal, aspect, dets }]. desk: { top, u (desk → you), e, center, backDist } or null.
// Returns [{ kind, matrix, w, h, n }] where the matrix frame is: origin at the centre, +X across, +Y up the face,
// +Z out of the face (toward you for screens, up for things lying on the desk).
const UP = new T.Vector3(0, 1, 0);
function hitPlane(ray, n, p0) { const t = ray.intersectPlane(new T.Plane().setFromNormalAndCoplanarPoint(n, p0), new T.Vector3()); return t; }
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
function triangulate(rays) {
  const A = new T.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0), b = new T.Vector3();
  let spread = 0;
  for (const r of rays) {
    const d = r.direction, o = r.origin;
    const M = new T.Matrix3().set(1 - d.x * d.x, -d.x * d.y, -d.x * d.z, -d.y * d.x, 1 - d.y * d.y, -d.y * d.z, -d.z * d.x, -d.z * d.y, 1 - d.z * d.z);
    for (let i = 0; i < 9; i++) A.elements[i] += M.elements[i];
    b.add(o.clone().applyMatrix3(M));
    for (const q of rays) spread = Math.max(spread, d.angleTo(q.direction));
  }
  if (rays.length < 3 || spread < 2.5 * D2R || Math.abs(A.determinant()) < 1e-6) return null;
  return b.applyMatrix3(A.clone().invert());
}
export function solve(obs, desk, head) {
  const items = [];
  for (const o of obs) for (const d of o.dets) {
    const ray = (u, v) => rayAt(o.viewer, o.cal, o.aspect, u, v);
    const [x, y, w, h] = d.box;
    if (d.kind === 'screen') {
      const c = ray(x + w / 2, y + h / 2);
      // first guess: a screen stands near the back of the desk
      const back = desk ? desk.center.clone().addScaledVector(desk.u, -Math.max(0.15, desk.backDist - 0.08)) : null;
      const rough = back ? hitPlane(c, desk.u, back) : c.at(0.7, new T.Vector3());
      if (rough) items.push({ kind: 'screen', d, o, ray: c, rough });
    } else if (desk) {
      const lift = new T.Vector3(0, desk.top + 0.015, 0);
      const cs = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([u, v]) => hitPlane(ray(u, v), UP, lift));
      if (cs.every(Boolean)) items.push({ kind: d.kind, d, o, corners: cs, rough: cs.reduce((a, p) => a.add(p), new T.Vector3()).multiplyScalar(0.25) });
    }
  }
  // group sightings of the same thing across frames
  const groups = [];
  for (const it of items) {
    const r = it.kind === 'screen' ? 0.3 : 0.15;
    const g = groups.find(g => g.kind === it.kind && g.rough.distanceTo(it.rough) < r);
    if (g) { g.items.push(it); g.rough.lerp(it.rough, 1 / g.items.length); } else groups.push({ kind: it.kind, rough: it.rough.clone(), items: [it] });
  }
  const minN = Math.max(2, Math.round(obs.length * 0.25)), out = [];
  for (const g of groups) {
    if (g.items.length < minN) continue;
    if (g.kind === 'screen') {
      let c = triangulate(g.items.map(i => i.ray));
      const ok = c && c.distanceTo(head) > 0.25 && c.distanceTo(head) < 1.6 && (!desk || (c.y > desk.top - 0.05 && c.y < desk.top + 0.9));
      if (!ok) c = new T.Vector3(median(g.items.map(i => i.rough.x)), median(g.items.map(i => i.rough.y)), median(g.items.map(i => i.rough.z)));
      if (c.distanceTo(head) > 1.6) continue;   // a bright window across the room isn't a monitor
      let n = new T.Vector3(head.x - c.x, 0, head.z - c.z).normalize();
      if (desk && n.dot(desk.u) > Math.cos(25 * D2R)) n = desk.u.clone();
      const e = new T.Vector3(n.z, 0, -n.x);
      const L = [], R = [], Tp = [], B = [];
      for (const { d, o } of g.items) {
        const [x, y, w, h] = d.box, at = (u, v) => hitPlane(rayAt(o.viewer, o.cal, o.aspect, u, v), n, c);
        const l = at(x, y + h / 2), r = at(x + w, y + h / 2), t = at(x + w / 2, y), b = at(x + w / 2, y + h);
        if (l && r && t && b) { L.push(l.sub(c).dot(e)); R.push(r.sub(c).dot(e)); Tp.push(t.y - c.y); B.push(b.y - c.y); }
      }
      if (!L.length) continue;
      const l = median(L), r = median(R), t = median(Tp), b = median(B);
      const w = r - l, h = t - b;
      if (w < 0.12 || w > 1.6 || h < 0.08 || h > 0.9) continue;
      c.addScaledVector(e, (l + r) / 2).y += (t + b) / 2;
      out.push({ kind: 'screen', matrix: new T.Matrix4().makeBasis(e, UP, n).setPosition(c), w, h, n: g.items.length, lit: g.items.some(i => i.d.lit) });
    } else {
      const e = desk.e, f = new T.Vector3().crossVectors(UP, e);   // f: across the desk, away from you
      const c0 = g.rough.clone(), E0 = [], E1 = [], F0 = [], F1 = [];
      for (const { corners } of g.items) {
        const pe = corners.map(p => p.clone().sub(c0).dot(e)), pf = corners.map(p => p.clone().sub(c0).dot(f));
        E0.push(Math.min(...pe)); E1.push(Math.max(...pe)); F0.push(Math.min(...pf)); F1.push(Math.max(...pf));
      }
      const e0 = median(E0), e1 = median(E1), f0 = median(F0), f1 = median(F1);
      const w = e1 - e0, h = f1 - f0;
      const max = g.kind === 'keyboard' ? [0.7, 0.35] : [0.2, 0.2];
      if (w < 0.04 || h < 0.04 || w > max[0] || h > max[1]) continue;
      const c = c0.addScaledVector(e, (e0 + e1) / 2).addScaledVector(f, (f0 + f1) / 2); c.y = desk.top;
      out.push({ kind: g.kind, matrix: new T.Matrix4().makeBasis(e, f, UP).setPosition(c), w, h, n: g.items.length });
    }
  }
  return out;
}

// ───────── a picture of what was seen, for checking ─────────
export function debugImage(canvas, viewer, cal, edges, dets, found) {
  const W = canvas.width, H = canvas.height, aspect = W / H;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), x = c.getContext('2d');
  x.drawImage(canvas, 0, 0);
  const P = projector(viewer, cal, aspect), line = (pts, col, wdt = 2) => {
    x.strokeStyle = col; x.lineWidth = wdt; x.beginPath(); let pen = false;
    for (const p of pts) { const q = P(p); if (!q) { pen = false; continue; } pen ? x.lineTo(q.u * W, q.v * H) : x.moveTo(q.u * W, q.v * H); pen = true; }
    x.stroke();
  };
  for (const [a, b] of edges) line([a, b], '#00e5ff', 2);
  const col = { screen: '#3dff7a', keyboard: '#ffd23d', mouse: '#ff8a3d' };
  for (const d of dets) {
    x.strokeStyle = col[d.kind]; x.setLineDash([6, 4]); x.lineWidth = 2; x.strokeRect(d.box[0] * W, d.box[1] * H, d.box[2] * W, d.box[3] * H); x.setLineDash([]);
    x.fillStyle = col[d.kind]; x.font = '14px sans-serif'; x.fillText(`${d.src} ${d.score.toFixed(2)}`, d.box[0] * W + 3, d.box[1] * H + 15);
  }
  for (const f of found) {
    const k = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => new T.Vector3(a * f.w / 2, b * f.h / 2, 0).applyMatrix4(f.matrix));
    line(k, '#ff2bd6', 3);
  }
  x.fillStyle = 'rgba(0,0,0,.6)'; x.fillRect(0, H - 24, W, 24); x.fillStyle = '#fff'; x.font = '13px sans-serif';
  x.fillText(`camera  fov ${cal.hfov}°  pitch ${cal.pitch}  yaw ${cal.yaw}  roll ${cal.roll}   cyan = scanned desk, dashed = seen, pink = placed`, 6, H - 8);
  return c;
}

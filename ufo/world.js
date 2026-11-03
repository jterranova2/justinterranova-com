import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// This file is the hot-swappable "world". index.html is a small shell that owns the renderer and the headset
// session; every time this file changes, the shell imports a fresh copy and the new copy replaces the old one,
// so edits appear while you are still inside the headset.
const SHELL = window.__ufoShell;
SHELL.world?.dispose();                      // hand over: tear the previous version down first
const { renderer, camera, controls, state } = SHELL;
const scene = new THREE.Group(); scene.name = 'world';   // everything this world draws hangs off this group
const ac = new AbortController(), signal = ac.signal;     // every DOM listener uses this, so dispose removes them
const xrListeners = [];
function on(target, type, fn) { target.addEventListener(type, fn); xrListeners.push([target, type, fn]); }

// ───────────────────────── settings (per-viewer, best effort) ─────────────────────────
const store = {
  get(k, d) { try { const v = localStorage.getItem('ufo.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ufo.' + k, JSON.stringify(v)); } catch {} },
};
const settings = {
  scene: store.get('scene', 'festival'),
  videoMode: store.get('videoMode', 'flat'),   // flat | 360 | 180
  yaw: store.get('yaw', 0),
  outline: store.get('outlineAll', false),   // outlines of every wall and piece of furniture (off: walls appear only up close)
  realFloor: store.get('realFloor', false),
  zoneSize: store.get('zoneSize', 0.4),
  desk: store.get('desk', null),         // set by touching the desk corners
  useScan: store.get('useScan', true),    // also trust the Quest's own room scan?
};
const saveSettings = () => { for (const k in settings) store.set(k === 'outline' ? 'outlineAll' : k, settings[k]); };

const SCENES = [
  { key: 'festival', label: 'Festival flyover' },
  { key: 'clouds',   label: 'Above the clouds' },
  { key: 'orbit',    label: 'Low orbit' },
  { key: 'video',    label: 'Festival cam' },
];
const VIDEO_MODES = ['flat', '360', '180'];
const ZONE_SIZES = [0.25, 0.4, 0.7];

// cabinRoot = the ship and everything outside it (rotatable to line the window up with your desk).
// realRoot  = masks for real things; never rotated, always in room coordinates.
const cabinRoot = new THREE.Group(); scene.add(cabinRoot);
const realRoot = new THREE.Group(); scene.add(realRoot);

// A mask draws nothing but writes depth, so anything virtual behind it is hidden and passthrough shows.
const maskMat = new THREE.MeshBasicMaterial({ colorWrite: false });
const edgeMat = new THREE.LineBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.45, depthTest: false });
const R_MASK = -100, R_SKY = -50, R_OVERLAY = 900, R_UI = 1000;

// ───────────────────────── shared GLSL ─────────────────────────
const NOISE = /* glsl */`
float hash(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return v; }
float stars(vec3 d,float scale,float thresh,float t){ vec3 p=d*scale; vec3 c=floor(p); float h=hash(c); if(h<thresh) return 0.0;
  vec3 o=vec3(hash(c+1.3),hash(c+2.7),hash(c+4.1))*0.6+0.2; float dist=length(p-(c+o));
  float tw=0.7+0.3*sin(t*(1.0+h*4.0)+h*60.0); return smoothstep(0.25,0.0,dist)*(h-thresh)/(1.0-thresh)*tw; }
`;
const SKY_VERT = `varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const WORLD_VERT = `varying vec3 vWP; varying vec3 vLP; varying vec2 vUv;
void main(){ vLP=position; vUv=uv; vec4 w=modelMatrix*vec4(position,1.0); vWP=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;

const clock = state.clock ??= { t: 0 };   // keeps animations continuous across updates
function makeSky(frag, uniforms = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, ...uniforms },
    vertexShader: SKY_VERT, fragmentShader: NOISE + frag,
    side: THREE.BackSide, depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), mat);
  m.renderOrder = R_SKY;
  return m;
}
function glowTexture(inner = 'rgba(255,255,255,1)') {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const GLOW = glowTexture();

// ───────────────────────── the UFO cabin ─────────────────────────
const HULL_R = 2.5, WIN_BOTTOM = 0.85, WIN_TOP = 2.3, ROOF = 2.55;
const WIN_HALF = THREE.MathUtils.degToRad(78);  // window spans ±78° around straight ahead (-Z)
// CylinderGeometry measures theta from +Z, so straight ahead (-Z) is theta = π.

const hullMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  vertexShader: WORLD_VERT,
  fragmentShader: NOISE + /* glsl */`
    uniform float uTime; varying vec3 vWP; varying vec3 vLP; varying vec2 vUv;
    void main(){
      vec2 g = abs(fract(vUv*vec2(56.0,5.0))-0.5);
      float seam = smoothstep(0.47,0.5,max(g.x,g.y));
      float grain = noise(vLP*9.0)*0.04;
      vec3 c = vec3(0.075,0.085,0.11) + grain - seam*0.035;
      gl_FragColor = vec4(c,1.0);
    }`,
  side: THREE.DoubleSide,
});
const glowMat = (hex) => new THREE.MeshBasicMaterial({ color: hex, toneMapped: false });

function buildCabin() {
  const g = new THREE.Group();
  const cyl = (y0, y1, start = 0, len = Math.PI * 2) => {
    const geo = new THREE.CylinderGeometry(HULL_R, HULL_R, y1 - y0, 96, 1, true, start, len);
    const m = new THREE.Mesh(geo, hullMat); m.position.y = (y0 + y1) / 2; return m;
  };
  g.add(cyl(-0.01, WIN_BOTTOM));                                                    // lower wall, all round
  g.add(cyl(WIN_TOP, ROOF));                                                        // upper band, all round
  g.add(cyl(WIN_BOTTOM, WIN_TOP, Math.PI + WIN_HALF, Math.PI * 2 - WIN_HALF * 2));  // back wall beside the window

  // Domed ceiling with concentric light rings
  const dome = new THREE.Mesh(new THREE.SphereGeometry(HULL_R, 64, 16, 0, Math.PI * 2, 0, Math.PI / 2), hullMat);
  dome.scale.y = 0.32; dome.position.y = ROOF; g.add(dome);
  for (const [r, y] of [[2.2, ROOF + 0.12], [1.5, ROOF + 0.24], [0.7, ROOF + 0.3]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 96), glowMat(0x5fd8ff));
    ring.rotation.x = Math.PI / 2; ring.position.y = y; g.add(ring);
  }

  // Floor
  const floor = new THREE.Mesh(new THREE.CircleGeometry(HULL_R, 96), new THREE.ShaderMaterial({
    vertexShader: WORLD_VERT,
    fragmentShader: NOISE + /* glsl */`
      varying vec3 vLP;
      void main(){ vec2 p=vLP.xy; float r=length(p);
        float rings = smoothstep(0.02,0.0,abs(fract(r*2.0)-0.5)-0.47);
        float spokes = smoothstep(0.01,0.0,abs(fract(atan(p.y,p.x)/6.2831*24.0)-0.5)-0.48);
        vec3 c = vec3(0.06,0.065,0.08) + noise(vec3(p*12.0,0.0))*0.025 + (rings+spokes)*vec3(0.02,0.05,0.07);
        c += vec3(0.1,0.5,0.7)*smoothstep(0.06,0.0,abs(r-2.42));
        gl_FragColor=vec4(c,1.0); }`,
  }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.005; floor.userData.kind = 'shipFloor'; g.add(floor);

  // Window trim and mullions
  for (const y of [WIN_BOTTOM, WIN_TOP]) {
    const trim = new THREE.Mesh(new THREE.TorusGeometry(HULL_R - 0.02, 0.014, 6, 96, WIN_HALF * 2), glowMat(0x7fe3ff));
    trim.rotation.x = Math.PI / 2; trim.rotation.z = Math.PI / 2 - WIN_HALF; trim.position.y = y; g.add(trim);
  }
  for (let i = -3; i <= 3; i++) {
    const a = Math.PI + (i / 3) * WIN_HALF;
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.035, WIN_TOP - WIN_BOTTOM, 0.05), hullMat);
    rib.position.set(HULL_R * Math.sin(a), (WIN_TOP + WIN_BOTTOM) / 2, HULL_R * Math.cos(a));
    rib.rotation.y = a; g.add(rib);
  }

  // Window glass: almost invisible, but it flashes white during a warp
  const glassMat = new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide });
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(HULL_R - 0.03, HULL_R - 0.03, WIN_TOP - WIN_BOTTOM, 96, 1, true, Math.PI - WIN_HALF, WIN_HALF * 2), glassMat);
  glass.position.y = (WIN_TOP + WIN_BOTTOM) / 2; glass.renderOrder = 10; g.add(glass);

  // Blinking console lights on the back wall
  const blinkers = [];
  for (let i = 0; i < 26; i++) {
    const a = Math.PI + WIN_HALF + 0.15 + (i / 26) * (Math.PI * 2 - WIN_HALF * 2 - 0.3);
    const hue = [0x5fd8ff, 0x8dff9a, 0xffc36b, 0xff6b9a][i % 4];
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.035), glowMat(hue));
    const r = HULL_R - 0.01, y = 1.0 + (i % 3) * 0.09;
    m.position.set(r * Math.sin(a), y, r * Math.cos(a)); m.lookAt(0, y, 0);
    m.userData.phase = Math.random() * 10; m.userData.rate = 0.4 + Math.random() * 1.6;
    blinkers.push(m); g.add(m);
  }
  return { group: g, glassMat, blinkers };
}
const cabin = buildCabin();
cabinRoot.add(cabin.group);

// ───────────────────────── scenes outside the window ─────────────────────────
function makeLedMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uBeat: { value: 0 } },
    vertexShader: WORLD_VERT,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform float uBeat; varying vec2 vUv;
      void main(){ vec2 uv=vUv;
        vec3 c = 0.5+0.5*cos(6.2831*(uv.x*1.5+uTime*0.15+vec3(0.0,0.33,0.67)));
        float bars = step(0.5, fract(uv.y*8.0 - uTime*0.5 + sin(uv.x*6.0+uTime)*0.3));
        c *= 0.35 + 0.45*bars + 0.6*uBeat;
        gl_FragColor=vec4(c,1.0); }`,
  });
}
function makeLaserMaterial(hue) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color().setHSL(hue, 1, 0.55) }, uOn: { value: 1 } },
    vertexShader: `varying float vV; void main(){ vV=uv.y; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uOn; varying float vV; void main(){ float a=pow(1.0-vV,2.0)*0.85*uOn; gl_FragColor=vec4(uColor*a,a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}
const beatAt = (t) => Math.exp(-((t * 128 / 60) % 1) * 7);   // 128 BPM pulse: 1 on the beat, then decays
function buildFestival() {
  const g = new THREE.Group();
  const sky = makeSky(/* glsl */`
    uniform float uTime; uniform float uBeat; varying vec3 vDir;
    void main(){ vec3 d=normalize(vDir); float y=d.y;
      vec3 col = mix(vec3(0.05,0.03,0.09), vec3(0.01,0.01,0.03), smoothstep(0.0,0.6,y));
      float front = 0.5+0.5*dot(normalize(d.xz+1e-4), vec2(0.0,-1.0));
      col += vec3(0.45,0.12,0.4)*exp(-max(y+0.05,0.0)*7.0)*front*(0.7+0.3*uBeat);
      col += vec3(0.9,0.9,1.0)*stars(d,260.0,0.975,uTime)*smoothstep(0.05,0.4,y);
      gl_FragColor=vec4(col,1.0); }`, { uBeat: { value: 0 } });
  g.add(sky);

  // We orbit the stage: everything hangs off a pivot that swings slowly left and right.
  const pivot = new THREE.Group(); pivot.position.set(0, -70, -260); g.add(pivot);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600), new THREE.MeshBasicMaterial({ color: 0x07060b }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.5; pivot.add(ground);

  // Crowd: phone lights, glow sticks, and tent lights farther out
  const N = 16000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), seed = new Float32Array(N);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const far = i > N * 0.8;
    const r = far ? 240 + Math.random() * 600 : 12 + 210 * Math.sqrt(Math.random());
    const a = far ? Math.random() * Math.PI * 2 : (Math.random() - 0.5) * Math.PI * 1.25;
    pos[i * 3] = Math.sin(a) * r; pos[i * 3 + 1] = 1.5 + Math.random() * 0.6; pos[i * 3 + 2] = Math.cos(a) * r + 20;
    if (far) c.setHSL(0.08 + Math.random() * 0.06, 0.8, 0.55);
    else if (Math.random() < 0.55) c.setRGB(1, 0.96, 0.88);
    else c.setHSL(Math.random(), 1, 0.6);
    col.set([c.r, c.g, c.b], i * 3); seed[i] = Math.random();
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  cg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  cg.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const crowdMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uBeat: { value: 0 }, uPx: { value: 1400 } },
    vertexShader: /* glsl */`
      attribute vec3 color; attribute float seed; uniform float uTime; uniform float uBeat; uniform float uPx;
      varying vec3 vC; varying float vA;
      void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv;
        float tw=0.5+0.5*sin(uTime*(1.2+seed*3.0)+seed*40.0);
        vA=0.3+0.7*tw + uBeat*step(0.65,seed)*1.2; vC=color;
        gl_PointSize=clamp(uPx*(0.8+seed*0.6)/-mv.z, 1.0, 10.0); }`,
    fragmentShader: /* glsl */`
      varying vec3 vC; varying float vA;
      void main(){ float d=length(gl_PointCoord-0.5); float a=smoothstep(0.5,0.0,d)*vA; gl_FragColor=vec4(vC*a,a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  pivot.add(new THREE.Points(cg, crowdMat));

  // Stage with an animated LED wall
  const stage = new THREE.Mesh(new THREE.BoxGeometry(90, 22, 26), new THREE.MeshBasicMaterial({ color: 0x0d0d14 }));
  stage.position.set(0, 11, -14); pivot.add(stage);
  const screenMat = makeLedMaterial();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(76, 16), screenMat);
  screen.position.set(0, 13, -0.9); pivot.add(screen);

  // Lasers fanning out over the crowd
  const laserGeo = new THREE.CylinderGeometry(0.22, 0.22, 260, 6, 1, true); laserGeo.translate(0, 130, 0);
  const lasers = [];
  for (let i = 0; i < 12; i++) {
    const l = new THREE.Mesh(laserGeo, makeLaserMaterial(i / 12));
    l.position.set((i - 5.5) * 7, 22, -2); l.userData.i = i; lasers.push(l); pivot.add(l);
  }
  // Haze glow above the crowd
  const haze = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: 0xb04dff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  haze.scale.set(360, 120, 1); haze.position.set(0, 30, 60); pivot.add(haze);

  return {
    group: g,
    update(t) {
      const beat = beatAt(t);
      sky.material.uniforms.uTime.value = t; sky.material.uniforms.uBeat.value = beat;
      crowdMat.uniforms.uTime.value = t; crowdMat.uniforms.uBeat.value = beat;
      screenMat.uniforms.uTime.value = t; screenMat.uniforms.uBeat.value = beat;
      crowdMat.uniforms.uPx.value = renderer.xr.isPresenting ? 1400 : 700 * renderer.getPixelRatio();
      pivot.rotation.y = Math.sin(t * 0.018) * 0.7;
      pivot.position.y = -70 + Math.sin(t * 0.05) * 5;
      haze.material.opacity = 0.25 + beat * 0.2;
      const section = Math.floor(t / 16) % 3;  // lasers change pattern every 16 s
      for (const l of lasers) {
        const i = l.userData.i;
        l.rotation.x = 0.35 + Math.sin(t * 0.6 + i * (section === 1 ? 0.0 : 0.5)) * 0.35;
        l.rotation.z = section === 2 ? Math.sin(t * 2.1 + i) * 0.9 : (i - 5.5) * 0.09 + Math.sin(t * 0.8) * 0.3;
        l.material.uniforms.uOn.value = section === 0 ? 0.5 + beat * 0.5 : 0.9;
        l.material.uniforms.uColor.value.setHSL((i / 12 + t * 0.03) % 1, 1, 0.55);
      }
    },
  };
}

function buildClouds() {
  const g = new THREE.Group();
  const sun = new THREE.Vector3(0.15, 0.06, -1).normalize();
  const sky = makeSky(/* glsl */`
    uniform float uTime; uniform vec3 uSun; varying vec3 vDir;
    void main(){ vec3 d=normalize(vDir); float y=d.y; float s=max(dot(d,uSun),0.0);
      vec3 col = mix(vec3(1.0,0.62,0.42), vec3(0.18,0.25,0.48), smoothstep(0.0,0.55,y));
      col = mix(col, vec3(0.55,0.35,0.45), smoothstep(0.0,-0.2,y));
      col += vec3(1.0,0.75,0.45)*(pow(s,8.0)*0.45 + pow(s,900.0)*6.0);
      gl_FragColor=vec4(col,1.0); }`, { uSun: { value: sun } });
  g.add(sky);
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSun: { value: sun } },
    vertexShader: WORLD_VERT,
    fragmentShader: NOISE + /* glsl */`
      uniform float uTime; uniform vec3 uSun; varying vec3 vWP; varying vec3 vLP;
      void main(){
        vec2 p = vec2(vLP.x, vLP.z - uTime*18.0)*0.0035;   // clouds stream toward you = you're flying forward
        float c = fbm(vec3(p, uTime*0.01));
        float m = smoothstep(0.38,0.68,c);
        float facing = 0.5+0.5*dot(normalize(vLP.xz+1e-3), normalize(uSun.xz));
        vec3 lit = mix(vec3(0.62,0.46,0.55), vec3(1.0,0.8,0.62), smoothstep(0.45,0.85,c)*facing);
        vec3 col = mix(vec3(0.28,0.22,0.36), lit, m);
        float dist = length(vWP - cameraPosition);
        col = mix(col, vec3(0.95,0.62,0.5), 1.0-exp(-dist*0.0012));
        gl_FragColor = vec4(col,1.0); }`,
  });
  const clouds = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000, 1, 1).rotateX(-Math.PI / 2), cloudMat);
  clouds.position.y = -40; g.add(clouds);
  return { group: g, update(t) { sky.material.uniforms.uTime.value = t; cloudMat.uniforms.uTime.value = t; } };
}

function buildOrbit() {
  const g = new THREE.Group();
  const sun = new THREE.Vector3();
  const sky = makeSky(/* glsl */`
    uniform float uTime; uniform vec3 uSun; varying vec3 vDir;
    void main(){ vec3 d=normalize(vDir); vec3 col=vec3(0.0);
      col += vec3(1.0,0.95,0.9)*stars(d,180.0,0.965,uTime)*2.0 + vec3(0.8,0.85,1.0)*stars(d,420.0,0.985,uTime);
      vec3 bandN=normalize(vec3(0.4,1.0,0.25)); float band=exp(-pow(dot(d,bandN),2.0)*25.0);
      col += vec3(0.32,0.28,0.42)*band*fbm(d*5.0)*0.6;
      float s=max(dot(d,uSun),0.0); col += vec3(1.0,0.95,0.85)*(pow(s,3000.0)*30.0+pow(s,60.0)*0.25+pow(s,6.0)*0.04);
      gl_FragColor=vec4(col,1.0); }`, { uSun: { value: sun } });
  g.add(sky);
  const earthSun = new THREE.Vector3();
  const earthMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSun: { value: earthSun } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vWN; varying vec3 vWP;
      void main(){ vN=normal; vWN=normalize(mat3(modelMatrix)*normal); vec4 w=modelMatrix*vec4(position,1.0); vWP=w.xyz;
        gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: NOISE + /* glsl */`
      uniform float uTime; uniform vec3 uSun; varying vec3 vN; varying vec3 vWN; varying vec3 vWP;
      void main(){ vec3 n=normalize(vN); vec3 wn=normalize(vWN);
        float c=fbm(n*2.5+vec3(3.1)); float land=smoothstep(0.5,0.53,c);
        vec3 ocean=mix(vec3(0.01,0.05,0.18),vec3(0.02,0.12,0.3),fbm(n*8.0));
        vec3 ground=mix(vec3(0.12,0.22,0.07),vec3(0.42,0.34,0.2),smoothstep(0.55,0.7,c+fbm(n*12.0)*0.15));
        vec3 col=mix(ocean,ground,land); col=mix(col,vec3(0.9),smoothstep(0.78,0.86,abs(n.y)+fbm(n*6.0)*0.1));
        float cl=smoothstep(0.5,0.75,fbm(n*5.0+vec3(uTime*0.004,0.0,uTime*0.002)));
        float diff=dot(wn,uSun); float day=smoothstep(-0.15,0.25,diff);
        vec3 lit=col*max(diff,0.0)*1.3; lit=mix(lit,vec3(1.0)*max(diff,0.0),cl*0.85);
        float city=land*(1.0-cl)*step(0.82,hash(floor(n*260.0)))*fbm(n*20.0);
        vec3 night=vec3(1.0,0.7,0.35)*city*0.9*(1.0-day);
        vec3 V=normalize(cameraPosition-vWP); float rim=pow(1.0-max(dot(wn,V),0.0),3.0);
        vec3 atm=vec3(0.3,0.55,1.0)*rim*smoothstep(-0.3,0.4,diff)*1.4;
        gl_FragColor=vec4(lit+night+atm,1.0); }`,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(600, 128, 64), earthMat);
  earth.position.set(0, -640, -250); g.add(earth);
  return {
    group: g,
    update(t) {
      const a = (t / 600) * Math.PI * 2 + 1.2;            // a sunrise every 10 minutes
      sun.set(Math.cos(a), 0.25, Math.sin(a)).normalize();
      earthSun.copy(sun).applyQuaternion(cabinRoot.quaternion);  // Earth lighting is computed in world space
      sky.material.uniforms.uTime.value = t; earthMat.uniforms.uTime.value = t;
      earth.rotation.y = t * 0.004;
    },
  };
}

// Your own footage: flat video on a giant curved screen ~30 m outside, or 360/180 video wrapped all around.
const video = state.video ??= Object.assign(document.createElement('video'), { loop: true, playsInline: true, crossOrigin: 'anonymous' });
let videoLoaded = !!state.videoLoaded;
// Demo clip for when no video is loaded: a generated "festival cam" rendered every frame into a 1280×720
// texture, so it reaches the window by exactly the same path a real video does.
let demoPaused = false;
function buildDemoCam() {
  const W = 1280, H = 720;
  const rt = new THREE.WebGLRenderTarget(W, H);
  rt.texture.wrapS = THREE.RepeatWrapping; rt.texture.repeat.x = -1;   // mirrored, same as the flat video texture
  rt.texture.colorSpace = THREE.SRGBColorSpace;   // store as sRGB so shader colours and material colours both come out as authored
  const s = new THREE.Scene(); s.fog = new THREE.FogExp2(0x160a26, 0.012);
  const cam = new THREE.PerspectiveCamera(64, W / H, 0.1, 2000); s.add(cam);

  const sky = makeSky(/* glsl */`
    uniform float uTime; uniform float uBeat; varying vec3 vDir;
    void main(){ vec3 d=normalize(vDir); float y=d.y;
      vec3 col = mix(vec3(0.09,0.04,0.14), vec3(0.01,0.01,0.04), smoothstep(0.0,0.5,y));
      col += vec3(0.5,0.15,0.45)*exp(-max(y,0.0)*6.0)*(0.6+0.4*uBeat);
      col += vec3(0.9)*stars(d,240.0,0.98,uTime)*smoothstep(0.1,0.5,y);
      gl_FragColor=vec4(col,1.0); }`, { uBeat: { value: 0 } });
  s.add(sky);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: 0x0b0812 }));
  ground.rotation.x = -Math.PI / 2; s.add(ground);

  // Stage straight ahead
  const STAGE_Z = -90;
  const stage = new THREE.Mesh(new THREE.BoxGeometry(46, 16, 10), new THREE.MeshBasicMaterial({ color: 0x0c0b12 }));
  stage.position.set(0, 8, STAGE_Z - 5); s.add(stage);
  const led = makeLedMaterial();
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(36, 11), led); wall.position.set(0, 9, STAGE_Z + 0.1); s.add(wall);
  for (const x of [-27, 27]) {   // side screens
    const side = new THREE.Mesh(new THREE.PlaneGeometry(8, 12), led); side.position.set(x, 10, STAGE_Z + 2); s.add(side);
  }
  const laserGeo = new THREE.CylinderGeometry(0.12, 0.12, 160, 6, 1, true); laserGeo.translate(0, 80, 0);
  const lasers = [];
  for (let i = 0; i < 10; i++) {
    const l = new THREE.Mesh(laserGeo, makeLaserMaterial(i / 10));
    l.position.set((i - 4.5) * 4.2, 16, STAGE_Z + 1); l.userData.i = i; lasers.push(l); s.add(l);
  }
  const spotGeo = new THREE.CylinderGeometry(0.15, 4, 34, 20, 1, true); spotGeo.translate(0, -17, 0);
  const spots = [];
  for (let i = 0; i < 6; i++) {   // white spotlights from the truss, sweeping the crowd
    const sp = new THREE.Mesh(spotGeo, makeLaserMaterial(0)); sp.material.uniforms.uColor.value.setRGB(0.55, 0.55, 0.6);
    sp.position.set((i - 2.5) * 8, 19, STAGE_Z + 6); sp.userData.i = i; spots.push(sp); s.add(sp);
  }
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: 0xc050ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  glow.scale.set(120, 50, 1); glow.position.set(0, 14, STAGE_Z + 3); s.add(glow);

  // Crowd: silhouettes, some with hands up, jumping on the beat
  const body = new THREE.CylinderGeometry(0.19, 0.23, 1.4, 6); body.translate(0, 0.7, 0);
  const head = new THREE.SphereGeometry(0.13, 8, 6); head.translate(0, 1.58, 0);
  const armL = new THREE.BoxGeometry(0.08, 0.72, 0.08); armL.translate(0, 0.36, 0); armL.rotateZ(0.35); armL.translate(-0.2, 1.34, 0);
  const armR = new THREE.BoxGeometry(0.08, 0.72, 0.08); armR.translate(0, 0.36, 0); armR.rotateZ(-0.35); armR.translate(0.2, 1.34, 0);
  // mergeGeometries needs matching attributes; strip to position only (MeshBasicMaterial needs nothing else).
  const strip = (g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (k !== 'position') n.deleteAttribute(k); return n; };
  const personGeo = mergeGeometries([body, head].map(strip));
  const handsUpGeo = mergeGeometries([body, head, armL, armR].map(strip));
  const crowdMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const N = 2200, people = [];
  const meshes = [new THREE.InstancedMesh(personGeo, crowdMat, N), new THREE.InstancedMesh(handsUpGeo, crowdMat, N)];
  const counts = [0, 0], col = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const z = STAGE_Z + 8 + 105 * Math.pow(Math.random(), 1.25);   // denser near the stage
    const x = (Math.random() - 0.5) * (30 + (z - STAGE_Z) * 0.5);
    const kind = Math.random() < 0.35 ? 1 : 0, idx = counts[kind]++;
    const v = 0.012 + Math.random() * 0.025; col.setRGB(v, v * 0.9, v * 1.2);
    meshes[kind].setColorAt(idx, col);
    people.push({ kind, idx, x, z, yaw: (Math.random() - 0.5) * 0.8, sc: 0.9 + Math.random() * 0.22, seed: Math.random(), jumper: Math.random() < 0.45 });
  }
  meshes.forEach((m, k) => { m.count = counts[k]; m.instanceColor.needsUpdate = true; m.frustumCulled = false; s.add(m); });

  // Phone screens held up in the crowd
  const PN = 260, phonePos = new Float32Array(PN * 3);
  for (let i = 0; i < PN; i++) { const p = people[(Math.random() * N) | 0]; phonePos.set([p.x + 0.25, 2.05 + Math.random() * 0.2, p.z], i * 3); }
  const phoneGeo = new THREE.BufferGeometry(); phoneGeo.setAttribute('position', new THREE.BufferAttribute(phonePos, 3));
  s.add(new THREE.Points(phoneGeo, new THREE.PointsMaterial({ color: 0xfff6e8, size: 0.09, map: GLOW, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));

  // Confetti drifting around the camera
  const CN = 900, cPos = new Float32Array(CN * 3), cCol = new Float32Array(CN * 3);
  for (let i = 0; i < CN; i++) { col.setHSL(Math.random(), 1, 0.6); cCol.set([col.r, col.g, col.b], i * 3); cPos.set([0, -100, 0], i * 3); }
  const confGeo = new THREE.BufferGeometry();
  confGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3)); confGeo.setAttribute('color', new THREE.BufferAttribute(cCol, 3));
  const confetti = new THREE.Points(confGeo, new THREE.PointsMaterial({ size: 0.06, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
  confetti.frustumCulled = false; s.add(confetti);
  let confettiAt = 0;

  // "REC" overlay so it reads as phone footage
  const recC = document.createElement('canvas'); recC.width = 256; recC.height = 64; const rx = recC.getContext('2d');
  const recTex = new THREE.CanvasTexture(recC); recTex.colorSpace = THREE.SRGBColorSpace;
  const rec = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.04), new THREE.MeshBasicMaterial({ map: recTex, transparent: true, depthTest: false, fog: false, toneMapped: false }));
  rec.position.set(-0.52, 0.27, -0.6); rec.renderOrder = 10; cam.add(rec);
  let recSec = -1;

  const _mm = new THREE.Matrix4(), _qq = new THREE.Quaternion(), _pp = new THREE.Vector3(), _ss = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const look = new THREE.Vector3();
  let time = 0;
  return {
    renderTarget: rt,
    texture: rt.texture,
    update(dt) {
      time += dt; const t = time, beat = beatAt(t), bp = (t * 128 / 60) % 1;
      // Selfie-stick camera: held ~2.7 m up, walking slowly toward the stage, bobbing and swaying.
      // The clip "cuts" back to the start every 75 s, like a looping video.
      const walk = (t * 0.7) % 52.5;
      cam.position.set(Math.sin(t * 0.13) * 3 + Math.sin(t * 0.9) * 0.05, 2.7 + Math.sin(t * 5.4) * 0.035 + Math.sin(t * 0.4) * 0.12, 12 - walk);
      look.set(Math.sin(t * 0.21) * 7 + Math.sin(t * 0.05) * 10, 6 + Math.sin(t * 0.17) * 2, STAGE_Z);
      cam.lookAt(look);
      cam.rotateZ(Math.sin(t * 0.7) * 0.035 + Math.sin(t * 2.3) * 0.006);   // hand roll + jitter
      cam.rotateX(Math.sin(t * 3.1) * 0.004); cam.rotateY(Math.sin(t * 2.7) * 0.004);

      sky.material.uniforms.uTime.value = t; sky.material.uniforms.uBeat.value = beat;
      led.uniforms.uTime.value = t; led.uniforms.uBeat.value = beat;
      glow.material.opacity = 0.35 + beat * 0.3;
      const section = Math.floor(t / 15) % 3;
      for (const l of lasers) {
        const i = l.userData.i;
        l.rotation.x = 0.55 + Math.sin(t * 0.7 + i * 0.4) * 0.3;
        l.rotation.z = section === 2 ? Math.sin(t * 2 + i) * 0.8 : (i - 4.5) * 0.12 + Math.sin(t * 0.9) * 0.35;
        l.material.uniforms.uOn.value = section === 0 ? 0.4 + beat * 0.6 : 0.9;
        l.material.uniforms.uColor.value.setHSL((i / 10 + t * 0.04) % 1, 1, 0.55);
      }
      for (const sp of spots) { const i = sp.userData.i; sp.rotation.x = -0.5 + Math.sin(t * 0.5 + i) * 0.35; sp.rotation.z = Math.sin(t * 0.33 + i * 1.7) * 0.45; sp.material.uniforms.uOn.value = 0.12 + beat * 0.08; }
      crowdMat.color.setRGB(0.45 + beat * 0.7, 0.4 + beat * 0.35, 0.55 + beat * 0.7);   // stage light washing over the crowd

      const jump = Math.max(0, Math.sin(bp * Math.PI * 2)) ** 1.5 * 0.28;
      for (const p of people) {
        const y = p.jumper ? jump * (0.7 + p.seed * 0.6) : Math.sin(t * 2 + p.seed * 9) * 0.02;
        _qq.setFromAxisAngle(up, p.yaw + Math.sin(t * 0.8 + p.seed * 7) * 0.15);
        _mm.compose(_pp.set(p.x, y, p.z), _qq, _ss.setScalar(p.sc));
        meshes[p.kind].setMatrixAt(p.idx, _mm);
      }
      meshes[0].instanceMatrix.needsUpdate = meshes[1].instanceMatrix.needsUpdate = true;

      // A confetti burst every 30 s, then it drifts down
      if (t >= confettiAt) {
        confettiAt = t + 30;
        for (let i = 0; i < CN; i++) cPos.set([cam.position.x + (Math.random() - 0.5) * 16, 8 + Math.random() * 6, cam.position.z - 2 - Math.random() * 18], i * 3);
      }
      for (let i = 0; i < CN; i++) {
        cPos[i * 3] += Math.sin(t * 1.5 + i) * 0.004; cPos[i * 3 + 1] -= dt * (0.5 + (i % 7) * 0.08);
        if (cPos[i * 3 + 1] < 0) cPos[i * 3 + 1] = -100;
      }
      confGeo.attributes.position.needsUpdate = true;

      const sec = Math.floor(walk / 0.7);
      if (sec !== recSec) {
        recSec = sec; rx.clearRect(0, 0, 256, 64);
        rx.fillStyle = sec % 2 ? '#ff3b3b' : 'rgba(255,59,59,0.35)'; rx.beginPath(); rx.arc(22, 32, 11, 0, Math.PI * 2); rx.fill();
        rx.fillStyle = '#fff'; rx.font = '600 30px system-ui';
        rx.fillText('REC  ' + String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'), 44, 43);
        recTex.needsUpdate = true;
      }
    },
    render() {
      // During a headset session, switch XR off for a moment so this draws into our texture, then restore it.
      const prev = renderer.getRenderTarget(), xrOn = renderer.xr.enabled;
      renderer.xr.enabled = false;
      renderer.setRenderTarget(rt); renderer.render(s, cam);
      renderer.xr.enabled = xrOn; renderer.setRenderTarget(prev);
    },
  };
}
function buildVideo() {
  const g = new THREE.Group();
  const sky = makeSky(/* glsl */`
    uniform float uTime; varying vec3 vDir;
    void main(){ vec3 d=normalize(vDir); vec3 col=vec3(0.01,0.012,0.025)+vec3(0.9)*stars(d,220.0,0.975,uTime)*0.8; gl_FragColor=vec4(col,1.0); }`);
  g.add(sky);
  const demo = buildDemoCam();
  g.userData.rt = demo.renderTarget;
  const vtexFlat = new THREE.VideoTexture(video); vtexFlat.colorSpace = THREE.SRGBColorSpace;
  vtexFlat.wrapS = THREE.RepeatWrapping; vtexFlat.repeat.x = -1;   // seen from inside the cylinder, so mirror it back
  const vtexSphere = new THREE.VideoTexture(video); vtexSphere.colorSpace = THREE.SRGBColorSpace;

  const RAD = 30, ARC = THREE.MathUtils.degToRad(80);
  const flatMat = new THREE.MeshBasicMaterial({ map: demo.texture, side: THREE.BackSide, toneMapped: false });
  const flat = new THREE.Mesh(new THREE.BufferGeometry(), flatMat);
  function sizeFlat(aspect) {
    const h = (RAD * ARC) / aspect;
    flat.geometry.dispose();
    flat.geometry = new THREE.CylinderGeometry(RAD, RAD, h, 96, 1, true, Math.PI - ARC / 2, ARC);
    flat.position.y = 1.2 + h * 0.18;   // centred a little above eye level so the window frames it
  }
  sizeFlat(16 / 9); g.add(flat);

  const sphMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const g360 = new THREE.SphereGeometry(60, 96, 48); g360.scale(-1, 1, 1);
  const g180 = new THREE.SphereGeometry(60, 64, 48, Math.PI / 2, Math.PI); g180.scale(-1, 1, 1);
  const sph = new THREE.Mesh(g360, sphMat); sph.rotation.y = -Math.PI / 2; sph.position.y = 1.2; g.add(sph);

  return {
    group: g,
    sizeFlat,
    refresh() {
      const mode = videoLoaded ? settings.videoMode : 'flat';   // the demo clip is ordinary 16:9 footage
      flat.visible = mode === 'flat'; sph.visible = mode !== 'flat';
      sph.geometry = mode === '180' ? g180 : g360;
      sizeFlat(videoLoaded && video.videoWidth ? video.videoWidth / video.videoHeight : 16 / 9);
      flatMat.map = videoLoaded ? vtexFlat : demo.texture; flatMat.needsUpdate = true;
      sphMat.map = videoLoaded ? vtexSphere : null; sphMat.needsUpdate = true;
    },
    update(t, dt) {
      sky.material.uniforms.uTime.value = t;
      if (!videoLoaded) { if (!demoPaused) demo.update(dt); demo.render(); }
      // In an immersive session the page's own video-frame callbacks may not fire, so push frames ourselves.
      if (videoLoaded && !video.paused && video.readyState >= 2) { vtexFlat.needsUpdate = true; vtexSphere.needsUpdate = true; }
    },
  };
}

const builders = { festival: buildFestival, clouds: buildClouds, orbit: buildOrbit, video: buildVideo };
const built = {};
function getScene(key) {
  if (!built[key]) { built[key] = builders[key](); cabinRoot.add(built[key].group); built[key].refresh?.(); }
  return built[key];
}
let current = null;
let warp = null; // { t0, to }
function showScene(key) {
  for (const k in built) built[k].group.visible = k === key;
  current = getScene(key); current.group.visible = true;
  if (key === 'video' && videoLoaded) video.play().catch(() => {});
  else if (key !== 'video') video.pause();
}
function warpTo(key) {
  if (key === settings.scene && current) return;
  settings.scene = key; saveSettings(); refreshUI();
  setSceneAudio(key);
  warp = { t0: clock.t, to: key, swapped: false };
}

// ───────────────────────── audio (all synthesized, no files) ─────────────────────────
let actx = state.actx || null, master = null, sceneAudio = null;
const audioNodes = [];
const buffers = {};
function ensureAudio() {
  if (master) { actx.resume(); return; }
  if (!actx) { try { actx = state.actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } }
  master = actx.createGain(); master.gain.value = 0.8; master.connect(actx.destination);
  startHum(); setSceneAudio(settings.scene);
}
function noiseBuffer(type) {
  if (buffers[type]) return buffers[type];
  const len = actx.sampleRate * 3, b = actx.createBuffer(1, len, actx.sampleRate), d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; if (type === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
  return (buffers[type] = b);
}
function noiseSrc(type) { const s = actx.createBufferSource(); s.buffer = noiseBuffer(type); s.loop = true; s.start(); return s; }
function filt(type, freq, q = 0.7) { const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; }
function startHum() {
  const g = actx.createGain(); g.gain.value = 0.045; const lp = filt('lowpass', 150); lp.connect(g); g.connect(master);
  for (const f of [43.6, 44.05, 87.3]) { const o = actx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(); audioNodes.push(o); }
  const lfo = actx.createOscillator(); lfo.frequency.value = 0.13; const lg = actx.createGain(); lg.gain.value = 0.015;
  lfo.connect(lg); lg.connect(g.gain); lfo.start(); audioNodes.push(lfo);
}
function kick(dest) {
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.16);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.55, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.4);
}
function blip(dest) {
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = 660 + Math.random() * 600; g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.03, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.3);
}
function setSceneAudio(key) {
  if (!actx) return;
  if (sceneAudio) {
    const old = sceneAudio; const t = actx.currentTime;
    old.out.gain.cancelScheduledValues(t); old.out.gain.setValueAtTime(old.out.gain.value, t); old.out.gain.linearRampToValueAtTime(0, t + 1.2);
    old.timers.forEach(clearInterval);
    setTimeout(() => { old.nodes.forEach(n => { try { n.stop(); } catch {} }); old.out.disconnect(); }, 1500);
  }
  const out = actx.createGain(), nodes = [], timers = [];
  out.gain.value = 0; out.connect(master);
  if (key === 'festival') {
    const muffled = filt('lowpass', 380); muffled.connect(out);          // heard through the hull
    timers.push(setInterval(() => kick(muffled), 60000 / 128));
    const crowd = noiseSrc('white'), bp = filt('bandpass', 900), cg = actx.createGain(); cg.gain.value = 0.025;
    crowd.connect(bp); bp.connect(cg); cg.connect(out); nodes.push(crowd);
  } else if (key === 'clouds') {
    const wind = noiseSrc('brown'), bp = filt('bandpass', 520, 0.6), wg = actx.createGain(); wg.gain.value = 0.2;
    const lfo = actx.createOscillator(); lfo.frequency.value = 0.07; const lg = actx.createGain(); lg.gain.value = 0.1;
    lfo.connect(lg); lg.connect(wg.gain); lfo.start();
    wind.connect(bp); bp.connect(wg); wg.connect(out); nodes.push(wind, lfo);
  } else if (key === 'orbit') {
    timers.push(setInterval(() => { if (Math.random() < 0.35) blip(out); }, 4000));
    const air = noiseSrc('white'), bp = filt('bandpass', 2400, 0.5), ag = actx.createGain(); ag.gain.value = 0.006;
    air.connect(bp); bp.connect(ag); ag.connect(out); nodes.push(air);
  }
  const t = actx.currentTime; out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(1, t + 1.5);
  sceneAudio = { out, nodes, timers };
}

// ───────────────────────── real-world masks: planes from Space Setup ─────────────────────────
// Space Setup labels: wall, floor, ceiling, table, couch, door, window, screen, storage, bed, lamp, plant, other…
const REPLACED = new Set(['wall', 'ceiling', 'window', 'wall_art', 'wall art']);  // these become the ship
const FLIP = new THREE.Matrix4().makeRotationX(Math.PI);
function buildPlaneObject(label, orientation, polygon, matrix) {
  // The Quest reports desks, floors and shelves with their local +Y pointing down. Turn those upright first
  // (and mirror the outline to match), otherwise "from the floor up to the desk top" goes upward from the desk.
  const flip = orientation === 'horizontal' && matrix.elements[5] < 0;
  if (flip) { matrix = matrix.clone().multiply(FLIP); polygon = polygon.map(p => ({ x: p.x, y: 0, z: -p.z })); }
  const g = new THREE.Group(); g.matrixAutoUpdate = false; g.matrix.copy(matrix); g.matrixWorldNeedsUpdate = true;
  g.userData.flip = flip; g.userData.polygon = polygon;
  const lbl = (label || 'other').toLowerCase(); g.userData.label = lbl;
  if (REPLACED.has(lbl)) {
    if (lbl === 'wall') {       // faint outline of your real walls so you never walk into one
      const pts = polygon.map(p => new THREE.Vector3(p.x, 0, p.z));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), edgeMat);
      line.renderOrder = R_OVERLAY; line.userData.kind = 'outline'; g.add(line);
    }
    return g;
  }
  const shape = new THREE.Shape(polygon.map(p => new THREE.Vector2(p.x, -p.z)));
  let depth, offset;
  if (lbl === 'floor') { depth = 0.005; offset = 0; }
  else if (orientation === 'horizontal') {
    // Keep the whole thing real from the floor up to just above its top, so legs, chair and keyboard stay visible
    // without opening a big hole into your real wall behind the desk.
    const top = matrix.elements[13] - floorLevel(); depth = top + 0.04; offset = -top;   // height above the real floor
  } else { depth = 0.3; offset = -0.15; }    // vertical things (door, monitor): a thin slab
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2); geo.translate(0, offset, 0);
  const mesh = new THREE.Mesh(geo, maskMat); mesh.renderOrder = R_MASK;
  if (lbl === 'floor') { mesh.userData.kind = 'floor'; g.add(mesh); return g; }
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMat);
  edges.renderOrder = R_OVERLAY; edges.userData.kind = 'outline';
  g.add(edges);
  // Only things within reach stay real; far furniture (shelves across the room) becomes ship, outline only,
  // so it doesn't poke up into the window. Desks always stay real.
  const far = lbl !== 'table' && renderer.xr.isPresenting &&
    new THREE.Vector3().setFromMatrixPosition(matrix).setY(0).distanceTo(headPose().head.setY(0)) > 1.6;
  if (!far) g.add(mesh);
  return g;
}
// Where the real floor is, in headset coordinates. With 'local' tracking, 0 is your head height when you boarded,
// so until the room scan reports the floor, assume you're seated (floor ~1.2 m below).
function floorLevel() { return state.floorLevel ?? (renderer.xr.isPresenting ? -1.2 : 0); }
function disposeObj(o) { o.traverse(c => c.geometry?.dispose()); o.removeFromParent(); }
function applyVisibility() {
  scene.traverse(o => {
    if (o.userData.kind === 'outline') o.visible = settings.outline;
    if (o.userData.kind === 'floor') o.visible = settings.realFloor;
  });
  const d = desk || scanDesk;   // a desk you set by touch wins over the Quest's scan
  cabinRoot.rotation.y = (d ? d.theta : 0) + THREE.MathUtils.degToRad(settings.yaw);
  if (d) cabinRoot.position.set(d.seat.x, cabinRoot.position.y, d.seat.z); else cabinRoot.position.set(0, cabinRoot.position.y, 0);   // centred on your chair
}

const planeObjs = new Map();
function syncPlanes(frame, ref) {
  const seen = new Set();
  frame.detectedPlanes.forEach(plane => {
    seen.add(plane);
    const pose = frame.getPose(plane.planeSpace, ref); if (!pose) return;
    let rec = planeObjs.get(plane);
    if (!rec || rec.t !== plane.lastChangedTime) {
      if (rec) disposeObj(rec.obj);
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const obj = buildPlaneObject(plane.semanticLabel, plane.orientation, plane.polygon, m);
      realRoot.add(obj); rec = { obj, t: plane.lastChangedTime }; planeObjs.set(plane, rec);
      applyVisibility();
    }
    rec.obj.matrix.fromArray(pose.transform.matrix); if (rec.obj.userData.flip) rec.obj.matrix.multiply(FLIP);
    rec.obj.matrixWorldNeedsUpdate = true;
    if (rec.obj.userData.label === 'table' && !rec.aligned) { rec.aligned = true; deskFromScan(rec.obj); }
  });
  for (const [plane, rec] of planeObjs) if (!seen.has(plane)) { disposeObj(rec.obj); planeObjs.delete(plane); }
}

// A pretend room for the desktop preview: desk, monitor, door, walls.
const fakeRoom = new THREE.Group(); realRoot.add(fakeRoom);
function addFake(label, orientation, w, d, pos, yaw = 0, vertical = false) {
  const m = new THREE.Matrix4().makeRotationY(yaw);
  if (vertical) m.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  m.setPosition(...pos);
  const poly = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => ({ x, y: 0, z }));
  fakeRoom.add(buildPlaneObject(label, orientation, poly, m));
}
addFake('table', 'horizontal', 1.4, 0.7, [0, 0.74, -0.75]);
addFake('screen', 'vertical', 0.62, 0.36, [0, 1.02, -0.95], 0, true);
addFake('door', 'vertical', 0.9, 2.0, [1.99, 1.0, 0.6], -Math.PI / 2, true);
addFake('floor', 'horizontal', 4, 4, [0, 0, 0]);
for (const [x, z, yaw] of [[0, -2, 0], [0, 2, Math.PI], [2, 0, -Math.PI / 2], [-2, 0, Math.PI / 2]]) addFake('wall', 'vertical', 4, 2.5, [x, 1.25, z], yaw, true);

// ───────────────────────── custom "keep real" zones with persistent anchors ─────────────────────────
const zoneEdgeMat = new THREE.LineBasicMaterial({ color: 0xffc36b, transparent: true, opacity: 0.6, depthTest: false });
let zones = [];
const pendingZones = [];
function makeZoneObj(size) {
  const g = new THREE.Group(); g.matrixAutoUpdate = false;
  const geo = new THREE.BoxGeometry(size, size, size);
  const m = new THREE.Mesh(geo, maskMat); m.renderOrder = R_MASK;
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), zoneEdgeMat); e.renderOrder = R_OVERLAY; e.userData.kind = 'outline';
  g.add(m, e); realRoot.add(g); applyVisibility(); return g;
}
const saveZones = () => store.set('zones', zones.map(z => ({ uuid: z.uuid, size: z.size, pos: z.pos })));
async function placeZone(frame, ref, p) {
  const z = { obj: makeZoneObj(settings.zoneSize), size: settings.zoneSize, pos: [p.x, p.y, p.z], uuid: null, anchor: null };
  z.obj.matrix.makeTranslation(p.x, p.y, p.z); z.obj.matrixWorldNeedsUpdate = true;
  zones.push(z); saveZones();
  if (!frame.createAnchor) { setStatus('Zone added (this browser can’t save anchors, so it may drift next time)'); return; }
  try {
    // createAnchor must be called synchronously inside the XR frame; everything after the await is fine.
    z.anchor = await frame.createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }), ref);
    if (z.anchor.requestPersistentHandle) z.uuid = await z.anchor.requestPersistentHandle();
    if (z.uuid) (state.anchors ??= {})[z.uuid] = z.anchor;
    saveZones(); setStatus(z.uuid ? 'Real zone saved, and it will be there next time' : 'Real zone added');
  } catch (e) { console.warn('anchor failed', e); setStatus('Zone added (anchor failed: ' + e.message + ')'); }
}
function restoreZones(session) {
  for (const s of store.get('zones', [])) {
    const z = { obj: makeZoneObj(s.size), size: s.size, pos: s.pos, uuid: s.uuid, anchor: null };
    z.obj.matrix.makeTranslation(...s.pos); z.obj.matrixWorldNeedsUpdate = true; zones.push(z);
    const cached = s.uuid && state.anchors?.[s.uuid];
    if (cached) z.anchor = cached;
    else if (s.uuid && session.restorePersistentAnchor)
      session.restorePersistentAnchor(s.uuid).then(a => { z.anchor = a; (state.anchors ??= {})[s.uuid] = a; }).catch(e => console.warn('restore failed', e));
  }
}
function clearZones() {
  const session = renderer.xr.getSession();
  for (const z of zones) {
    if (z.uuid && session?.deletePersistentAnchor) session.deletePersistentAnchor(z.uuid).catch(() => {});
    z.anchor?.delete?.(); disposeObj(z.obj);
  }
  zones = []; store.set('zones', []); setStatus('Real zones cleared');
}

// ───────────────────────── passthrough hands & controllers ─────────────────────────
// Hands are drawn as masks, so you see your real hands everywhere, even in front of the window.
const CHAINS = [
  ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ...['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'].map(f =>
    ['wrist', `${f}-metacarpal`, `${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`]),
];
const sphereGeo = new THREE.SphereGeometry(1, 10, 8);
const handMasks = [0, 1].map(() => { const m = new THREE.InstancedMesh(sphereGeo, maskMat, 128); m.renderOrder = R_MASK; m.frustumCulled = false; m.count = 0; realRoot.add(m); return m; });
const ctrlMasks = new THREE.InstancedMesh(sphereGeo, maskMat, 2); ctrlMasks.renderOrder = R_MASK; ctrlMasks.frustumCulled = false; ctrlMasks.count = 0; realRoot.add(ctrlMasks);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _s = new THREE.Vector3();
function putSphere(mesh, i, pos, r) { _s.setScalar(r); _m.compose(pos, _q, _s); mesh.setMatrixAt(i, _m); }
function updateHands(frame, ref) {
  let hi = 0, ci = 0;
  for (const src of frame.session.inputSources) {
    if (src.hand && hi < 2) {
      const mesh = handMasks[hi++]; let n = 0; const P = {};
      for (const chain of CHAINS) for (const name of chain) {
        if (P[name]) continue; const j = src.hand.get(name); const pose = j && frame.getJointPose(j, ref);
        if (pose) P[name] = { p: new THREE.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z), r: pose.radius || 0.01 };
      }
      for (const chain of CHAINS) for (let k = 0; k < chain.length - 1; k++) {
        const A = P[chain[k]], B = P[chain[k + 1]]; if (!A || !B) continue;
        for (const t of [0, 0.34, 0.67]) putSphere(mesh, n++, _v.lerpVectors(A.p, B.p, t), (A.r + (B.r - A.r) * t) * 1.6 + 0.005);
        if (k === chain.length - 2) putSphere(mesh, n++, B.p, B.r * 1.6 + 0.005);
      }
      if (P['wrist'] && P['middle-finger-phalanx-proximal']) putSphere(mesh, n++, _v.lerpVectors(P['wrist'].p, P['middle-finger-phalanx-proximal'].p, 0.5), 0.045);
      if (P['index-finger-phalanx-proximal'] && P['pinky-finger-phalanx-proximal']) putSphere(mesh, n++, _v.lerpVectors(P['index-finger-phalanx-proximal'].p, P['pinky-finger-phalanx-proximal'].p, 0.5), 0.035);
      mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
    } else if (!src.hand && src.gripSpace && ci < 2) {
      const pose = frame.getPose(src.gripSpace, ref);
      if (pose) { const p = pose.transform.position; putSphere(ctrlMasks, ci++, _v.set(p.x, p.y, p.z), 0.1); }
    }
  }
  for (let k = hi; k < 2; k++) handMasks[k].count = 0;
  ctrlMasks.count = ci; ctrlMasks.instanceMatrix.needsUpdate = true;
}

// ───────────────────────── your desk: touch its corners and the ship lines up around it ─────────────────────────
// The Quest's own room scan belongs to whatever play space it last saved (possibly another game's boundary), and the
// headset's origin is simply wherever you stood when you boarded. So the desk is set here directly, saved as a
// persistent anchor, and the ship is built around the desk instead of around the origin.
//
// Desk frame: origin at the middle of the desk's front edge, at desk height; +X along the edge, +Z toward you.
const DESK_DEPTH = 0.75, SEAT_BACK = 0.6;
let desk = null;            // { objs, matrix, theta, seat }
let deskAnchor = null, deskWaitUntil = 0, finishQueued = false;
let calib = null;           // { step: 0 | 1 | 2, pts: [], monitors: [] }
const calibMarkers = new THREE.Group(); scene.add(calibMarkers);
const cursorMat = new THREE.MeshBasicMaterial({ color: 0xffa040, depthTest: false, transparent: true, opacity: 0.95 });
const cursors = [0, 1].map(() => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), cursorMat); m.renderOrder = R_UI; m.visible = false; scene.add(m); return m; });

const tipC = document.createElement('canvas'); tipC.width = 1024; tipC.height = 230; const tipX = tipC.getContext('2d');
const tipTex = new THREE.CanvasTexture(tipC); tipTex.colorSpace = THREE.SRGBColorSpace;
const tip = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5 * 230 / 1024), new THREE.MeshBasicMaterial({ map: tipTex, transparent: true, depthTest: false, toneMapped: false }));
tip.renderOrder = R_UI; tip.visible = false; scene.add(tip);
let monitorMode = null;   // { until }: after the desk is set, pinches add monitors until you press Done
function hitTip() { return tip.visible && raycaster.intersectObject(tip).length > 0; }   // uses the ray pointAt() just set
function addMonitor(p) {
  const local = p.clone().applyMatrix4(desk.matrix.clone().invert());
  settings.desk.monitors.push(local.toArray().map(v => +v.toFixed(3)));
  buildDesk(desk.matrix, settings.desk); saveSettings();
  monitorMode.until = clock.t + 25;
  const n = settings.desk.monitors.length;
  showTip(`${n} monitor${n > 1 ? 's' : ''} kept real ✓`, 'Touch another monitor and pinch, or point at this sign and pinch to finish.', true);
}
function endMonitors() { monitorMode = null; tip.visible = false; setStatus('All set ✓'); }
function showTip(title, sub, done = false) {
  const x = tipX; x.clearRect(0, 0, 1024, 230);
  x.fillStyle = 'rgba(12,16,26,0.9)'; x.beginPath(); x.roundRect(0, 0, 1024, 230, 30); x.fill();
  x.strokeStyle = '#ffa040'; x.lineWidth = 4; x.beginPath(); x.roundRect(2, 2, 1020, 226, 28); x.stroke();
  x.fillStyle = '#ffd2a8'; x.font = '600 46px system-ui'; x.fillText(title, 40, 74);
  x.fillStyle = '#e8f1ff'; x.font = '32px system-ui';
  let line = '', y = 132;
  for (const w of sub.split(' ')) { const t = line ? line + ' ' + w : w; if (x.measureText(t).width > (done ? 740 : 944)) { x.fillText(line, 40, y); y += 42; line = w; } else line = t; }
  x.fillText(line, 40, y);
  if (done) {
    x.fillStyle = '#1a6b55'; x.beginPath(); x.roundRect(800, 120, 196, 86, 20); x.fill();
    x.strokeStyle = '#38c79c'; x.lineWidth = 3; x.beginPath(); x.roundRect(800, 120, 196, 86, 20); x.stroke();
    x.fillStyle = '#fff'; x.font = '600 38px system-ui'; x.textAlign = 'center'; x.fillText('Done ✓', 898, 176); x.textAlign = 'left';
  }
  tipTex.needsUpdate = true; tip.visible = true;
}
function headPose() {
  const cam = renderer.xr.getCamera();
  const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())); fwd.y = 0; fwd.normalize();
  return { head, fwd };
}
function placeTip() {
  const { head, fwd } = headPose();
  tip.position.copy(head).addScaledVector(fwd, 0.65); tip.position.y = head.y + 0.14; tip.lookAt(head);
}
function startCalib() {
  if (!renderer.xr.isPresenting) { setStatus('Put the headset on to set your desk'); return; }
  calib = { step: 0, pts: [], monitors: [] }; calibMarkers.clear(); finishQueued = false; placeTip();
  showTip('Set your desk  (1 of 3)', 'Touch the FRONT-LEFT corner of your desk with a fingertip or controller tip, then pinch / pull the trigger.');
  drawMenu();
}
function calibPoint(p) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 8), cursorMat); m.position.copy(p); m.renderOrder = R_UI; calibMarkers.add(m);
  if (calib.step < 2) calib.pts.push(p.clone()); else calib.monitors.push(p.clone());
  if (calib.step === 0) { calib.step = 1; showTip('Set your desk  (2 of 3)', 'Now the FRONT-RIGHT corner of your desk.'); }
  else if (calib.step === 1) { calib.step = 2; finishQueued = true; }   // two corners is all the desk needs
}
function deskFrame(L, R, head) {
  const mid = L.clone().add(R).multiplyScalar(0.5);
  const e = new THREE.Vector3(R.x - L.x, 0, R.z - L.z).normalize();
  const u = new THREE.Vector3(-e.z, 0, e.x);                       // perpendicular to the edge…
  if (u.dot(new THREE.Vector3(head.x - mid.x, 0, head.z - mid.z)) < 0) u.negate();   // …pointing at you
  const theta = Math.atan2(u.x, u.z);
  return { matrix: new THREE.Matrix4().makeRotationY(theta).setPosition(mid), width: Math.hypot(R.x - L.x, R.z - L.z) };
}
function disposeDesk() { if (desk) for (const o of desk.objs) disposeObj(o); desk = null; }
function buildDesk(matrix, rec) {
  disposeDesk();
  // A desk top is somewhere between 40 cm and 1.25 m above the floor. Anything else is a bad setup: drop it.
  const height = matrix.elements[13] - floorLevel();
  if (renderer.xr.isPresenting && state.floorLevel != null && (height < 0.4 || height > 1.25)) {
    console.warn('[ufo] ignoring a saved desk at an impossible height:', +height.toFixed(2), 'm');
    settings.desk = null; deskAnchor = null; saveSettings(); applyVisibility(); return;
  }
  const w = rec.width / 2 + 0.03;
  const top = buildPlaneObject('table', 'horizontal', [[-w, -DESK_DEPTH], [w, -DESK_DEPTH], [w, 0.03], [-w, 0.03]].map(([x, z]) => ({ x, y: 0, z })), matrix);
  const objs = [top];
  for (const [x, y, z] of rec.monitors || []) {
    const local = new THREE.Matrix4().makeTranslation(x, y - 0.25, z).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    objs.push(buildPlaneObject('screen', 'vertical', [[-0.42, -0.27], [0.42, -0.27], [0.42, 0.27], [-0.42, 0.27]].map(([a, b]) => ({ x: a, y: 0, z: b })), matrix.clone().multiply(local)));
  }
  for (const o of objs) realRoot.add(o);
  const e = matrix.elements;
  desk = { objs, matrix: matrix.clone(), theta: Math.atan2(e[8], e[10]), seat: new THREE.Vector3(0, 0, SEAT_BACK).applyMatrix4(matrix) };
  applyVisibility();
}
function restoreDesk(session) {
  const rec = settings.desk;
  if (!rec) { setTimeout(() => { if (!desk && !scanDesk && !calib && renderer.xr.isPresenting && ![...planeObjs.values()].some(r => r.obj.userData.label === 'table')) startCalib(); }, 4000); return; }
  deskWaitUntil = clock.t + 6;
  const cached = rec.uuid && state.anchors?.[rec.uuid];
  if (cached) { deskAnchor = cached; return; }
  if (rec.uuid && session.restorePersistentAnchor) {
    session.restorePersistentAnchor(rec.uuid)
      .then(a => { deskAnchor = a; (state.anchors ??= {})[rec.uuid] = a; })
      .catch(e => { console.warn('desk anchor not found:', e?.message || e); deskLost(); });
  } else {
    buildDesk(new THREE.Matrix4().fromArray(rec.pose), rec);
    setStatus('This browser can’t save the desk spot. If it looks off, press “Set my desk”');
  }
}
function deskLost() {
  if (desk || calib) return;
  setStatus('Couldn’t find your saved desk this time. Touch its corners again');
  startCalib();
}
function finishCalib(frame, ref) {
  const [L, R] = calib.pts;
  const { matrix, width } = deskFrame(L, R, headPose().head);
  const inv = matrix.clone().invert();
  const old = settings.desk;
  const rec = { width, monitors: calib.monitors.map(p => p.clone().applyMatrix4(inv).toArray().map(v => +v.toFixed(3))), pose: matrix.toArray(), uuid: null };
  buildDesk(matrix, rec);
  settings.desk = rec; settings.yaw = 0; settings.useScan = false; clearPlanes();
  saveSettings(); applyVisibility(); refreshUI();
  calib = null; calibMarkers.clear();
  setStatus('Desk set ✓ The ship is now built around it');
  monitorMode = { until: clock.t + 25 }; placeTip();
  showTip('Desk set ✓   Monitors (optional)', 'Touch the top of each monitor and pinch. Point at this sign and pinch when you’re done.', true);
  const session = renderer.xr.getSession();
  if (old?.uuid && session?.deletePersistentAnchor) session.deletePersistentAnchor(old.uuid).catch(() => {});
  if (!frame.createAnchor) return;
  const p = new THREE.Vector3().setFromMatrixPosition(matrix), q = new THREE.Quaternion().setFromRotationMatrix(matrix);
  frame.createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), ref)
    .then(async a => {
      deskAnchor = a;
      if (a.requestPersistentHandle) { rec.uuid = await a.requestPersistentHandle(); (state.anchors ??= {})[rec.uuid] = a; saveSettings(); setStatus('Desk saved ✓ It will be there next time'); }
    })
    .catch(e => setStatus('Desk set, but saving it failed: ' + (e?.message || e)));
}
function updateDesk(frame, ref) {
  if (deskAnchor && frame.trackedAnchors?.has(deskAnchor)) {
    const p = frame.getPose(deskAnchor.anchorSpace, ref);
    if (p) {
      const m = new THREE.Matrix4().fromArray(p.transform.matrix);
      const moved = !desk || new THREE.Vector3().setFromMatrixPosition(m).distanceTo(new THREE.Vector3().setFromMatrixPosition(desk.matrix)) > 0.02;
      if (moved) buildDesk(m, settings.desk);
    }
  } else if (deskAnchor && !desk && deskWaitUntil && clock.t > deskWaitUntil) { deskWaitUntil = 0; deskLost(); }
  if (finishQueued && calib) { finishQueued = false; finishCalib(frame, ref); }
  if (monitorMode && clock.t > monitorMode.until) endMonitors();
  // Like the Quest's own boundary: a wall's outline shows only when you're within arm's reach of it.
  if (!settings.outline) {
    const head = headPose().head;
    for (const [, r] of planeObjs) {
      if (r.obj.userData.label !== 'wall') continue;
      const e = r.obj.matrix.elements, n = new THREE.Vector3(e[4], e[5], e[6]).normalize();
      const near = Math.abs(head.clone().sub(new THREE.Vector3(e[12], e[13], e[14])).dot(n)) < 0.7;
      for (const c of r.obj.children) if (c.userData.kind === 'outline') c.visible = near;
    }
  }
  // The Quest's own floor level can be wrong (it jumped 33 cm mid-session from a stale play area), so the ship
  // stands on the scanned floor instead, and follows it if it moves.
  let floorY = null, floorArea = 0;
  for (const [, r] of planeObjs) if (r.obj.userData.label === 'floor') {
    const a = r.obj.userData.polygon.length;   // rough size proxy; there is normally just one floor
    if (a > floorArea) { floorArea = a; floorY = r.obj.matrix.elements[13]; }
  }
  if (floorY !== null && Math.abs(floorLevel() - floorY) > 0.03) {
    console.info('[ufo] floor found at', +floorY.toFixed(3), '(was', +floorLevel().toFixed(3) + ')');
    state.floorLevel = floorY;
    for (const [, r] of planeObjs) r.t = null;          // rebuild desk/shelf volumes from the real floor up
    if (desk) buildDesk(desk.matrix, settings.desk);
  }
  const fl = floorLevel();
  if (Math.abs(cabinRoot.position.y - fl) > 0.005) cabinRoot.position.y = fl;   // the ship stands on the real floor
  // orange dot on each fingertip / controller tip while setting the desk
  controllers.forEach((c, i) => {
    cursors[i].visible = !!((calib || monitorMode) && c.userData.src);
    if (cursors[i].visible) cursors[i].position.setFromMatrixPosition(c.matrixWorld);
  });
}
function clearPlanes() { for (const [, rec] of planeObjs) disposeObj(rec.obj); planeObjs.clear(); scanDesk = null; applyVisibility(); }
// From a scanned table: its edge nearest you is the front edge.
let scanDesk = null;
function deskFromScan(obj) {
  if (!renderer.xr.isPresenting) return;
  // Scanned desk outlines are often irregular (many short edges), so don't look for a straight front edge.
  // Face the desk from where you are, snapped to the scan's own axes when they're close (they usually follow the desk).
  const { head } = headPose();
  const pts = obj.userData.polygon.map(p => new THREE.Vector3(p.x, 0, p.z).applyMatrix4(obj.matrix));
  const center = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  let u = new THREE.Vector3(head.x - center.x, 0, head.z - center.z).normalize();       // desk → you
  const ax = new THREE.Vector3().setFromMatrixColumn(obj.matrix, 0).setY(0).normalize();
  const az = new THREE.Vector3().setFromMatrixColumn(obj.matrix, 2).setY(0).normalize();
  const best = [ax, ax.clone().negate(), az, az.clone().negate()].sort((a, b) => b.dot(u) - a.dot(u))[0];
  if (best.dot(u) > Math.cos(THREE.MathUtils.degToRad(25))) u = best.clone();
  const theta = Math.atan2(u.x, u.z);
  const seat = new THREE.Vector3(head.x, 0, head.z);   // the ship is centred on where you're actually sitting
  scanDesk = { theta, seat };
  applyVisibility();
  console.info('[ufo] ship lined up with the scanned desk', { yawDeg: +(theta * 180 / Math.PI).toFixed(1), seat: seat.toArray().map(v => +v.toFixed(2)) });
}

// ───────────────────────── in-headset menu ─────────────────────────
const MW = 1024, MH = 744;
const mCanvas = document.createElement('canvas'); mCanvas.width = MW; mCanvas.height = MH;
const mCtx = mCanvas.getContext('2d');
const mTex = new THREE.CanvasTexture(mCanvas); mTex.colorSpace = THREE.SRGBColorSpace;
const menu = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.56 * 744 / 1024), new THREE.MeshBasicMaterial({ map: mTex, transparent: true, depthTest: false, toneMapped: false }));
menu.renderOrder = R_UI; menu.visible = false; scene.add(menu);
let markMode = false, statusText = '';
const BTN = [];
SCENES.forEach((s, i) => BTN.push({ id: 'scene:' + s.key, x: 32 + i * 242, y: 96, w: 226, h: 96 }));
[['videoMode', 'play', 'demo'], ['mark', 'size', 'clear'], ['floor', 'outline', 'rotate'], ['desk', 'scan', 'rescan']].forEach((row, r) =>
  row.forEach((id, c) => BTN.push({ id, x: 32 + c * 320, y: 216 + r * 104, w: 304, h: 88 })));
function btnLabel(id) {
  if (id.startsWith('scene:')) return SCENES.find(s => 'scene:' + s.key === id).label;
  return {
    videoMode: 'Video: ' + settings.videoMode, play: videoLoaded ? (video.paused ? 'Play video' : 'Pause video') : (demoPaused ? 'Play demo clip' : 'Pause demo clip'), rotate: 'Rotate ship ↻ 15°', demo: 'Demo clip',
    desk: calib ? 'Setting desk…' : settings.desk ? 'Set my desk again' : '⚑ Set my desk', scan: 'Quest room scan: ' + (settings.useScan ? 'on' : 'off'),
    mark: markMode ? 'Marking… (pinch at it)' : 'Mark real zone', size: 'Zone size: ' + Math.round(settings.zoneSize * 100) + ' cm',
    clear: 'Clear real zones', floor: 'Real floor: ' + (settings.realFloor ? 'on' : 'off'),
    outline: 'Room outline: ' + (settings.outline ? 'on' : 'off'), rescan: 'Rescan room',
  }[id];
}
function btnOn(id) {
  return id === 'scene:' + settings.scene || (id === 'mark' && markMode) || (id === 'floor' && settings.realFloor) || (id === 'outline' && settings.outline) || (id === 'scan' && settings.useScan) || (id === 'desk' && !!calib);
}
const hovered = [null, null];
function drawMenu() {
  const x = mCtx; x.clearRect(0, 0, MW, MH);
  x.fillStyle = 'rgba(12,16,26,0.9)'; rr(0, 0, MW, MH, 36); x.fill();
  x.strokeStyle = 'rgba(127,227,255,0.35)'; x.lineWidth = 3; rr(2, 2, MW - 4, MH - 4, 34); x.stroke();
  x.fillStyle = '#e8f1ff'; x.font = '600 40px system-ui'; x.textAlign = 'left'; x.fillText('🛸  UFO Office', 36, 64);
  x.fillStyle = '#93a3bd'; x.font = '24px system-ui'; x.textAlign = 'right'; x.fillText('squeeze a grip to bring this menu back', MW - 36, 62);
  for (const b of BTN) {
    const on = btnOn(b.id), hov = hovered.includes(b.id);
    x.fillStyle = on ? '#12485a' : hov ? '#26324a' : '#1a2132'; rr(b.x, b.y, b.w, b.h, 18); x.fill();
    x.strokeStyle = on || hov ? '#7fe3ff' : '#2f3b52'; x.lineWidth = 3; rr(b.x, b.y, b.w, b.h, 18); x.stroke();
    x.fillStyle = '#e8f1ff'; x.font = (b.id.startsWith('scene:') ? '600 ' : '') + '27px system-ui'; x.textAlign = 'center';
    x.fillText(btnLabel(b.id), b.x + b.w / 2, b.y + b.h / 2 + 10);
  }
  x.fillStyle = '#7fe3ff'; x.font = '24px system-ui'; x.textAlign = 'left'; x.fillText(statusText, 36, MH - 22);
  mTex.needsUpdate = true;
  function rr(a, b, w, h, r) { x.beginPath(); x.roundRect(a, b, w, h, r); }
}
function recallMenu() {
  const cam = renderer.xr.getCamera();
  const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
  // Low and to the right, so it never covers the window or your monitor.
  menu.position.copy(head).addScaledVector(fwd, 0.55).addScaledVector(right, 0.3); menu.position.y = head.y - 0.28;
  menu.lookAt(head);
}

// ───────────────────────── controllers / pointing ─────────────────────────
const raycaster = new THREE.Raycaster();
const rayMat = new THREE.LineBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.8, depthTest: false });
const controllers = [0, 1].map(i => {
  const c = renderer.xr.getController(i);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), rayMat);
  line.renderOrder = R_UI; line.scale.z = 0.25; c.add(line); c.userData.line = line;
  on(c, 'select', () => onSelect(i));
  on(c, 'squeeze', recallMenu);
  return c;
});
function pointAt(c) {
  _m.identity().extractRotation(c.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_m);
  const hit = menu.visible ? raycaster.intersectObject(menu)[0] : null;
  if (!hit) return { id: null, dist: 0.25 };
  const px = hit.uv.x * MW, py = (1 - hit.uv.y) * MH;
  const b = BTN.find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
  return { id: b ? b.id : 'panel', dist: hit.distance };
}
function onSelect(i) {
  if (window.__xrBridge?.consumes?.(i)) return;   // the press was on the Claude panel
  const c = controllers[i]; const { id } = pointAt(c);
  if (monitorMode) {
    if (hitTip()) { endMonitors(); return; }
    if (!id && desk) { addMonitor(new THREE.Vector3().setFromMatrixPosition(c.matrixWorld)); return; }
  }
  if (calib && !id) { if (calib.step < 2) calibPoint(new THREE.Vector3().setFromMatrixPosition(c.matrixWorld)); return; }
  if (id && id !== 'panel') { doAction(id); return; }
  if (markMode && !id) {
    pendingZones.push(new THREE.Vector3().setFromMatrixPosition(c.matrixWorld));
    markMode = false; drawMenu();
  }
}

// ───────────────────────── actions (shared by 2D page and headset menu) ─────────────────────────
function doAction(id) {
  if (id.startsWith('scene:')) { warpTo(id.slice(6)); return; }
  switch (id) {
    case 'videoMode': settings.videoMode = VIDEO_MODES[(VIDEO_MODES.indexOf(settings.videoMode) + 1) % 3]; built.video?.refresh(); break;
    case 'demo': videoLoaded = state.videoLoaded = false; video.pause(); demoPaused = false; built.video?.refresh(); warpTo('video'); setStatus('Playing the demo festival cam'); break;
    case 'play': if (!videoLoaded) { demoPaused = !demoPaused; if (settings.scene !== 'video') warpTo('video'); break; }
      if (video.paused) { video.play(); if (settings.scene !== 'video') warpTo('video'); } else video.pause(); break;
    case 'rotate': settings.yaw = (settings.yaw + 15) % 360; break;
    case 'mark': markMode = !markMode; setStatus(markMode ? 'Hold your hand or controller at the thing, then pinch / pull the trigger' : ''); break;
    case 'size': settings.zoneSize = ZONE_SIZES[(ZONE_SIZES.indexOf(settings.zoneSize) + 1) % ZONE_SIZES.length]; break;
    case 'clear': clearZones(); break;
    case 'floor': settings.realFloor = !settings.realFloor; break;
    case 'outline': settings.outline = !settings.outline; break;
    case 'desk': startCalib(); break;
    case 'scan': settings.useScan = !settings.useScan; if (!settings.useScan) clearPlanes(); break;
    case 'rescan': {
      const s = renderer.xr.getSession();
      if (s?.initiateRoomCapture) s.initiateRoomCapture().catch(e => setStatus('Rescan unavailable: ' + e.message));
      else setStatus('Run Space Setup in the Quest settings to scan your room');
      break;
    }
  }
  saveSettings(); applyVisibility(); refreshUI();
}
function setStatus(t) { statusText = t; document.getElementById('status').textContent = t; drawMenu(); }

// ───────────────────────── 2D page UI ─────────────────────────
const sceneRow = document.getElementById('scenes'); sceneRow.replaceChildren();
for (const s of SCENES) { const b = document.createElement('button'); b.dataset.act = 'scene:' + s.key; b.textContent = s.label; sceneRow.append(b); }
document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { ensureAudio(); doAction(b.dataset.act); }, { signal }));
function refreshUI() {
  document.querySelectorAll('[data-act]').forEach(b => b.classList.toggle('on', btnOn(b.dataset.act)));
  document.getElementById('vmode').textContent = 'Type: ' + settings.videoMode;
  drawMenu();
}
document.getElementById('file').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  video.src = URL.createObjectURL(f);
  video.onloadedmetadata = () => {
    videoLoaded = state.videoLoaded = true;
    const aspect = video.videoWidth / video.videoHeight;
    // Equirectangular 360 footage is exactly 2:1, so guess the mode from the shape.
    if (Math.abs(aspect - 2) < 0.02) settings.videoMode = '360';
    getScene('video').sizeFlat(aspect); built.video.refresh();
    ensureAudio(); warpTo('video'); video.play().catch(() => {});
    setStatus(`Loaded ${f.name} (${video.videoWidth}×${video.videoHeight}, ${settings.videoMode})`);
  };
}, { signal });
document.getElementById('hide').onclick = () => { hud.style.display = 'none'; show.style.display = 'block'; };
document.getElementById('show').onclick = () => { hud.style.display = ''; show.style.display = 'none'; };
const hud = document.getElementById('hud'), show = document.getElementById('show');

// ───────────────────────── entering the headset ─────────────────────────
const enterBtn = document.getElementById('enter');
let firstXRFrame = false;
(async () => {
  const ok = navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (ok) { enterBtn.disabled = false; enterBtn.textContent = 'Board the UFO (enter mixed reality)'; }
  else enterBtn.textContent = window.isSecureContext ? 'Open this page in the Quest 3 browser to board' : 'Needs HTTPS (or localhost) for the headset';
})();
enterBtn.addEventListener('click', async () => {
  ensureAudio();
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: [],   // no 'local-floor': see index.html
      optionalFeatures: ['plane-detection', 'anchors', 'hand-tracking'],
    });
    await renderer.xr.setSession(session);
    onSessionStart(session, false);
  } catch (e) { setStatus('Could not start: ' + e.message); }
}, { signal });
function onSessionStart(session, resumed) {
  if (!resumed) state.floorLevel = null;   // a fresh session has a fresh origin
  cabinRoot.position.y = floorLevel();
  fakeRoom.visible = false; menu.visible = true; controls.enabled = false;
  if (resumed && state.menuPose) { menu.position.copy(state.menuPose.p); menu.quaternion.copy(state.menuPose.q); }
  else firstXRFrame = true;
  restoreZones(session);
  restoreDesk(session);
  if (settings.scene === 'video' && videoLoaded) video.play().catch(() => {});
  session.addEventListener('end', () => {
    fakeRoom.visible = true; menu.visible = false; controls.enabled = true;
    for (const z of zones) disposeObj(z.obj); zones = [];
    disposeDesk(); deskAnchor = null; calib = null; monitorMode = null; scanDesk = null; tip.visible = false; state.floorLevel = null; cabinRoot.position.y = 0; calibMarkers.clear(); applyVisibility();
    for (const [, rec] of planeObjs) disposeObj(rec.obj); planeObjs.clear();
    state.anchors = {}; state.menuPose = null;
  }, { signal });
}

// ───────────────────────── main loop ─────────────────────────
let last = performance.now(), planesSeen = false, planeCheckAt = 0;
function frameFn(now, frame) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now; clock.t += dt; const t = clock.t;

  // Warp: glass flashes white, the scene swaps at peak brightness, then it fades back.
  if (warp) {
    const k = (t - warp.t0) / 0.9;
    const flash = k < 0.5 ? k / 0.5 : 1 - (k - 0.5) / 0.5;
    cabin.glassMat.opacity = 0.035 + Math.max(0, flash) * 0.965; cabin.glassMat.color.setRGB(0.75 + flash * 0.25, 0.92, 1);
    if (k >= 0.5 && !warp.swapped) { showScene(warp.to); warp.swapped = true; }
    if (k >= 1) { warp = null; cabin.glassMat.opacity = 0.035; }
  }
  current?.update(t, dt);
  hullMat.uniforms.uTime.value = t;
  for (const b of cabin.blinkers) b.visible = Math.sin(t * b.userData.rate + b.userData.phase) > -0.3;

  if (frame) {
    const ref = renderer.xr.getReferenceSpace();
    if (firstXRFrame) { recallMenu(); firstXRFrame = false; planeCheckAt = t + 4; }
    if (frame.detectedPlanes && settings.useScan) { syncPlanes(frame, ref); if (frame.detectedPlanes.size) planesSeen = true; }
    updateDesk(frame, ref);
    if (!planesSeen && !settings.desk && settings.useScan && planeCheckAt && t > planeCheckAt) { setStatus('No room scan found. Try "Rescan room" so your desk stays real.'); planeCheckAt = 0; }
    for (const z of zones) {
      if (z.anchor && frame.trackedAnchors?.has(z.anchor)) {
        const p = frame.getPose(z.anchor.anchorSpace, ref);
        if (p) { z.obj.matrix.fromArray(p.transform.matrix); z.obj.matrixWorldNeedsUpdate = true; }
      }
    }
    while (pendingZones.length) placeZone(frame, ref, pendingZones.shift());
    updateHands(frame, ref);
    let changed = false;
    controllers.forEach((c, i) => {
      const { id, dist } = c.userData.src ? pointAt(c) : { id: null, dist: 0 };
      c.userData.line.scale.z = dist; c.userData.line.visible = !!c.userData.src;
      const h = id && id !== 'panel' ? id : null;
      if (hovered[i] !== h) { hovered[i] = h; changed = true; }
    });
    if (changed) drawMenu();
  } else controls.update();
}

// ───────────────────────── mount / dispose ─────────────────────────
function dispose() {
  ac.abort();
  for (const [t, type, fn] of xrListeners) t.removeEventListener(type, fn);
  for (const c of controllers) c.remove(c.userData.line);
  if (menu.visible) state.menuPose = { p: menu.position.clone(), q: menu.quaternion.clone() };
  if (sceneAudio) { sceneAudio.timers.forEach(clearInterval); sceneAudio.nodes.forEach(n => { try { n.stop(); } catch {} }); }
  audioNodes.forEach(n => { try { n.stop(); } catch {} });
  master?.disconnect();
  SHELL.scene.remove(scene);
  scene.traverse(o => {
    o.geometry?.dispose();
    for (const m of [o.material].flat()) {
      if (!m) continue;
      for (const k in m) if (m[k]?.isTexture) m[k].dispose();
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u.value?.isTexture) u.value.dispose();
      m.dispose();
    }
  });
  scene.traverse(o => o.userData.rt?.dispose());
}
function describe() {
  return {
    scene: settings.scene, videoMode: settings.videoMode, videoLoaded, shipYawDeg: settings.yaw,
    realFloor: settings.realFloor, outline: settings.outline, realZones: zones.length,
    detectedPlanes: [...planeObjs.values()].map(r => r.obj.userData.label),
    markMode, menuVisible: menu.visible, status: statusText,
    desk: desk ? { center: new THREE.Vector3().setFromMatrixPosition(desk.matrix).toArray().map(v => +v.toFixed(3)), yawDeg: +(desk.theta * 180 / Math.PI).toFixed(1), widthM: +settings.desk.width.toFixed(2), monitors: settings.desk.monitors.length, anchored: !!deskAnchor } : (settings.desk ? 'saved but not found yet' : 'not set'),
    settingDesk: calib ? ['front-left corner', 'front-right corner', 'saving'][calib.step] : monitorMode ? 'monitors (optional)' : null, useQuestScan: settings.useScan,
    scanDesk: scanDesk ? { yawDeg: +(scanDesk.theta * 180 / Math.PI).toFixed(1), seat: scanDesk.seat.toArray().map(v => +v.toFixed(2)) } : null,
  };
}

applyVisibility(); refreshUI();
showScene(settings.scene);
SHELL.scene.add(scene);
if (renderer.xr.isPresenting) onSessionStart(renderer.xr.getSession(), true);
if (actx && actx.state === 'running') ensureAudio();
SHELL.world = { frame: frameFn, dispose, describe, debug: { deskFrame, buildDesk, disposeDesk, applyVisibility, buildPlaneObject } };

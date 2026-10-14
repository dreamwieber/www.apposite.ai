(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const o of document.querySelectorAll('link[rel="modulepreload"]'))s(o);new MutationObserver(o=>{for(const n of o)if(n.type==="childList")for(const r of n.addedNodes)r.tagName==="LINK"&&r.rel==="modulepreload"&&s(r)}).observe(document,{childList:!0,subtree:!0});function e(o){const n={};return o.integrity&&(n.integrity=o.integrity),o.referrerPolicy&&(n.referrerPolicy=o.referrerPolicy),o.crossOrigin==="use-credentials"?n.credentials="include":o.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function s(o){if(o.ep)return;o.ep=!0;const n=e(o);fetch(o.href,n)}})();const j=32,Ct={viewProj:0,invViewProj:16,lightVP:32,camPos:48,res:52,keyDir:56,rimDir:60,bgTop:64,bgBot:68,look0:72,look1:76,look2:80,look3:84,look4:88,look5:92,bodies:96,bodyTint:96+j*4,bodyBase:96+j*8,size:96+j*12},ee=`
struct Globals {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  lightVP: mat4x4f,
  camPos: vec4f,   // w = time
  res: vec4f,      // w, h, 1/w, 1/h
  keyDir: vec4f,   // xyz dir to light, w intensity
  rimDir: vec4f,   // xyz, w intensity
  bgTop: vec4f,    // rgb, w = backdrop z
  bgBot: vec4f,    // rgb, w = body count
  look0: vec4f,    // sss, density, wrap, transmission
  look1: vec4f,    // refraction, ior, specular, roughness
  look2: vec4f,    // clearcoat, env, rim, shadow
  look3: vec4f,    // shadowSoft, ao, backdrop half height, light-map world size
  look4: vec4f,    // bleed, debug view, ambient, caustics
  look5: vec4f,    // glitter, bump, iridescence, frost (global multipliers)
  bodies: array<vec4f, ${j}>,   // centre, eff radius
  bodyTint: array<vec4f, ${j}>, // shadow transmittance colour
  bodyBase: array<vec4f, ${j}>, // base colour (bounce light)
};
// p0: roughness, clearcoat, clarity (see-through), subsurface
// p1: sheen (velvet), glitter, micro-bump, iridescence
struct Mat { base: vec4f, deep: vec4f, sheen: vec4f, p0: vec4f, p1: vec4f };

// Shader quality tier (pipeline-overridable): 2 = full (default), 1 = medium, 0 = low.
override QUALITY: f32 = 2.0;

@group(0) @binding(0) var<uniform> G: Globals;
@group(0) @binding(1) var<storage, read> mats: array<Mat>;

const PI = 3.14159265;
fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

fn sphOcc(p: vec3f, n: vec3f, sph: vec4f) -> f32 {
  let di = sph.xyz - p;
  let l = length(di);
  let nl = dot(n, di / l);
  let h = l / sph.w;
  return sat(max(nl, 0.0) / (h * h));
}

// analytic coloured shadows from body spheres (used for body->body)
fn sphereShadows(p: vec3f, L: vec3f, skip: i32, soft: f32) -> vec3f {
  var s = vec3f(1.0);
  let n = i32(G.bgBot.w);
  for (var i = 0; i < n; i++) {
    if (i == skip) { continue; }
    let sph = vec4f(G.bodies[i].xyz, G.bodies[i].w * 0.9);
    let oc = p - sph.xyz;
    let b = dot(oc, L);
    if (b > 0.0) { continue; }
    let d = sqrt(max(dot(oc, oc) - b * b, 0.0));
    let w = sph.w * 0.1 + (-b) * soft * 0.35;
    let lit = smoothstep(sph.w - w, sph.w + w, d);
    s *= mix(G.bodyTint[i].rgb, vec3f(1.0), lit);
  }
  return s;
}

fn occlusionAt(p: vec3f, n: vec3f, skip: i32) -> f32 {
  var o = 0.0;
  let cnt = i32(G.bgBot.w);
  for (var i = 0; i < cnt; i++) {
    if (i == skip) { continue; }
    o += sphOcc(p, n, vec4f(G.bodies[i].xyz, G.bodies[i].w * 0.95));
  }
  return sat(1.0 - o);
}

fn bounceAt(p: vec3f, n: vec3f, skip: i32) -> vec3f {
  var c = vec3f(0.0);
  let cnt = i32(G.bgBot.w);
  for (var i = 0; i < cnt; i++) {
    if (i == skip) { continue; }
    let o = sphOcc(p, n, vec4f(G.bodies[i].xyz, G.bodies[i].w * 1.6));
    c += G.bodyBase[i].rgb * o;
  }
  return c;
}

fn softbox(d: vec3f, axis: vec3f, size: vec2f, feather: f32) -> f32 {
  let ca = dot(d, axis);
  if (ca <= 0.0) { return 0.0; }
  let t = normalize(cross(axis, vec3f(0.0, 1.0, 0.001)));
  let b = cross(t, axis);
  let uv = vec2f(dot(d, t), dot(d, b)) / ca;
  let q = abs(uv) / size;
  let r = pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25);
  return 1.0 - smoothstep(1.0 - feather, 1.0, r);
}

// Studio environment for reflections. Rough surfaces see bigger, softer, dimmer softboxes.
fn env(d: vec3f, rough: f32) -> vec3f {
  let top = G.bgTop.rgb;
  let bot = G.bgBot.rgb;
  let grow = 1.0 + rough * 1.6;
  let fe = min(0.25 + rough * 0.9, 1.0);
  let dim = 1.0 / (1.0 + rough * rough * 6.0);
  var c = mix(bot * 0.5, top * 1.05, smoothstep(-0.5 - rough, 0.8 + rough, d.y));
  c += vec3f(1.0, 0.98, 0.95) * softbox(d, normalize(G.keyDir.xyz), vec2f(0.62, 0.42) * grow, fe) * 12.0 * dim;
  c += vec3f(0.95, 0.97, 1.0) * softbox(d, normalize(vec3f(0.95, 0.15, 0.3)), vec2f(0.05, 0.8) * grow, fe) * 9.0 * dim;
  c += vec3f(1.0, 0.96, 0.92) * softbox(d, normalize(vec3f(-0.9, -0.2, 0.35)), vec2f(0.05, 0.6) * grow, fe) * 2.5 * dim;
  c += vec3f(1.0) * softbox(d, normalize(vec3f(0.3, 0.9, -0.2)), vec2f(0.6, 0.25) * grow, fe) * 3.0 * dim;
  return c * G.look2.y;
}

fn hash33(p: vec3f) -> vec3f {
  let q = vec3f(dot(p, vec3f(127.1, 311.7, 74.7)), dot(p, vec3f(269.5, 183.3, 246.1)), dot(p, vec3f(113.5, 271.9, 124.6)));
  return fract(sin(q) * 43758.5453);
}
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash33(i).x;
  let n100 = hash33(i + vec3f(1.0, 0.0, 0.0)).x;
  let n010 = hash33(i + vec3f(0.0, 1.0, 0.0)).x;
  let n110 = hash33(i + vec3f(1.0, 1.0, 0.0)).x;
  let n001 = hash33(i + vec3f(0.0, 0.0, 1.0)).x;
  let n101 = hash33(i + vec3f(1.0, 0.0, 1.0)).x;
  let n011 = hash33(i + vec3f(0.0, 1.0, 1.0)).x;
  let n111 = hash33(i + vec3f(1.0, 1.0, 1.0)).x;
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
fn fbm2(p: vec3f) -> f32 { return vnoise(p) * 0.65 + vnoise(p * 2.7 + 17.0) * 0.35; }

// thin-film interference tint, by view angle
fn thinFilm(NoV: f32) -> vec3f {
  return 0.5 + 0.5 * cos(6.2831 * (vec3f(0.0, 0.33, 0.67) + (1.0 - NoV) * 1.6 + 0.15));
}

fn rayPlaneZ(o: vec3f, d: vec3f, z: f32) -> vec3f {
  let t = (z - o.z) / min(d.z, -1e-4);
  return o + d * t;
}
`,ve=`
@group(0) @binding(3) var tintTex: texture_2d<f32>;
@group(0) @binding(4) var occTex: texture_2d<f32>;
@group(0) @binding(5) var linSamp: sampler;

const DISK = array<vec2f, 16>(
  vec2f(-0.613, 0.617), vec2f(0.170, -0.040), vec2f(-0.299, 0.791), vec2f(0.645, 0.493),
  vec2f(-0.651, 0.717), vec2f(0.421, 0.027), vec2f(-0.817, -0.271), vec2f(-0.705, -0.668),
  vec2f(0.977, -0.108), vec2f(0.063, -0.729), vec2f(0.343, -0.988), vec2f(-0.215, 0.031),
  vec2f(-0.437, -0.219), vec2f(0.743, -0.602), vec2f(-0.025, 0.396), vec2f(0.413, 0.919));

fn lightUV(p: vec3f) -> vec2f {
  let lp = G.lightVP * vec4f(p, 1.0);
  return vec2f(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
}

// PCSS-style soft coloured shadow on the backdrop (+ caustic in .w channel of result).
fn mapShadow(p: vec3f, jitter: f32) -> vec4f {
  let uv = lightUV(p);
  let wsize = G.look3.w;
  let soft = G.look3.x;
  let cs = cos(jitter);
  let sn = sin(jitter);
  let rot = mat2x2f(cs, sn, -sn, cs);
  // blocker search
  let searchR = (0.25 + 1.6 * soft) / wsize;
  var sum = 0.0;
  var cnt = 0.0;
  for (var i = 0; i < 16; i += 2) {
    let o = textureSampleLevel(occTex, linSamp, uv + rot * DISK[i] * searchR, 0.0);
    sum += o.x;
    cnt += o.y;
  }
  if (cnt < 1e-3) { return vec4f(1.0, 1.0, 1.0, 0.0); }
  let avgD = sum / cnt;
  let pen = (0.03 + avgD * soft * 0.32) / wsize;
  var s = vec3f(0.0);
  var caus = 0.0;
  let stride = select(2, 1, QUALITY >= 2.0); // 16 taps at full quality, 8 below
  var taps = 0.0;
  for (var i = 0; i < 16; i += stride) {
    let o = rot * DISK[i];
    s += textureSampleLevel(tintTex, linSamp, uv + o * pen, 0.0).rgb;
    caus += textureSampleLevel(occTex, linSamp, uv + o * pen * 0.6, 0.0).z;
    taps += 1.0;
  }
  return vec4f(s / taps, caus / taps);
}

// Backdrop plane at z = bgTop.w: gradient + light pool only (cheap)
fn backdropBase(p: vec3f) -> vec3f {
  let hh = G.look3.z;
  let y = p.y / hh;
  var c = mix(G.bgBot.rgb, G.bgTop.rgb, smoothstep(-1.1, 1.0, y));
  let lp = p.xy - vec2f(-0.3 * hh, 0.5 * hh);
  let pool = exp(-dot(lp, lp) / (hh * hh * 1.6));
  return c * (0.8 + 0.32 * pool);
}

// Full backdrop: + coloured soft shadows, caustics, contact AO, bounce
fn backdrop(p: vec3f, jitter: f32) -> vec3f {
  var c = backdropBase(p);
  let sh = mapShadow(p, jitter);
  c *= mix(vec3f(1.0), sh.rgb, G.look2.w);
  // focused light: same hue as the shadow, but brighter and more saturated
  let hue = sh.rgb / max(max(sh.r, max(sh.g, sh.b)), 1e-3);
  c += c * hue * hue * sh.w * G.look4.w;
  let ao = occlusionAt(p, vec3f(0.0, 0.0, 1.0), -1);
  c *= mix(1.0, ao, G.look3.y * 0.7);
  if (QUALITY >= 1.0) { c += bounceAt(p, vec3f(0.0, 0.0, 1.0), -1) * G.look4.x * 0.25 * c; }
  return c;
}

fn ign(px: vec2f) -> f32 { return fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715)))); }
`,be=`
${ee}
${ve}

// ---------------- backdrop pass ----------------
struct FsOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };

@vertex fn vs_full(@builtin(vertex_index) i: u32) -> FsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: FsOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}

@fragment fn fs_backdrop(in: FsOut) -> @location(0) vec4f {
  let w = G.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let dir = normalize(w.xyz / w.w - G.camPos.xyz);
  let p = rayPlaneZ(G.camPos.xyz, dir, G.bgTop.w);
  return vec4f(backdrop(p, ign(in.pos.xy) * 6.283), 1.0);
}

// ---------------- bodies ----------------
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) @interpolate(flat) id: u32,
  @location(3) rp: vec3f, // rest-space position: textures stick to the body
};

@vertex fn vs_body(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) rp: vec3f, @builtin(instance_index) id: u32) -> VOut {
  var o: VOut;
  o.pos = G.viewProj * vec4f(p, 1.0);
  o.wp = p;
  o.n = n;
  o.id = id;
  o.rp = rp;
  return o;
}

@group(0) @binding(2) var backTex: texture_2d<f32>;
@group(0) @binding(6) var sceneTex: texture_2d<f32>; // opaque scene, mip-blurred (transparent pass only)

fn ggx(NoH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

// Glitter flakes suspended in the body: one flake per rest-space cell, each with its own tilt.
fn glitter(rp: vec3f, N: vec3f, V: vec3f, L: vec3f, freq: f32) -> vec3f {
  var sum = vec3f(0.0);
  let layers = select(1, 2, QUALITY >= 1.0);
  for (var layer = 0; layer < layers; layer++) {
    let s = rp * freq * (1.0 + f32(layer) * 0.61) + f32(layer) * 13.7;
    let cell = floor(s);
    let h = hash33(cell);
    let c = cell + 0.25 + h * 0.5;
    let d = length(s - c);
    let size = 0.24;
    if (d > size) { continue; }
    let tilt = hash33(cell + 41.0) - 0.5;
    let fn_ = normalize(N + tilt * 1.7);
    let R = reflect(-V, fn_);
    let spark = pow(sat(dot(R, L)), 40.0) * 14.0 + dot(env(R, 0.0), vec3f(0.3, 0.5, 0.2)) * 0.35 + 0.35;
    let hue = mix(vec3f(1.0), thinFilm(h.z), 0.6);
    sum += hue * spark * smoothstep(size, size * 0.35, d) * (1.0 - 0.5 * f32(layer));
  }
  return sum;
}

fn shade(in: VOut, glassPass: bool) -> vec4f {
  let m = mats[in.id];
  let id = i32(in.id);
  let P = in.wp;
  var N = normalize(in.n);
  let V = normalize(G.camPos.xyz - P);

  // per-material properties, scaled by the global multipliers
  let rough = clamp(m.p0.x * G.look1.w, 0.03, 1.0);
  let coat = m.p0.y * G.look2.x;
  let clarity = m.p0.z;
  let sssM = m.p0.w;
  let sheenAmt = m.p1.x;
  let glitterAmt = m.p1.y * G.look5.x;
  let bumpAmt = m.p1.z * G.look5.y;
  let irid = m.p1.w * G.look5.z;

  let sss = G.look0.x * sssM;
  let density = G.look0.y;
  let wrap = mix(G.look0.z, 0.85, sheenAmt * 0.6);
  let transK = G.look0.w;
  let refrK = G.look1.x;
  let ior = G.look1.y;
  let specK = G.look1.z;
  let rimK = G.look2.z;
  let ambK = G.look4.z;
  let key = G.keyDir.w;

  // micro surface: fine noise in rest space perturbs the normal (peach fuzz, soft-touch grain)
  if (bumpAmt > 0.001 && QUALITY >= 1.0) {
    let f = 34.0;
    let q = in.rp * f;
    let e = 0.35;
    let n0 = fbm2(q);
    let g = vec3f(fbm2(q + vec3f(e, 0.0, 0.0)) - n0, fbm2(q + vec3f(0.0, e, 0.0)) - n0, fbm2(q + vec3f(0.0, 0.0, e)) - n0) / e;
    N = normalize(N - (g - dot(g, N) * N) * bumpAmt * 0.35);
  }
  let NoV = sat(dot(N, V));

  // thickness from back-face pass
  let back = textureLoad(backTex, vec2i(in.pos.xy), 0).r;
  let front = length(P - G.camPos.xyz);
  let thick = clamp(back - front, 0.0, 6.0);

  let base = m.base.rgb;
  let deep = m.deep.rgb;
  // debug views: 1 normals, 2 thickness (red = no back face), 3 key shadow, 4 AO,
  // 5 diffuse, 6 ambient, 7 glow+rim transmission, 8 refraction, 9 reflections+spec
  let dbg = i32(G.look4.y);
  if (dbg == 1) { return vec4f(N * 0.5 + 0.5, 1.0); }
  if (dbg == 2) { return vec4f(vec3f(thick * 0.4), 1.0) + vec4f(select(0.0, 1.0, back <= front), 0.0, 0.0, 0.0); }

  let sigma = -log(clamp(base, vec3f(0.03), vec3f(0.995))) * density;
  let Tt = exp(-sigma * thick);
  let thin = exp(-thick * density * 0.45);
  // thick cores deep and saturated, thin areas light; opaque materials keep their base colour
  let alb = mix(base, mix(deep, base, 0.1 + 0.9 * thin), sat(sssM));

  let L = normalize(G.keyDir.xyz);
  let NoL = dot(N, L);
  let shKey = mix(vec3f(1.0), sphereShadows(P + N * 0.03, L, id, G.look3.x), G.look2.w);
  let ao = mix(1.0, occlusionAt(P, N, id), G.look3.y);
  if (dbg == 3) { return vec4f(shKey, 1.0); }
  if (dbg == 4) { return vec4f(vec3f(ao), 1.0); }

  // (1) diffuse: soft wrapped falloff; colour slides to deep through the terminator
  let wl = sat((NoL + wrap) / (1.0 + wrap));
  let lit = wl * wl * (3.0 - 2.0 * wl);
  let diffCol = mix(mix(alb * 0.55, deep * 0.45, sat(sssM)), alb, smoothstep(-0.3, 0.8, NoL));
  // velvet: facing parts slightly darker, the sheen lives at grazing angles
  let velvetFace = mix(1.0, 0.72 + 0.28 * (1.0 - NoV), sheenAmt);
  let tDiffuse = diffCol * lit * key * shKey * velvetFace;

  // (2) ambient + bounce
  let skyAmb = mix(G.bgBot.rgb * 0.8, G.bgTop.rgb, N.y * 0.5 + 0.5);
  var bounce = vec3f(0.0);
  if (QUALITY >= 1.0) { bounce = bounceAt(P, N, id); }
  let tAmb = (mix(mix(alb, deep, 0.35 * sssM), alb, 0.5) * skyAmb * ambK + bounce * alb * G.look4.x * 0.35) * ao;

  // (3) subsurface glow + (4) rim transmission (translucent materials only)
  let Tg = exp(-sigma * thick * 0.35);
  let gDir = pow(sat(dot(V, -normalize(L + N * 0.55))), 1.5);
  let tGlow = base * Tg * (gDir * 0.9 + 0.05) * transK * key * sss * shKey;
  let Lr = normalize(G.rimDir.xyz);
  let tDot = sat(dot(V, -normalize(Lr + N * 0.35)));
  let edge = pow(1.0 - NoV, 1.5);
  let tRim = base * Tg * (pow(tDot, 3.0) * 2.0 + 0.3) * edge * transK * G.rimDir.w * sss;

  // (6) velvet sheen: soft bright rim in the sheen colour
  let sheenLight = (lit * 0.8 + 0.25) * key;
  let tSheen = m.sheen.rgb * (pow(1.0 - NoV, 2.2) * 0.9 * sheenAmt + pow(1.0 - NoV, 2.5) * 0.12 * rimK) * sheenLight * ao;

  var scattered = tDiffuse + tAmb + tGlow + tRim + tSheen;

  // (5) refraction
  let T = refract(-V, N, 1.0 / ior);
  var seen = vec3f(0.0);
  var refrAmt = 0.0;
  if (glassPass) {
    // see the actual scene behind through the body: lens offset + frost blur + dispersion
    let c0 = G.viewProj * vec4f(P, 1.0);
    let c1 = G.viewProj * vec4f(P + (T + V) * (thick + 0.8) * 3.2, 1.0);
    let duv = (c1.xy / c1.w - c0.xy / c0.w) * vec2f(0.5, -0.5);
    let uv = in.pos.xy * G.res.zw;
    let lod = clamp(rough * G.look5.w * 7.0, 0.0, 4.5);
    let disp = 0.06;
    seen = vec3f(
      textureSampleLevel(sceneTex, linSamp, uv + duv * (1.0 - disp), lod).r,
      textureSampleLevel(sceneTex, linSamp, uv + duv, lod).g,
      textureSampleLevel(sceneTex, linSamp, uv + duv * (1.0 + disp), lod).b);
    seen *= exp(-sigma * thick * 0.5);
    // thick lens edges go smoky; frosted interior adds a milky veil
    seen *= mix(vec3f(1.0), G.bgBot.rgb * 0.45, pow(1.0 - NoV, 1.6) * clarity);
    // total-internal-reflection ring just inside the silhouette: reads as thick glass
    let ring = smoothstep(0.55, 0.8, 1.0 - NoV) * (1.0 - smoothstep(0.86, 0.97, 1.0 - NoV));
    seen += vec3f(ring * 0.22 * key) * clarity;
    let milk = mix(G.bgTop.rgb, base, 0.5) * (0.1 + 0.25 * rough) * (0.6 + 0.4 * lit) * key;
    seen = seen * (1.0 - 0.25 * rough) + milk * clarity;
    refrAmt = clarity;
    // frosted glass scatters a little light internally (milky)
    scattered = mix(scattered, tDiffuse * 0.25 + tAmb * 0.5 + base * 0.08 * key, sat(clarity * 1.2) * (1.0 - sssM));
  } else {
    let bp = rayPlaneZ(P + T * thick, normalize(T * 0.7 - V * 0.3), G.bgTop.w);
    // full quality sees shadows through the jelly; lower tiers just the backdrop gradient
    var behind = backdropBase(bp);
    if (QUALITY >= 2.0) { behind = backdrop(bp, ign(in.pos.xy) * 6.283); }
    seen = behind * exp(-sigma * thick * 1.2);
    refrAmt = refrK * sssM * (1.0 - smoothstep(0.0, 3.0, thick) * 0.5);
  }
  var col = mix(scattered, seen + scattered * 0.5 * (1.0 - clarity), refrAmt);

  // (7) specular: GGX key + env reflections (roughness-aware), optional thin-film
  let H = normalize(L + V);
  let NoH = sat(dot(N, H));
  let a = rough * rough;
  let Fh = 0.04 + 0.96 * pow(1.0 - sat(dot(H, V)), 5.0);
  // thin-film colour only toward the rims (not a soap bubble)
  let film = mix(vec3f(1.0), thinFilm(NoV) * 1.4, irid * pow(1.0 - NoV, 1.5));
  let tSpec = film * ggx(NoH, a) * sat(NoL) * 0.25 * specK * key * Fh * shKey * (0.25 + coat);
  let F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
  let R = reflect(-V, N);
  var occR = 1.0;
  if (QUALITY >= 2.0) { occR = mix(1.0, occlusionAt(P, R, id), 0.8); }
  let reflW = mix(F * coat, 0.08 + F * 0.9, clarity);
  let tEnv = env(R, rough) * film * reflW * occR;
  // iridescent rim (glass edges catch colour)
  let tFilmRim = thinFilm(NoV) * pow(1.0 - NoV, 3.0) * (1.0 - pow(1.0 - NoV, 8.0)) * irid * 0.15 * key;

  // (8) glitter
  var tGlit = vec3f(0.0);
  if (glitterAmt > 0.001) {
    tGlit = glitter(in.rp, N, V, L, 11.0) * glitterAmt * (0.4 + 0.6 * shKey);
  }

  if (dbg == 5) { return vec4f(tDiffuse, 1.0); }
  if (dbg == 6) { return vec4f(tAmb, 1.0); }
  if (dbg == 7) { return vec4f(tGlow + tRim, 1.0); }
  if (dbg == 8) { return vec4f(seen * refrAmt, 1.0); }
  if (dbg == 9) { return vec4f(tEnv + tSpec, 1.0); }

  col = col * (1.0 - reflW) + tEnv + tSpec + tFilmRim + tGlit;
  return vec4f(col, 1.0);
}

@fragment fn fs_body(in: VOut) -> @location(0) vec4f { return shade(in, false); }
@fragment fn fs_body_clear(in: VOut) -> @location(0) vec4f { return shade(in, true); }

// ---------------- back faces: distance to camera ----------------
@fragment fn fs_back(in: VOut) -> @location(0) vec4f {
  return vec4f(length(in.wp - G.camPos.xyz), 0.0, 0.0, 1.0);
}
`,ye=`
${ee}
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) @interpolate(flat) id: u32,
  @location(2) n: vec3f,
};
@vertex fn vs_body(@location(0) p: vec3f, @location(1) n: vec3f, @builtin(instance_index) id: u32) -> VOut {
  var o: VOut;
  o.pos = G.viewProj * vec4f(p, 1.0);
  o.wp = p;
  o.id = id;
  return o;
}
@fragment fn fs_back(in: VOut) -> @location(0) vec4f {
  return vec4f(length(in.wp - G.camPos.xyz), 0.0, 0.0, 1.0);
}

@vertex fn vs_light(@location(0) p: vec3f, @location(1) n: vec3f, @builtin(instance_index) id: u32) -> VOut {
  var o: VOut;
  o.pos = G.lightVP * vec4f(p, 1.0);
  o.wp = p;
  o.id = id;
  o.n = n;
  return o;
}
struct ShadowOut { @location(0) tint: vec4f, @location(1) occ: vec4f };
@fragment fn fs_light(in: VOut) -> ShadowOut {
  var o: ShadowOut;
  o.tint = vec4f(G.bodyTint[in.id].rgb, 1.0);
  // distance from this occluder surface to the backdrop, along the light
  let L = normalize(G.keyDir.xyz);
  let d = (in.wp.z - G.bgTop.w) / max(L.z, 0.05);
  // caustic: the part of the body facing the light acts like a lens, focusing into the shadow
  let focus = pow(sat(dot(normalize(in.n), L)), 10.0) * (1.0 + mats[in.id].p0.z * 2.5) * sat(mats[in.id].p0.w + mats[in.id].p0.z);
  o.occ = vec4f(d, 1.0, focus, 1.0);
  return o;
}
`,xe=`
struct Post {
  a: vec4f, // threshold, bloom strength, exposure, tonemap
  b: vec4f, // vignette, grain, chroma, time
  c: vec4f, // upsample radius, -, -, -
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> U: Post;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

struct FsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs_full(@builtin(vertex_index) i: u32) -> FsOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: FsOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn down(uv: vec2f) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var c = textureSample(src, samp, uv).rgb * 0.5;
  c += textureSample(src, samp, uv + vec2f(-t.x, -t.y)).rgb * 0.125;
  c += textureSample(src, samp, uv + vec2f(t.x, -t.y)).rgb * 0.125;
  c += textureSample(src, samp, uv + vec2f(-t.x, t.y)).rgb * 0.125;
  c += textureSample(src, samp, uv + vec2f(t.x, t.y)).rgb * 0.125;
  return c;
}

@fragment fn fs_prefilter(in: FsOut) -> @location(0) vec4f {
  let c = down(in.uv);
  let l = luma(c);
  let th = U.a.x;
  let knee = th * 0.5 + 1e-4;
  var s = clamp(l - th + knee, 0.0, 2.0 * knee);
  s = s * s / (4.0 * knee);
  let w = max(s, l - th) / max(l, 1e-4);
  return vec4f(min(c * w, vec3f(50.0)), 1.0);
}

@fragment fn fs_down(in: FsOut) -> @location(0) vec4f {
  return vec4f(down(in.uv), 1.0);
}

@fragment fn fs_up(in: FsOut) -> @location(0) vec4f {
  let t = U.c.x / vec2f(textureDimensions(src));
  var c = textureSample(src, samp, in.uv).rgb * 4.0;
  c += textureSample(src, samp, in.uv + vec2f(-t.x, 0.0)).rgb * 2.0;
  c += textureSample(src, samp, in.uv + vec2f(t.x, 0.0)).rgb * 2.0;
  c += textureSample(src, samp, in.uv + vec2f(0.0, -t.y)).rgb * 2.0;
  c += textureSample(src, samp, in.uv + vec2f(0.0, t.y)).rgb * 2.0;
  c += textureSample(src, samp, in.uv + vec2f(-t.x, -t.y)).rgb;
  c += textureSample(src, samp, in.uv + vec2f(t.x, -t.y)).rgb;
  c += textureSample(src, samp, in.uv + vec2f(-t.x, t.y)).rgb;
  c += textureSample(src, samp, in.uv + vec2f(t.x, t.y)).rgb;
  return vec4f(c / 16.0, 1.0);
}

fn neutral(cIn: vec3f) -> vec3f {
  let sc = 0.76;
  let desat = 0.15;
  let x = min(cIn.r, min(cIn.g, cIn.b));
  let off = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = cIn - off;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < sc) { return c; }
  let d = 1.0 - sc;
  let np = 1.0 - d * d / (peak + d - sc);
  c *= np / peak;
  let g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(c, vec3f(np), g);
}

fn agx(cIn: vec3f) -> vec3f {
  let m = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                  0.0784335999999992, 0.878468636469772, 0.0784336,
                  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let mi = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                   -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                   -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  let mn = -12.47393;
  let mx = 4.026069;
  var v = m * max(cIn, vec3f(1e-10));
  v = clamp(log2(v), vec3f(mn), vec3f(mx));
  v = (v - mn) / (mx - mn);
  let v2 = v * v;
  let v4 = v2 * v2;
  v = 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v - 0.00232;
  let lw = vec3f(0.2126, 0.7152, 0.0722);
  let luma = dot(v, lw);
  v = pow(max(v, vec3f(0.0)), vec3f(1.12));
  v = luma + 1.25 * (v - luma);
  v = mi * v;
  return pow(max(v, vec3f(0.0)), vec3f(2.2));
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

@fragment fn fs_composite(in: FsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let dc = uv - 0.5;
  let ca = U.b.z;
  var c = vec3f(
    textureSample(src, samp, uv - dc * ca).r,
    textureSample(src, samp, uv).g,
    textureSample(src, samp, uv + dc * ca).b);
  c += textureSample(bloomTex, samp, uv).rgb * U.a.y;
  c *= U.a.z;
  let tm = i32(U.a.w);
  if (tm == 0) { c = neutral(c); } else if (tm == 1) { c = agx(c); } else { c = aces(c); }
  let vig = 1.0 - U.b.x * smoothstep(0.25, 1.1, length(dc * vec2f(1.0, 0.8)) * 1.6);
  c *= vig;
  c = toSrgb(clamp(c, vec3f(0.0), vec3f(1.0)));
  let px = in.pos.xy;
  let g = hash(px + fract(U.b.w * 13.17) * 917.0) + hash(px * 1.37 + fract(U.b.w * 7.3) * 431.0) - 1.0;
  c += g * U.b.y;
  return vec4f(c, 1.0);
}
`,Ht={substeps:[2,1,8,1],wobbleHz:[2.5,.3,15],wobbleDamping:[2.5,0,40],volume:[1,0,1],squash:[.7,0,1],smoothing:[.6,0,1],smoothIters:[4,0,12,1],maxStretch:[.45,.05,1.5],airDrag:[.18,0,3],gravity:[0,0,20],drift:[.55,0,4],zSpring:[.6,0,5],wallFriction:[.08,0,1],bodyFriction:[.04,0,1],contactMargin:[.015,0,.2],contactStiffness:[1,.1,1],collisionIters:[2,1,4,1],contactRadius:[.22,.05,.6],maxSpeed:[28,2,80],grabRadius:[1.3,.1,3],grabHz:[7,1,30],bodyCount:[9,1,24,1],sizeScale:[1.2,.4,2],resolution:[1,.4,1],exposure:[1,.2,3],keyLight:[1.6,0,6],ambient:[.25,0,2],tonemap:[0,0,2,1],sss:[1,0,3],density:[2.2,.05,6],wrap:[.55,0,1],transmission:[1,0,5],refraction:[.35,0,1],ior:[1.38,1,2],specular:[1.4,0,3],roughness:[1,.1,3],clearcoat:[1,0,3],envIntensity:[1,0,3],rimLight:[1.2,0,4],shadow:[.5,0,1],shadowSoftness:[.35,0,1.5],ao:[.6,0,1.5],caustics:[.8,0,4],glitter:[1,0,4],bump:[1,0,4],iridescence:[1,0,3],frost:[1,0,3],bleed:[.6,0,3],bloom:[.22,0,1.5],bloomThreshold:[.85,0,4],vignette:[.16,0,1],grain:[.012,0,.1],chroma:[.0025,0,.02],palette:[0,0,7,1],debug:[0,0,9,1]},we={gummy:{rough:.16,coat:.8,clarity:0,sss:1,sheen:0,glitter:0,bump:0,irid:0},velvet:{rough:.7,coat:0,clarity:0,sss:.25,sheen:1,glitter:0,bump:.3,irid:0},clay:{rough:.55,coat:.1,clarity:0,sss:.55,sheen:.35,glitter:0,bump:.08,irid:0},peach:{rough:.6,coat:.04,clarity:0,sss:.65,sheen:.8,glitter:0,bump:1,irid:0},glass:{rough:.36,coat:1,clarity:1,sss:0,sheen:0,glitter:0,bump:0,irid:.35},gel:{rough:.42,coat:.9,clarity:.8,sss:.35,sheen:0,glitter:0,bump:.1,irid:.3},glitter:{rough:.24,coat:.7,clarity:.4,sss:1,sheen:0,glitter:1,bump:.12,irid:0}},Wt=[{name:"sorbet",bg:["#f6eeea","#ead9df"],mats:[["#ff8a6b","#e0234a","#ffd2b8","gummy"],["#ffc94d","#ff7a1a","#fff1c2","clay"],["#b9a4ff","#5b3cff","#d9ccff","velvet"],["#7fe0c5","#109a85","#e2fff6","gummy"],["#ff9ec7","#e0337f","#ffe3f0","gummy"],["#eef3f8","#b8c6d6","#ffffff","glass"],["#7ab8ff","#1d4fe0","#e1efff","glitter"]]},{name:"velvet",bg:["#a7afc0","#848ea3"],mats:[["#3d4fe0","#1a1f8a","#9aa6ff","velvet"],["#4a3fd6","#1c1488","#a59cff","velvet"],["#f6b3bd","#c9566e","#ffe0e6","clay"],["#ff3fa6","#a80f5c","#ffb8de","velvet"],["#3b5cff","#1a2aa0","#b4c2ff","velvet"]]},{name:"pastel glass",bg:["#d3dce2","#b0bdc8"],mats:[["#f1dcd8","#a9787d","#fff2f0","clay"],["#eef3f8","#b8c6d6","#ffffff","glass"],["#f6c676","#c8742a","#fff0cc","clay"],["#dbe9a6","#8fb23a","#f6ffd9","clay"],["#eef3f8","#b8c6d6","#ffffff","glass"],["#e8d6ee","#9a77a8","#fbf2ff","clay"]]},{name:"glitter gel",bg:["#6a7370","#3e4744"],mats:[["#aef03a","#3c9a00","#e8ffc2","glitter"],["#ffad66","#e0602a","#ffe2c8","peach"],["#62d2cb","#0f7d8a","#d5fffb","glitter"],["#dfe9ec","#8fa7b0","#ffffff","gel"],["#3dbb5a","#0d6b2a","#c8ffd4","gummy"],["#ff9a5c","#d8501e","#ffd9c0","peach"]]},{name:"cobalt",bg:["#dfe4f2","#b9c3e3"],mats:[["#3a5bff","#0b1a9e","#bcc9ff","gummy"],["#ff6a3d","#c21a00","#ffd0bf","velvet"],["#f2efe9","#bfb5aa","#ffffff","clay"],["#ffd23f","#e08600","#fff4c4","gummy"],["#9ad7ff","#2a76d6","#e9f6ff","gel"]]},{name:"candy-noir",bg:["#2a2430","#141018"],mats:[["#ff5fa2","#b0005a","#ffd0e6","gummy"],["#ffb347","#d45500","#ffe8c7","glitter"],["#8a7dff","#3010c8","#e2ddff","velvet"],["#53e3c2","#007f6b","#d6fff4","gummy"],["#ff4d4d","#9c0010","#ffd1d1","gummy"],["#e6e9f2","#9aa3c0","#ffffff","glass"]]},{name:"pearl",bg:["#eceae6","#d8d4ce"],mats:[["#f6f3ee","#d6c2b4","#ffffff","clay"],["#f1d9cf","#c98b7a","#fff3ee","velvet"],["#d9dff2","#8b99c9","#f6f8ff","gel"],["#e8e2d0","#b8a77a","#fffbef","gummy"]]},{name:"acid",bg:["#e9efe6","#cfdccd"],mats:[["#c6ff3d","#4fae00","#f2ffd1","glitter"],["#ff3dc8","#a0007a","#ffd1f2","gummy"],["#3dd2ff","#0067a8","#d1f5ff","gummy"],["#ff8c1a","#c23d00","#ffe1c2","velvet"],["#7a3dff","#2a0099","#e2d6ff","gummy"]]}],Kt=["sphere","pill","cube","torus","sphere","slab","bean","sphere","pill","cube","torus","bean"];function wt(i){const t=parseInt(i.slice(1),16);return[t>>16&255,t>>8&255,t&255].map(s=>s/255).map(s=>s<=.04045?s/12.92:((s+.055)/1.055)**2.4)}const Yt=Math.PI/2;function Pe(i,t,e=1e-5){const s=new Map,o=[],n=new Int32Array(i.length/3),r=1/e;for(let a=0;a<i.length/3;a++){const c=i[a*3],h=i[a*3+1],f=i[a*3+2],g=`${Math.round(c*r)},${Math.round(h*r)},${Math.round(f*r)}`;let d=s.get(g);d===void 0&&(d=o.length/3,s.set(g,d),o.push(c,h,f)),n[a]=d}const u=[];for(let a=0;a<t.length;a+=3){const c=n[t[a]],h=n[t[a+1]],f=n[t[a+2]];c!==h&&h!==f&&c!==f&&u.push(c,h,f)}return{positions:new Float32Array(o),indices:new Uint32Array(u)}}function Z(i,t,e=18){const s=[],o=[],n=[[0,1,1,2],[0,-1,2,1],[1,1,2,0],[1,-1,0,2],[2,1,0,1],[2,-1,1,0]],r=[0,0,0];for(const[h,f,g,d]of n){const p=s.length/3;for(let l=0;l<=e;l++)for(let m=0;m<=e;m++){const y=m/e*2-1,x=l/e*2-1;r[h]=f*(i[h]+t),r[g]=$t(y,i[g],t),r[d]=$t(x,i[d],t);const b=Pt(r[0],-i[0],i[0]),v=Pt(r[1],-i[1],i[1]),w=Pt(r[2],-i[2],i[2]);let P=r[0]-b,z=r[1]-v,T=r[2]-w;const S=Math.hypot(P,z,T)||1;s.push(b+P/S*t,v+z/S*t,w+T/S*t)}for(let l=0;l<e;l++)for(let m=0;m<e;m++){const y=p+l*(e+1)+m,x=y+1,b=y+e+1,v=b+1;o.push(y,x,v,y,v,b)}}const u=Pe(s,o);se(u);const a=(h,f,g)=>{const d=Math.abs(h)-i[0],p=Math.abs(f)-i[1],l=Math.abs(g)-i[2],m=Math.max(d,0),y=Math.max(p,0),x=Math.max(l,0);return Math.sqrt(m*m+y*y+x*x)+Math.min(Math.max(d,Math.max(p,l)),0)-t},c=Math.hypot(i[0],i[1],i[2])+t;return{...u,sdf:a,bound:c}}function $t(i,t,e){const s=t+e*Yt*.5,o=i*s,n=Math.abs(o);if(n<=t)return o;const r=Math.min((n-t)/e,Yt*.5);return Math.sign(o)*(t+e*(Math.abs(i)===1?1:Math.tan(r)))}function ze(i,t,e=72,s=28){const o=[],n=[];for(let a=0;a<s;a++){const c=a/s*Math.PI*2;for(let h=0;h<e;h++){const f=h/e*Math.PI*2,g=Math.cos(f),d=Math.sin(f),p=i+t*Math.cos(c);o.push(g*p,t*Math.sin(c),d*p)}}for(let a=0;a<s;a++)for(let c=0;c<e;c++){const h=a*e+c,f=a*e+(c+1)%e,g=(a+1)%s*e+c,d=(a+1)%s*e+(c+1)%e;n.push(h,d,f,h,g,d)}const r={positions:new Float32Array(o),indices:new Uint32Array(n)};return se(r,(a,c,h)=>{const f=Math.hypot(a,h)||1;return[a-a/f*i,c,h-h/f*i]}),{...r,sdf:(a,c,h)=>{const f=Math.sqrt(a*a+h*h)-i;return Math.sqrt(f*f+c*c)-t},bound:i+t}}function se(i,t=(e,s,o)=>[e,s,o]){const e=i.positions,s=i.indices;for(let o=0;o<s.length;o+=3){const n=s[o]*3,r=s[o+1]*3,u=s[o+2]*3,a=e[r]-e[n],c=e[r+1]-e[n+1],h=e[r+2]-e[n+2],f=e[u]-e[n],g=e[u+1]-e[n+1],d=e[u+2]-e[n+2],p=c*d-h*g,l=h*f-a*d,m=a*g-c*f,y=(e[n]+e[r]+e[u])/3,x=(e[n+1]+e[r+1]+e[u+1])/3,b=(e[n+2]+e[r+2]+e[u+2])/3,v=t(y,x,b);if(p*v[0]+l*v[1]+m*v[2]<0){const w=s[o+1];s[o+1]=s[o+2],s[o+2]=w}}}function Pt(i,t,e){return i<t?t:i>e?e:i}const $=(i,t)=>Math.max(6,Math.round(i*t)),Me={sphere:(i,t=1)=>Z([0,0,0],1*i,$(20,t)),pill:(i,t=1)=>Z([0,.75*i,0],.62*i,$(20,t)),cube:(i,t=1)=>Z([.55*i,.55*i,.55*i],.32*i,$(18,t)),slab:(i,t=1)=>Z([.8*i,.22*i,.8*i],.28*i,$(20,t)),torus:(i,t=1)=>ze(.82*i,.4*i,$(64,t),$(26,t)),bean:(i,t=1)=>Z([.45*i,0,0],.78*i,$(20,t))},F=()=>new Float64Array(9);function oe(i){return i[0]*(i[4]*i[8]-i[7]*i[5])-i[3]*(i[1]*i[8]-i[7]*i[2])+i[6]*(i[1]*i[5]-i[4]*i[2])}function J(i,t){const e=oe(i),s=Math.abs(e)<1e-12?0:1/e;return t[0]=(i[4]*i[8]-i[7]*i[5])*s,t[1]=(i[7]*i[2]-i[1]*i[8])*s,t[2]=(i[1]*i[5]-i[4]*i[2])*s,t[3]=(i[6]*i[5]-i[3]*i[8])*s,t[4]=(i[0]*i[8]-i[6]*i[2])*s,t[5]=(i[3]*i[2]-i[0]*i[5])*s,t[6]=(i[3]*i[7]-i[6]*i[4])*s,t[7]=(i[6]*i[1]-i[0]*i[7])*s,t[8]=(i[0]*i[4]-i[3]*i[1])*s,t}function zt(i,t,e){for(let s=0;s<3;s++)for(let o=0;o<3;o++)e[s*3+o]=i[o]*t[s*3]+i[3+o]*t[s*3+1]+i[6+o]*t[s*3+2];return e}function Gt(i,t){const[e,s,o,n]=i;return t[0]=1-2*(s*s+o*o),t[1]=2*(e*s+o*n),t[2]=2*(e*o-s*n),t[3]=2*(e*s-o*n),t[4]=1-2*(e*e+o*o),t[5]=2*(s*o+e*n),t[6]=2*(e*o+s*n),t[7]=2*(s*o-e*n),t[8]=1-2*(e*e+s*s),t}function ke(i,t,e=6){const s=F();for(let o=0;o<e;o++){Gt(t,s);let n=0,r=0,u=0,a=0;for(let P=0;P<3;P++){const z=s[P*3],T=s[P*3+1],S=s[P*3+2],G=i[P*3],A=i[P*3+1],L=i[P*3+2];n+=T*L-S*A,r+=S*G-z*L,u+=z*A-T*G,a+=z*G+T*A+S*L}const c=1/(Math.abs(a)+1e-9);n*=c,r*=c,u*=c;const h=Math.hypot(n,r,u);if(h<1e-9)break;const f=h*.5,g=Math.sin(f)/h,d=n*g,p=r*g,l=u*g,m=Math.cos(f),[y,x,b,v]=t;t[0]=m*y+d*v+p*b-l*x,t[1]=m*x-d*b+p*v+l*y,t[2]=m*b+d*x-p*y+l*v,t[3]=m*v-d*y-p*x-l*b;const w=Math.hypot(t[0],t[1],t[2],t[3]);t[0]/=w,t[1]/=w,t[2]/=w,t[3]/=w}return Gt(t,s)}function Se(i){let t=i>>>0;return()=>(t^=t<<13,t>>>=0,t^=t>>>17,t^=t<<5,t>>>=0,t/4294967296)}class Te{constructor(t,e,s,o=1){const n=Me[t](e,o);this.shapeName=t,this.shape=n,this.material=s,this.n=n.positions.length/3,this.indices=n.indices,this.rest=new Float64Array(n.positions),this.x=new Float64Array(this.n*3),this.p=new Float64Array(this.n*3),this.v=new Float64Array(this.n*3),this.normals=new Float32Array(this.n*3),this.pn=new Float32Array(this.n*3),this.bound=n.bound;let r=0,u=0,a=0;for(let d=0;d<this.n;d++)r+=this.rest[d*3],u+=this.rest[d*3+1],a+=this.rest[d*3+2];r/=this.n,u/=this.n,a/=this.n;for(let d=0;d<this.n;d++)this.rest[d*3]-=r,this.rest[d*3+1]-=u,this.rest[d*3+2]-=a;this.restOffset=[r,u,a];let c=0;for(let d=0;d<this.n;d++)c+=Math.hypot(this.rest[d*3],this.rest[d*3+1],this.rest[d*3+2]);this.radiusEff=c/this.n*.95;const h=Array.from({length:this.n},()=>new Set),f=this.indices;for(let d=0;d<f.length;d+=3){const p=f[d],l=f[d+1],m=f[d+2];h[p].add(l),h[p].add(m),h[l].add(p),h[l].add(m),h[m].add(p),h[m].add(l)}this.adjStart=new Int32Array(this.n+1);for(let d=0;d<this.n;d++)this.adjStart[d+1]=this.adjStart[d]+h[d].size;this.adj=new Int32Array(this.adjStart[this.n]);for(let d=0,p=0;d<this.n;d++)for(const l of h[d])this.adj[p++]=l;this.goal=new Float64Array(this.n*3),this.vgrad=new Float64Array(this.n*3),this.restVolume=Ae(this.rest,this.indices),this.dev=new Float64Array(this.n*3);const g=F();for(let d=0;d<this.n;d++){const p=this.rest[d*3],l=this.rest[d*3+1],m=this.rest[d*3+2];g[0]+=p*p,g[1]+=l*p,g[2]+=m*p,g[3]+=p*l,g[4]+=l*l,g[5]+=m*l,g[6]+=p*m,g[7]+=l*m,g[8]+=m*m}this.AqqInv=J(g,F()),this.q=[0,0,0,1],this.R=F(),this.M=F(),this.Minv=F(),this.c=[0,0,0],this.vc=[0,0,0],this.phase=[0,0,0,0,0,0],this.grab=null}place(t,e,s,o=[0,0,0]){const n=Gt(e,F());this.q=[...e];for(let r=0;r<this.n;r++){const u=this.rest[r*3],a=this.rest[r*3+1],c=this.rest[r*3+2],h=n[0]*u+n[3]*a+n[6]*c,f=n[1]*u+n[4]*a+n[7]*c,g=n[2]*u+n[5]*a+n[8]*c;this.x[r*3]=t[0]+h,this.x[r*3+1]=t[1]+f,this.x[r*3+2]=t[2]+g,this.v[r*3]=s[0]+o[1]*g-o[2]*f,this.v[r*3+1]=s[1]+o[2]*h-o[0]*g,this.v[r*3+2]=s[2]+o[0]*f-o[1]*h}this.p.set(this.x),this.c=[...t],this.R.set(n),this.M.set(n),J(this.M,this.Minv)}match(t,e,s){const o=this.n,n=this.p,r=this.rest;let u=0,a=0,c=0;for(let l=0;l<o;l++)u+=n[l*3],a+=n[l*3+1],c+=n[l*3+2];u/=o,a/=o,c/=o;const h=F();for(let l=0;l<o;l++){const m=n[l*3]-u,y=n[l*3+1]-a,x=n[l*3+2]-c,b=r[l*3],v=r[l*3+1],w=r[l*3+2];h[0]+=m*b,h[1]+=y*b,h[2]+=x*b,h[3]+=m*v,h[4]+=y*v,h[5]+=x*v,h[6]+=m*w,h[7]+=y*w,h[8]+=x*w}const f=ke(h,this.q),g=zt(h,this.AqqInv,F());let d=oe(g);const p=this.M;if(d>1e-6){const l=1/Math.cbrt(d);for(let b=0;b<9;b++)p[b]=e*g[b]*l+(1-e)*f[b];const m=F();for(let b=0;b<3;b++)for(let v=0;v<3;v++)m[b*3+v]=f[v*3+b];const y=zt(m,p,F());let x=0;for(let b=0;b<9;b++){const v=y[b]-(b%4===0?1:0);x+=v*v}if(x=Math.sqrt(x),x>s){const b=s/x;for(let v=0;v<9;v++)y[v]=(v%4===0?1:0)+(y[v]-(v%4===0?1:0))*b;zt(f,y,p)}}else p.set(f);this.R.set(f),d>.15?J(g,this.Minv):J(p,this.Minv),this.c[0]=u,this.c[1]=a,this.c[2]=c;for(let l=0;l<o;l++){const m=r[l*3],y=r[l*3+1],x=r[l*3+2],b=u+p[0]*m+p[3]*y+p[6]*x,v=a+p[1]*m+p[4]*y+p[7]*x,w=c+p[2]*m+p[5]*y+p[8]*x;n[l*3]+=(b-n[l*3])*t,n[l*3+1]+=(v-n[l*3+1])*t,n[l*3+2]+=(w-n[l*3+2])*t,this.goal[l*3]=b,this.goal[l*3+1]=v,this.goal[l*3+2]=w}}smoothDeformation(t,e){const s=this.n,o=this.p,n=this.goal,r=this.dev,u=this.adjStart,a=this.adj;for(let c=0;c<s*3;c++)r[c]=o[c]-n[c];for(let c=0;c<e;c++)for(let h=0;h<s;h++){let f=0,g=0,d=0;const p=u[h],l=u[h+1];for(let x=p;x<l;x++){const b=a[x]*3;f+=r[b],g+=r[b+1],d+=r[b+2]}const m=1/(l-p),y=h*3;r[y]+=(f*m-r[y])*t,r[y+1]+=(g*m-r[y+1])*t,r[y+2]+=(d*m-r[y+2])*t}for(let c=0;c<s*3;c++)o[c]=n[c]+r[c]}preserveVolume(t){const e=this.p,s=this.indices,o=this.vgrad;o.fill(0);let n=0;for(let a=0;a<s.length;a+=3){const c=s[a]*3,h=s[a+1]*3,f=s[a+2]*3,g=e[c],d=e[c+1],p=e[c+2],l=e[h],m=e[h+1],y=e[h+2],x=e[f],b=e[f+1],v=e[f+2];n+=g*(m*v-y*b)-d*(l*v-y*x)+p*(l*b-m*x),o[c]+=m*v-y*b,o[c+1]+=y*x-l*v,o[c+2]+=l*b-m*x,o[h]+=b*p-v*d,o[h+1]+=v*g-x*p,o[h+2]+=x*d-b*g,o[f]+=d*y-p*m,o[f+1]+=p*l-g*y,o[f+2]+=g*m-d*l}n/=6;let r=0;for(let a=0;a<o.length;a++)o[a]/=6,r+=o[a]*o[a];if(r<1e-12)return;const u=t*(n-this.restVolume)/r;for(let a=0;a<o.length;a++)e[a]-=u*o[a]}buildHash(t){const s=this.n,o=this.p,n=this.pn;this.hash||(this.hash={start:new Int32Array(4097),cell:new Int32Array(s),spos:new Float32Array(s*3),snrm:new Float32Array(s*3),mask:4095});const r=this.hash;r.cs=t;const u=1/t,{start:a,cell:c,spos:h,snrm:f}=r;a.fill(0);for(let d=0;d<s;d++){const p=ie(Math.floor(o[d*3]*u),Math.floor(o[d*3+1]*u),Math.floor(o[d*3+2]*u))&4095;c[d]=p,a[p+1]++}for(let d=0;d<4096;d++)a[d+1]+=a[d];const g=r.fill||=new Int32Array(4096);g.set(a.subarray(0,4096));for(let d=0;d<s;d++){const p=g[c[d]]++*3;h[p]=o[d*3],h[p+1]=o[d*3+1],h[p+2]=o[d*3+2],f[p]=n[d*3],f[p+1]=n[d*3+1],f[p+2]=n[d*3+2]}}sdfWorld(t,e,s){const o=this.Minv,n=this.restOffset,r=t-this.c[0],u=e-this.c[1],a=s-this.c[2],c=o[0]*r+o[3]*u+o[6]*a+n[0],h=o[1]*r+o[4]*u+o[7]*a+n[1],f=o[2]*r+o[5]*u+o[8]*a+n[2];return this.shape.sdf(c,h,f)}computeNormals(t=this.x,e=this.normals){const s=this.indices;e.fill(0);for(let o=0;o<s.length;o+=3){const n=s[o]*3,r=s[o+1]*3,u=s[o+2]*3,a=t[r]-t[n],c=t[r+1]-t[n+1],h=t[r+2]-t[n+2],f=t[u]-t[n],g=t[u+1]-t[n+1],d=t[u+2]-t[n+2],p=c*d-h*g,l=h*f-a*d,m=a*g-c*f;e[n]+=p,e[n+1]+=l,e[n+2]+=m,e[r]+=p,e[r+1]+=l,e[r+2]+=m,e[u]+=p,e[u+1]+=l,e[u+2]+=m}for(let o=0;o<this.n;o++){const n=e[o*3],r=e[o*3+1],u=e[o*3+2],a=Math.sqrt(n*n+r*r+u*u)||1;e[o*3]/=a,e[o*3+1]/=a,e[o*3+2]/=a}}}class Ge{constructor(t){this.params=t,this.bodies=[],this.planes=[],this.time=0,this.pointer=null}setBounds(t){this.planes=t}step(t){const s=this.params.substeps,o=t/s;for(let n=0;n<s;n++)this.substep(o);this.time+=t;for(const n of this.bodies)n.computeNormals()}substep(t){const e=this.params,s=this.bodies;for(const a of s)this.predict(a,t);const o=2*Math.PI*e.wobbleHz,n=Math.min(1,o*o*t*t);for(const a of s)a.match(n,e.squash,e.maxStretch);const r=2*Math.PI*e.grabHz,u=Math.min(1,r*r*t*t);for(const a of s)a.grab&&this.applyGrab(a,u);if(e.smoothing>0)for(const a of s)a.smoothDeformation(e.smoothing,e.smoothIters);if(e.volume>0)for(const a of s)a.preserveVolume(e.volume);for(const a of s)a.computeNormals(a.p,a.pn);for(let a=0;a<e.collisionIters;a++){for(const c of s)c.buildHash(e.contactRadius);for(let c=0;c<s.length;c++)for(let h=c+1;h<s.length;h++){const f=s[c],g=s[h],d=f.c[0]-g.c[0],p=f.c[1]-g.c[1],l=f.c[2]-g.c[2],m=(f.bound+g.bound)*1.25+e.contactMargin;d*d+p*p+l*l>m*m||(this.separateCores(f,g),this.contactPair(f,g),this.contactPair(g,f))}for(const c of s)for(let h=0;h<this.planes.length;h++)this.collidePlane(c,this.planes[h])}for(const a of s)this.integrate(a,t)}predict(t,e){const s=this.params,o=this.time,n=t.phase,r=s.drift*(Math.sin(o*.31+n[0])+.5*Math.sin(o*.73+n[3])),u=s.drift*(Math.sin(o*.27+n[1])+.5*Math.sin(o*.61+n[4]))-s.gravity,a=s.drift*.4*Math.sin(o*.23+n[2])-t.c[2]*s.zSpring,c=Math.exp(-s.airDrag*e),h=t.v,f=t.x,g=t.p,d=t.n*3,p=r*e,l=u*e,m=a*e;for(let y=0;y<d;y+=3){const x=(h[y]+p)*c,b=(h[y+1]+l)*c,v=(h[y+2]+m)*c;h[y]=x,h[y+1]=b,h[y+2]=v,g[y]=f[y]+x*e,g[y+1]=f[y+1]+b*e,g[y+2]=f[y+2]+v*e}}collidePlane(t,e){const s=e[0],o=e[1],n=e[2],r=e[3],u=this.params.wallFriction,a=t.p,c=t.x,h=t.n*3;for(let f=0;f<h;f+=3){const g=s*a[f]+o*a[f+1]+n*a[f+2]-r;if(g>=0)continue;a[f]-=s*g,a[f+1]-=o*g,a[f+2]-=n*g;let d=a[f]-c[f],p=a[f+1]-c[f+1],l=a[f+2]-c[f+2];const m=d*s+p*o+l*n;d-=m*s,p-=m*o,l-=m*n,a[f]-=d*u,a[f+1]-=p*u,a[f+2]-=l*u}}integrate(t,e){const s=this.params,o=t.p,n=t.x,r=t.v,u=t.n,a=u*3,c=1/e;for(let p=0;p<a;p++)r[p]=(o[p]-n[p])*c,n[p]=o[p];this.dampDeformation(t,1-Math.exp(-s.wobbleDamping*e));let h=0,f=0,g=0;for(let p=0;p<a;p+=3)h+=r[p],f+=r[p+1],g+=r[p+2];h/=u,f/=u,g/=u,t.vc[0]=h,t.vc[1]=f,t.vc[2]=g;const d=Math.sqrt(h*h+f*f+g*g);if(d>s.maxSpeed){const p=s.maxSpeed/d-1;for(let l=0;l<a;l+=3)r[l]+=h*p,r[l+1]+=f*p,r[l+2]+=g*p}}separateCores(t,e){const s=e.sdfWorld(t.c[0],t.c[1],t.c[2]),o=t.sdfWorld(e.c[0],e.c[1],e.c[2]),n=Math.max(-s+t.radiusEff*.5,-o+e.radiusEff*.5,0);if(n<=0)return;let r=t.c[0]-e.c[0],u=t.c[1]-e.c[1],a=t.c[2]-e.c[2];const c=Math.hypot(r,u,a)||1;r/=c,u/=c,a/=c;const h=n*.25;for(let f=0;f<t.n*3;f+=3)t.p[f]+=r*h,t.p[f+1]+=u*h,t.p[f+2]+=a*h;for(let f=0;f<e.n*3;f+=3)e.p[f]-=r*h,e.p[f+1]-=u*h,e.p[f+2]-=a*h}contactPair(t,e){const s=this.params,o=e.hash,n=o.cs,r=n*n,u=1/n,a=t.p,c=t.x,{start:h,spos:f,snrm:g}=o,d=s.contactMargin,p=(t.grab?.25:e.grab?.9:.5)*s.contactStiffness,l=s.bodyFriction,m=e.c,y=e.bound*1.35+n,x=.02;for(let b=0;b<t.n*3;b+=3){const v=a[b],w=a[b+1],P=a[b+2],z=v-m[0],T=w-m[1],S=P-m[2];if(z*z+T*T+S*S>y*y)continue;const G=e.sdfWorld(v,w,P);if(G>n*1.5+d)continue;const A=v*u,L=w*u,N=P*u,H=Math.floor(A),V=Math.floor(L),ht=Math.floor(N),ue=A-H<.5?H-1:H,pe=L-V<.5?V-1:V,ge=N-ht<.5?ht-1:ht;let W=-1,Nt=r;for(let I=0;I<2;I++)for(let bt=0;bt<2;bt++)for(let yt=0;yt<2;yt++){const Ut=ie(ue+I,pe+bt,ge+yt)&o.mask;for(let xt=h[Ut],me=h[Ut+1];xt<me;xt++){const et=xt*3,Rt=v-f[et],_t=w-f[et+1],qt=P-f[et+2],jt=Rt*Rt+_t*_t+qt*qt;jt<Nt&&(Nt=jt,W=et)}}let U,R,_,dt;if(W>=0){U=g[W],R=g[W+1],_=g[W+2];const I=(v-f[W])*U+(w-f[W+1])*R+(P-f[W+2])*_;if(I>=d)continue;dt=d-I}else{if(G>=-n*.5)continue;U=e.sdfWorld(v+x,w,P)-e.sdfWorld(v-x,w,P),R=e.sdfWorld(v,w+x,P)-e.sdfWorld(v,w-x,P),_=e.sdfWorld(v,w,P+x)-e.sdfWorld(v,w,P-x);const I=Math.sqrt(U*U+R*R+_*_)||1;U/=I,R/=I,_/=I,dt=d-G}const ut=dt*p;a[b]+=U*ut,a[b+1]+=R*ut,a[b+2]+=_*ut;let pt=a[b]-c[b],gt=a[b+1]-c[b+1],mt=a[b+2]-c[b+2];const vt=pt*U+gt*R+mt*_;pt-=vt*U,gt-=vt*R,mt-=vt*_,a[b]-=pt*l,a[b+1]-=gt*l,a[b+2]-=mt*l}}collidePair(t,e){const s=this.params,o=t.p,n=t.x,r=s.contactMargin,u=.02,a=(t.grab?.15:e.grab?.9:.5)*s.contactStiffness,c=s.bodyFriction,h=e.c,f=e.bound*1.3+r;for(let g=0;g<t.n*3;g+=3){const d=o[g],p=o[g+1],l=o[g+2],m=d-h[0],y=p-h[1],x=l-h[2];if(m*m+y*y+x*x>f*f)continue;const b=e.sdfWorld(d,p,l)-r;if(b>=0)continue;let v=e.sdfWorld(d+u,p,l)-e.sdfWorld(d-u,p,l),w=e.sdfWorld(d,p+u,l)-e.sdfWorld(d,p-u,l),P=e.sdfWorld(d,p,l+u)-e.sdfWorld(d,p,l-u);const z=Math.hypot(v,w,P)||1;v/=z,w/=z,P/=z;const T=-b*a;o[g]+=v*T,o[g+1]+=w*T,o[g+2]+=P*T;let S=o[g]-n[g]-e.vc[0]*0,G=o[g+1]-n[g+1],A=o[g+2]-n[g+2];const L=S*v+G*w+A*P;S-=L*v,G-=L*w,A-=L*P,o[g]-=S*c,o[g+1]-=G*c,o[g+2]-=A*c}}dampDeformation(t,e){if(e<=0)return;const s=t.n,o=t.x,n=t.v;let r=0,u=0,a=0,c=0,h=0,f=0;for(let v=0;v<s;v++)r+=o[v*3],u+=o[v*3+1],a+=o[v*3+2],c+=n[v*3],h+=n[v*3+1],f+=n[v*3+2];r/=s,u/=s,a/=s,c/=s,h/=s,f/=s;let g=0,d=0,p=0;const l=F();for(let v=0;v<s;v++){const w=o[v*3]-r,P=o[v*3+1]-u,z=o[v*3+2]-a,T=n[v*3],S=n[v*3+1],G=n[v*3+2];g+=P*G-z*S,d+=z*T-w*G,p+=w*S-P*T;const A=w*w+P*P+z*z;l[0]+=A-w*w,l[4]+=A-P*P,l[8]+=A-z*z,l[1]-=w*P,l[2]-=w*z,l[5]-=P*z}l[3]=l[1],l[6]=l[2],l[7]=l[5];const m=J(l,F()),y=m[0]*g+m[3]*d+m[6]*p,x=m[1]*g+m[4]*d+m[7]*p,b=m[2]*g+m[5]*d+m[8]*p;for(let v=0;v<s;v++){const w=o[v*3]-r,P=o[v*3+1]-u,z=o[v*3+2]-a,T=c+x*z-b*P,S=h+b*w-y*z,G=f+y*P-x*w;n[v*3]+=(T-n[v*3])*e,n[v*3+1]+=(S-n[v*3+1])*e,n[v*3+2]+=(G-n[v*3+2])*e}}raycast(t,e){let s=null;for(let o=0;o<this.bodies.length;o++){const n=this.bodies[o],r=t[0]-n.c[0],u=t[1]-n.c[1],a=t[2]-n.c[2],c=r*e[0]+u*e[1]+a*e[2],h=r*r+u*u+a*a-(n.bound*1.4)**2;if(c*c-h<0)continue;const f=n.x,g=n.indices;for(let d=0;d<g.length;d+=3){const p=Le(t,e,f,g[d]*3,g[d+1]*3,g[d+2]*3);p>0&&(!s||p<s.t)&&(s={t:p,body:n})}}return s&&(s.point=[t[0]+e[0]*s.t,t[1]+e[1]*s.t,t[2]+e[2]*s.t]),s}startGrab(t){const e=t.body,o=this.params.grabRadius*e.bound,n=[],r=[],u=[];for(let a=0;a<e.n;a++){const c=e.x[a*3]-t.point[0],h=e.x[a*3+1]-t.point[1],f=e.x[a*3+2]-t.point[2],g=Math.exp(-(c*c+h*h+f*f)/(o*o));g<.02||(n.push(a),r.push(g),u.push(c,h,f))}return e.grab={idx:n,w:r,off:u,target:[...t.point],anchor:[...t.point]},e}applyGrab(t,e){const s=t.grab,o=t.p;this.params;for(let n=0;n<s.idx.length;n++){const r=s.idx[n]*3,u=s.w[n]*e;o[r]+=(s.target[0]+s.off[n*3]-o[r])*u,o[r+1]+=(s.target[1]+s.off[n*3+1]-o[r+1])*u,o[r+2]+=(s.target[2]+s.off[n*3+2]-o[r+2])*u}}impulse(t,e,s){for(const o of this.bodies){const n=o.c[0]-t[0],r=o.c[1]-t[1],u=o.c[2]-t[2],a=Math.hypot(n,r,u);if(a>s)continue;const c=e*(1-a/s)**2/(a||1);for(let h=0;h<o.n*3;h+=3)o.v[h]+=n*c,o.v[h+1]+=r*c,o.v[h+2]+=u*c*.3}}}function Ae(i,t){let e=0;for(let s=0;s<t.length;s+=3){const o=t[s]*3,n=t[s+1]*3,r=t[s+2]*3;e+=i[o]*(i[n+1]*i[r+2]-i[n+2]*i[r+1])-i[o+1]*(i[n]*i[r+2]-i[n+2]*i[r])+i[o+2]*(i[n]*i[r+1]-i[n+1]*i[r])}return e/6}function ie(i,t,e){return(i*73856093^t*19349663^e*83492791)>>>0}function Le(i,t,e,s,o,n){const r=e[o]-e[s],u=e[o+1]-e[s+1],a=e[o+2]-e[s+2],c=e[n]-e[s],h=e[n+1]-e[s+1],f=e[n+2]-e[s+2],g=t[1]*f-t[2]*h,d=t[2]*c-t[0]*f,p=t[0]*h-t[1]*c,l=r*g+u*d+a*p;if(Math.abs(l)<1e-10)return-1;const m=1/l,y=i[0]-e[s],x=i[1]-e[s+1],b=i[2]-e[s+2],v=(y*g+x*d+b*p)*m;if(v<0||v>1)return-1;const w=x*a-b*u,P=b*r-y*a,z=y*u-x*r,T=(t[0]*w+t[1]*P+t[2]*z)*m;return T<0||v+T>1?-1:(c*w+h*P+f*z)*m}function Ve(i,t,e,s){const o=Se(t),n=Wt[i.palette|0]||Wt[0],r=i.bodyCount|0,u=[],a=[],c=e*s,h=c*e*4,f=Math.sqrt(h/r)*.27*i.sizeScale,g=[...n.mats.keys()];for(let p=g.length-1;p>0;p--){const l=Math.floor(o()*(p+1));[g[p],g[l]]=[g[l],g[p]]}for(let p=0;p<r;p++){const l=Kt[p%Kt.length],m=f*(.75+o()*.55),y=new Te(l,m,n.mats[g[p%g.length]],i.meshDetail??1);let x=[0,0,0];for(let S=0;S<200&&(x=[(o()*2-1)*(c*.85-y.bound),(o()*2-1)*(e*.85-y.bound),(o()*2-1)*.4],!a.every(([G,A])=>Math.hypot(G[0]-x[0],G[1]-x[1],G[2]-x[2])>A+y.bound+.1));S++);a.push([x,y.bound]);const b=[o()-.5,o()-.5,o()-.5],v=Math.hypot(...b),w=o()*Math.PI,P=[...b.map(S=>S/v*Math.sin(w/2)),Math.cos(w/2)],z=[(o()-.5)*3,(o()-.5)*3,0],T=[(o()-.5)*1.2,(o()-.5)*1.2,(o()-.5)*1.2];y.place(x,P,z,T);for(let S=0;S<6;S++)y.phase[S]=o()*Math.PI*2;y.computeNormals(),u.push(y)}const d=Math.max(...u.map(p=>p.bound))+.25;return{bodies:u,palette:n,zFront:d}}function Oe(i,t){let e=0;for(const s of i){const o=s.x,n=s.normals;for(let r=0;r<s.n;r++)t[e++]=o[r*3],t[e++]=o[r*3+1],t[e++]=o[r*3+2],t[e++]=n[r*3],t[e++]=n[r*3+1],t[e++]=n[r*3+2]}return t}function Fe(i,t){let e=0;for(const s of i){const o=s.x;for(let n=0;n<s.n;n++,e+=6)o[n*3]=t[e],o[n*3+1]=t[e+1],o[n*3+2]=t[e+2]}}const O="rgba16float",st=4,Mt=6,ot=1024,kt=5,St=20;class Ot{static async create(t,e={}){if(!navigator.gpu)throw new Error("WebGPU not available");const s=await navigator.gpu.requestAdapter({powerPreference:"high-performance"});if(!s)throw new Error("No WebGPU adapter");const o=await s.requestDevice();return o.addEventListener("uncapturederror",n=>console.error("[webgpu]",n.error.message)),o.lost.then(n=>console.error("[webgpu] device lost",n.message)),new Ot(t,o,e)}constructor(t,e,s={}){this.canvas=t,this.device=e,this.ctx=t.getContext("webgpu"),this.format=navigator.gpu.getPreferredCanvasFormat(),this.ctx.configure({device:e,format:this.format,alphaMode:"opaque"}),this.globals=new Float32Array(Ct.size),this.globalBuf=e.createBuffer({size:this.globals.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.matBuf=e.createBuffer({size:j*St*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.post=new Float32Array(12),this.postBuf=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.upBufs=[];const o=e.createShaderModule({code:be}),n=e.createShaderModule({code:ye}),r=e.createShaderModule({code:xe});this.logShaderErrors(o,"scene"),this.logShaderErrors(n,"depth"),this.logShaderErrors(r,"post");const u=GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT;this.layoutA=e.createBindGroupLayout({entries:[{binding:0,visibility:u,buffer:{type:"uniform"}},{binding:1,visibility:u,buffer:{type:"read-only-storage"}}]}),this.layoutB=e.createBindGroupLayout({entries:[{binding:0,visibility:u,buffer:{type:"uniform"}},{binding:1,visibility:u,buffer:{type:"read-only-storage"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"unfilterable-float"}},{binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{}},{binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{}},{binding:5,visibility:GPUShaderStage.FRAGMENT,sampler:{}},{binding:6,visibility:GPUShaderStage.FRAGMENT,texture:{}}]});const a=e.createPipelineLayout({bindGroupLayouts:[this.layoutA]}),c=e.createPipelineLayout({bindGroupLayouts:[this.layoutB]}),h=[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"}]}],f=[...h,{arrayStride:12,attributes:[{shaderLocation:2,offset:0,format:"float32x3"}]}];this.pipeArgs={sceneMod:o,depthMod:n,plA:a,plB:c,vbuf:h,vbufScene:f},this.quality=s.quality??2,Object.assign(this,this.scenePipelineDescs(this.quality,x=>e.createRenderPipeline(x)));const g=GPUShaderStage.FRAGMENT;this.postLayout=e.createBindGroupLayout({entries:[{binding:0,visibility:g,texture:{}},{binding:1,visibility:g,sampler:{}},{binding:2,visibility:g,buffer:{type:"uniform"}},{binding:3,visibility:g,texture:{}}]});const d=e.createPipelineLayout({bindGroupLayouts:[this.postLayout]}),p=(x,b,v)=>e.createRenderPipeline({layout:d,vertex:{module:r,entryPoint:"vs_full"},fragment:{module:r,entryPoint:x,targets:[{format:b,blend:v}]},primitive:{topology:"triangle-list"}}),l={color:{srcFactor:"one",dstFactor:"one",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one",operation:"add"}};this.prefilterPipe=p("fs_prefilter",O),this.downPipe=p("fs_down",O),this.upPipe=p("fs_up",O,l),this.compPipe=p("fs_composite",this.format),this.sampler=e.createSampler({magFilter:"linear",minFilter:"linear",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge"}),this.dummy=e.createTexture({size:[1,1],format:O,usage:GPUTextureUsage.TEXTURE_BINDING});const m=GPUTextureUsage.RENDER_ATTACHMENT,y=GPUTextureUsage.TEXTURE_BINDING;this.tintTex=e.createTexture({size:[ot,ot],format:O,usage:m|y}),this.occTex=e.createTexture({size:[ot,ot],format:O,usage:m|y}),this.width=0,this.height=0}scenePipelineDescs(t,e){const{sceneMod:s,depthMod:o,plA:n,plB:r,vbuf:u,vbufScene:a}=this.pipeArgs,c={QUALITY:t},h={color:{srcFactor:"dst",dstFactor:"zero",operation:"add"},alpha:{srcFactor:"one",dstFactor:"zero",operation:"add"}},f={color:{srcFactor:"one",dstFactor:"one",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one",operation:"add"}},g=d=>e({layout:r,vertex:{module:s,entryPoint:"vs_body",buffers:a},fragment:{module:s,entryPoint:d,targets:[{format:O}],constants:c},primitive:{topology:"triangle-list",cullMode:"back"},depthStencil:{format:"depth24plus",depthWriteEnabled:!0,depthCompare:"less"},multisample:{count:st}});return{lightPipe:e({layout:n,vertex:{module:o,entryPoint:"vs_light",buffers:u},fragment:{module:o,entryPoint:"fs_light",targets:[{format:O,blend:h},{format:O,blend:f}]},primitive:{topology:"triangle-list",cullMode:"back"}}),backPipe:e({layout:n,vertex:{module:o,entryPoint:"vs_body",buffers:u},fragment:{module:o,entryPoint:"fs_back",targets:[{format:"r32float"}]},primitive:{topology:"triangle-list",cullMode:"front"},depthStencil:{format:"depth24plus",depthWriteEnabled:!0,depthCompare:"less"}}),bgPipe:e({layout:r,vertex:{module:s,entryPoint:"vs_full"},fragment:{module:s,entryPoint:"fs_backdrop",targets:[{format:O}],constants:c},primitive:{topology:"triangle-list"},depthStencil:{format:"depth24plus",depthWriteEnabled:!1,depthCompare:"always"},multisample:{count:st}}),bodyPipe:g("fs_body"),clearPipe:g("fs_body_clear")}}async setQuality(t){if(t===this.quality)return;this.quality=t;const e=this.scenePipelineDescs(t,o=>this.device.createRenderPipelineAsync(o)),s=Object.fromEntries(await Promise.all(Object.entries(e).map(async([o,n])=>[o,await n])));this.quality===t&&Object.assign(this,s)}async logShaderErrors(t,e){const s=await t.getCompilationInfo();for(const o of s.messages)console[o.type==="error"?"error":"warn"](`[wgsl ${e}] ${o.lineNum}:${o.linePos} ${o.message}`)}setBodies(t){const e=this.device;this.bodies=t;const s=new Map;let o=0;for(const c of t)s.has(c.shapeName)||(s.set(c.shapeName,{first:o,count:c.indices.length,data:c.indices}),o+=c.indices.length);const n=new Uint32Array(o);for(const c of s.values())n.set(c.data,c.first);this.indexBuf?.destroy(),this.indexBuf=e.createBuffer({size:n.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST}),e.queue.writeBuffer(this.indexBuf,0,n);let r=0;this.draws=t.map(c=>{const h=s.get(c.shapeName),f={first:h.first,count:h.count,baseVertex:r};return r+=c.n,f});const u=new Float32Array(r*3);let a=0;for(const c of t)for(let h=0;h<c.n*3;h++)u[a++]=c.rest[h];this.restBuf?.destroy(),this.restBuf=e.createBuffer({size:u.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),e.queue.writeBuffer(this.restBuf,0,u),this.vdata=new Float32Array(r*6),this.vertexBuf?.destroy(),this.vertexBuf=e.createBuffer({size:this.vdata.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})}setMaterials(t,e){const s=new Float32Array(j*St);this.opaque=[],this.clear=[],t.forEach((o,n)=>{const[r,u,a]=o.material.slice(0,3).map(wt),c=we[o.material[3]||"gummy"];s.set([...r,0,...u,0,...a,0,c.rough,c.coat,c.clarity,c.sss,c.sheen,c.glitter,c.bump,c.irid],n*St);const h=Math.min(1,Math.max(c.clarity,c.sss*.8)),f=r.map((p,l)=>Math.min(1,(p*.7+u[l]*.3)*.75)),g=r.map(p=>p*.12+.08),d=r.map(p=>.55+p*.35);o.shadowTint=f.map((p,l)=>{const m=g[l]+(p-g[l])*h;return m+(d[l]-m)*c.clarity}),o.baseLinear=r,(c.clarity>0?this.clear:this.opaque).push(n)}),this.device.queue.writeBuffer(this.matBuf,0,s),this.palette=e}resize(t,e){if(t===this.width&&e===this.height)return;this.width=t,this.height=e;const s=this.device;for(const f of this.targets||[])f.destroy();const o=(f,g,d=1,p=[t,e])=>s.createTexture({size:p,format:f,usage:g,sampleCount:d}),n=GPUTextureUsage.RENDER_ATTACHMENT,r=GPUTextureUsage.TEXTURE_BINDING;this.backTex=o("r32float",n|r),this.backDepth=o("depth24plus",n),this.msaaColor=o(O,n,st),this.msaaDepth=o("depth24plus",n,st),this.hdr=o(O,n|r|GPUTextureUsage.COPY_SRC),this.sceneTex=s.createTexture({size:[t,e],format:O,mipLevelCount:kt,usage:n|r|GPUTextureUsage.COPY_DST}),this.bloom=[];let u=t,a=e;for(let f=0;f<Mt;f++)u=Math.max(1,u>>1),a=Math.max(1,a>>1),this.bloom.push(o(O,n|r,1,[u,a]));this.targets=[this.backTex,this.backDepth,this.msaaColor,this.msaaDepth,this.hdr,this.sceneTex,...this.bloom],this.bgA=s.createBindGroup({layout:this.layoutA,entries:[{binding:0,resource:{buffer:this.globalBuf}},{binding:1,resource:{buffer:this.matBuf}}]}),this.bgB=s.createBindGroup({layout:this.layoutB,entries:[{binding:0,resource:{buffer:this.globalBuf}},{binding:1,resource:{buffer:this.matBuf}},{binding:2,resource:this.backTex.createView()},{binding:3,resource:this.tintTex.createView()},{binding:4,resource:this.occTex.createView()},{binding:5,resource:this.sampler},{binding:6,resource:this.sceneTex.createView()}]});const c=(f,g,d=this.dummy)=>s.createBindGroup({layout:this.postLayout,entries:[{binding:0,resource:g.createView()},{binding:1,resource:this.sampler},{binding:2,resource:{buffer:this.postBuf}},{binding:3,resource:d.createView()}]});this.bgPrefilter=c(this.prefilterPipe,this.hdr),this.bgDown=this.bloom.map(f=>c(this.downPipe,f)),this.bgUp=this.bloom.map(f=>c(this.upPipe,f)),this.bgComp=c(this.compPipe,this.hdr,this.bloom[0]);const h=f=>this.sceneTex.createView({baseMipLevel:f,mipLevelCount:1});this.sceneMipViews=Array.from({length:kt},(f,g)=>h(g)),this.bgSceneDown=this.sceneMipViews.map(f=>s.createBindGroup({layout:this.postLayout,entries:[{binding:0,resource:f},{binding:1,resource:this.sampler},{binding:2,resource:{buffer:this.postBuf}},{binding:3,resource:this.dummy.createView()}]}))}render(t,e,s,o,n=null){const r=this.device,u=this.globals,a=this.palette,c=Ct;u.set(e.viewProj,c.viewProj),u.set(e.invViewProj,c.invViewProj),u.set(e.lightVP,c.lightVP),u.set([...e.pos,o],c.camPos),u.set([this.width,this.height,1/this.width,1/this.height],c.res),u.set([...e.keyDir,s.keyLight],c.keyDir),u.set([...Be([.5,.6,-.8]),s.rimLight],c.rimDir),u.set([...wt(a.bg[0]),e.backdropZ],c.bgTop),u.set([...wt(a.bg[1]),t.bodies.length],c.bgBot),u.set([s.sss,s.density,s.wrap,s.transmission],c.look0),u.set([s.refraction,s.ior,s.specular,s.roughness],c.look1),u.set([s.clearcoat,s.envIntensity,s.rimLight,s.shadow],c.look2),u.set([s.shadowSoftness,s.ao,e.backdropHalfH,e.lightSize],c.look3),u.set([s.bleed,s.debug,s.ambient,s.caustics],c.look4),u.set([s.glitter,s.bump,s.iridescence,s.frost],c.look5),t.bodies.forEach((l,m)=>{m>=j||(u.set([l.c[0],l.c[1],l.c[2],l.radiusEff],c.bodies+m*4),u.set([...l.shadowTint,0],c.bodyTint+m*4),u.set([...l.baseLinear,0],c.bodyBase+m*4))}),r.queue.writeBuffer(this.globalBuf,0,u);const h=this.post;h.set([s.bloomThreshold,s.bloom,s.exposure,s.tonemap,s.vignette,s.grain,s.chroma,o,1,0,0,0]),r.queue.writeBuffer(this.postBuf,0,h);const f=n??Oe(t.bodies,this.vdata);r.queue.writeBuffer(this.vertexBuf,0,f);const g=r.createCommandEncoder();{const l=g.beginRenderPass({colorAttachments:[{view:this.tintTex.createView(),clearValue:[1,1,1,1],loadOp:"clear",storeOp:"store"},{view:this.occTex.createView(),clearValue:[0,0,0,0],loadOp:"clear",storeOp:"store"}]});l.setPipeline(this.lightPipe),l.setBindGroup(0,this.bgA),this.drawBodies(l),l.end()}{const l=g.beginRenderPass({colorAttachments:[{view:this.backTex.createView(),clearValue:[0,0,0,0],loadOp:"clear",storeOp:"store"}],depthStencilAttachment:{view:this.backDepth.createView(),depthClearValue:1,depthLoadOp:"clear",depthStoreOp:"discard"}});l.setPipeline(this.backPipe),l.setBindGroup(0,this.bgA),this.drawBodies(l),l.end()}const d=this.clear.length>0;{const l=g.beginRenderPass({colorAttachments:[{view:this.msaaColor.createView(),resolveTarget:this.hdr.createView(),clearValue:[0,0,0,1],loadOp:"clear",storeOp:d?"store":"discard"}],depthStencilAttachment:{view:this.msaaDepth.createView(),depthClearValue:1,depthLoadOp:"clear",depthStoreOp:d?"store":"discard"}});l.setBindGroup(0,this.bgB),l.setPipeline(this.bgPipe),l.draw(3),l.setPipeline(this.bodyPipe),this.drawBodies(l,this.opaque,!0),l.end()}if(d){g.copyTextureToTexture({texture:this.hdr},{texture:this.sceneTex,mipLevel:0},[this.width,this.height]);for(let m=1;m<kt;m++){const y=g.beginRenderPass({colorAttachments:[{view:this.sceneMipViews[m],clearValue:[0,0,0,1],loadOp:"clear",storeOp:"store"}]});y.setPipeline(this.downPipe),y.setBindGroup(0,this.bgSceneDown[m-1]),y.draw(3),y.end()}const l=g.beginRenderPass({colorAttachments:[{view:this.msaaColor.createView(),resolveTarget:this.hdr.createView(),loadOp:"load",storeOp:"discard"}],depthStencilAttachment:{view:this.msaaDepth.createView(),depthLoadOp:"load",depthStoreOp:"discard"}});l.setBindGroup(0,this.bgB),l.setPipeline(this.clearPipe),this.drawBodies(l,this.clear,!0),l.end()}const p=(l,m,y,x="clear")=>{const b=g.beginRenderPass({colorAttachments:[{view:y.createView(),clearValue:[0,0,0,1],loadOp:x,storeOp:"store"}]});b.setPipeline(l),b.setBindGroup(0,m),b.draw(3),b.end()};p(this.prefilterPipe,this.bgPrefilter,this.bloom[0]);for(let l=1;l<Mt;l++)p(this.downPipe,this.bgDown[l-1],this.bloom[l]);for(let l=Mt-1;l>0;l--)p(this.upPipe,this.bgUp[l],this.bloom[l-1],"load");p(this.compPipe,this.bgComp,this.ctx.getCurrentTexture()),r.queue.submit([g.finish()])}drawBodies(t,e=null,s=!1){t.setVertexBuffer(0,this.vertexBuf),s&&t.setVertexBuffer(1,this.restBuf),t.setIndexBuffer(this.indexBuf,"uint32");for(const o of e??this.draws.keys()){const n=this.draws[o];t.drawIndexed(n.count,1,n.first,n.baseVertex,o)}}}function Be(i){const t=Math.hypot(...i);return i.map(e=>e/t)}const at={low:{meshDetail:.5,bodyCount:7,substeps:2,smoothIters:2,collisionIters:1,contactRadius:.4},medium:{meshDetail:.7,bodyCount:9,substeps:2,smoothIters:3,collisionIters:2,contactRadius:.3},high:{meshDetail:1,bodyCount:9,substeps:2,smoothIters:4,collisionIters:2,contactRadius:.22}},Tt=["low","medium","high"],Q=[{shader:2,mp:4.5},{shader:2,mp:3},{shader:1,mp:2.4},{shader:1,mp:1.6},{shader:0,mp:1.1},{shader:0,mp:.7}],Ft={high:0,medium:2,low:4},De=8.5,Ie=2.6;function Ee(i,t,e){const s=Tt.indexOf(i);return t>De&&s>0?Tt[s-1]:t<Ie&&s<2&&!e?Tt[s+1]:null}function Ne(i,t,e){const{mp:s}=Q[i],o=Math.min(window.devicePixelRatio||1,2);return Math.min(o,Math.sqrt(s*1e6/Math.max(t*e,1)))}class Ue{constructor(){this.intervals=[],this.period=1e3/60,this.since=performance.now()}reset(){this.intervals.length=0,this.since=performance.now()}frame(t){if(t>250||(this.intervals.push(t),this.intervals.length>120&&this.intervals.shift(),this.intervals.length<30))return!1;const e=[...this.intervals].sort((n,r)=>n-r),s=e[Math.floor(e.length*.1)];return this.period=[1e3/144,1e3/120,1e3/90,1e3/60,1e3/30].reduce((n,r)=>Math.abs(r-s)<Math.abs(n-s)?r:n),performance.now()-this.since<1500?!1:this.intervals.filter(n=>n>this.period*1.45).length/this.intervals.length>.15}}const ne=new URLSearchParams(location.search),re="softobjects.experience.quality",Xt=i=>at[i]?i:null;let tt=Xt(ne.get("q"))||Xt(localStorage.getItem(re));const Re=ne.has("debug"),_e=0,Qt=7,qe=1/60,k=document.getElementById("c"),C={};for(const i in Ht)C[i]=Ht[i][0];C.palette=_e;let D=tt||"medium";Object.assign(C,at[D]);const M={pos:[0,0,26],fov:28*Math.PI/180,keyDir:ae([-.42,.72,1]),zFront:2.5};function ae(i){const t=Math.hypot(...i);return i.map(e=>e/t)}function je(i,t){const e=new Array(16);for(let s=0;s<4;s++)for(let o=0;o<4;o++)e[s*4+o]=i[o]*t[s*4]+i[4+o]*t[s*4+1]+i[8+o]*t[s*4+2]+i[12+o]*t[s*4+3];return e}function Ce(i){const t=i,e=new Array(16);e[0]=t[5]*t[10]*t[15]-t[5]*t[11]*t[14]-t[9]*t[6]*t[15]+t[9]*t[7]*t[14]+t[13]*t[6]*t[11]-t[13]*t[7]*t[10],e[4]=-t[4]*t[10]*t[15]+t[4]*t[11]*t[14]+t[8]*t[6]*t[15]-t[8]*t[7]*t[14]-t[12]*t[6]*t[11]+t[12]*t[7]*t[10],e[8]=t[4]*t[9]*t[15]-t[4]*t[11]*t[13]-t[8]*t[5]*t[15]+t[8]*t[7]*t[13]+t[12]*t[5]*t[11]-t[12]*t[7]*t[9],e[12]=-t[4]*t[9]*t[14]+t[4]*t[10]*t[13]+t[8]*t[5]*t[14]-t[8]*t[6]*t[13]-t[12]*t[5]*t[10]+t[12]*t[6]*t[9],e[1]=-t[1]*t[10]*t[15]+t[1]*t[11]*t[14]+t[9]*t[2]*t[15]-t[9]*t[3]*t[14]-t[13]*t[2]*t[11]+t[13]*t[3]*t[10],e[5]=t[0]*t[10]*t[15]-t[0]*t[11]*t[14]-t[8]*t[2]*t[15]+t[8]*t[3]*t[14]+t[12]*t[2]*t[11]-t[12]*t[3]*t[10],e[9]=-t[0]*t[9]*t[15]+t[0]*t[11]*t[13]+t[8]*t[1]*t[15]-t[8]*t[3]*t[13]-t[12]*t[1]*t[11]+t[12]*t[3]*t[9],e[13]=t[0]*t[9]*t[14]-t[0]*t[10]*t[13]-t[8]*t[1]*t[14]+t[8]*t[2]*t[13]+t[12]*t[1]*t[10]-t[12]*t[2]*t[9],e[2]=t[1]*t[6]*t[15]-t[1]*t[7]*t[14]-t[5]*t[2]*t[15]+t[5]*t[3]*t[14]+t[13]*t[2]*t[7]-t[13]*t[3]*t[6],e[6]=-t[0]*t[6]*t[15]+t[0]*t[7]*t[14]+t[4]*t[2]*t[15]-t[4]*t[3]*t[14]-t[12]*t[2]*t[7]+t[12]*t[3]*t[6],e[10]=t[0]*t[5]*t[15]-t[0]*t[7]*t[13]-t[4]*t[1]*t[15]+t[4]*t[3]*t[13]+t[12]*t[1]*t[7]-t[12]*t[3]*t[5],e[14]=-t[0]*t[5]*t[14]+t[0]*t[6]*t[13]+t[4]*t[1]*t[14]-t[4]*t[2]*t[13]-t[12]*t[1]*t[6]+t[12]*t[2]*t[5],e[3]=-t[1]*t[6]*t[11]+t[1]*t[7]*t[10]+t[5]*t[2]*t[11]-t[5]*t[3]*t[10]-t[9]*t[2]*t[7]+t[9]*t[3]*t[6],e[7]=t[0]*t[6]*t[11]-t[0]*t[7]*t[10]-t[4]*t[2]*t[11]+t[4]*t[3]*t[10]+t[8]*t[2]*t[7]-t[8]*t[3]*t[6],e[11]=-t[0]*t[5]*t[11]+t[0]*t[7]*t[9]+t[4]*t[1]*t[11]-t[4]*t[3]*t[9]-t[8]*t[1]*t[7]+t[8]*t[3]*t[5],e[15]=t[0]*t[5]*t[10]-t[0]*t[6]*t[9]-t[4]*t[1]*t[10]+t[4]*t[2]*t[9]+t[8]*t[1]*t[6]-t[8]*t[2]*t[5];const s=t[0]*e[0]+t[1]*e[4]+t[2]*e[8]+t[3]*e[12];return e.map(o=>o/s)}function Bt(i,t){const e=i/t,s=1,o=100,n=1/Math.tan(M.fov/2),r=1/(s-o),u=[n/e,0,0,0,0,n,0,0,0,0,o*r,-1,0,0,o*s*r,0],a=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,-M.pos[2],1];M.viewProj=je(u,a),M.invViewProj=Ce(M.viewProj),M.aspect=e;const c=Math.tan(M.fov/2),h=M.pos[2],f=c*e,g=-M.zFront;M.backdropZ=g-.45,M.halfH=h*c,M.backdropHalfH=(h-M.backdropZ)*c;const d=M.keyDir,p=d.map(A=>-A),l=ae([-p[2],0,p[0]]),m=[l[1]*p[2]-l[2]*p[1],l[2]*p[0]-l[0]*p[2],l[0]*p[1]-l[1]*p[0]],y=(h-g)*f*1.1,x=(h-g)*c*1.1;let b=[1e9,1e9,1e9],v=[-1e9,-1e9,-1e9];for(const A of[-y,y])for(const L of[-x,x])for(const N of[g-1.5,M.zFront+1.5]){const H=[l[0]*A+l[1]*L+l[2]*N,m[0]*A+m[1]*L+m[2]*N,d[0]*A+d[1]*L+d[2]*N];for(let V=0;V<3;V++)b[V]=Math.min(b[V],H[V]),v[V]=Math.max(v[V],H[V])}const w=(b[0]+v[0])/2,P=(b[1]+v[1])/2,z=Math.max(v[0]-b[0],v[1]-b[1])/2,T=v[2]-b[2]+2,S=v[2]+1;M.lightVP=[l[0]/z,m[0]/z,-d[0]/T,0,l[1]/z,m[1]/z,-d[1]/T,0,l[2]/z,m[2]/z,-d[2]/T,0,-w/z,-P/z,S/T,1],M.lightSize=2*z;const G=(A,L,N,H)=>{const V=Math.hypot(A,L,N);return[A/V,L/V,N/V,H/V+.04]};M.planes=[G(0,-1,-c,-h*c),G(0,1,-c,-h*c),G(-1,0,-f,-h*f),G(1,0,-f,-h*f),[0,0,1,g],[0,0,-1,-M.zFront]],E.setBounds(M.planes),Y?.postMessage({type:"bounds",planes:M.planes})}function At(i,t){const e=i/k.clientWidth*2-1,s=1-t/k.clientHeight*2,o=M.invViewProj,n=o[3]*e+o[7]*s+o[11]+o[15],r=[0,1,2].map(a=>(o[a]*e+o[4+a]*s+o[8+a]+o[12+a])/n-M.pos[a]),u=Math.hypot(...r);return{o:[...M.pos],d:r.map(a=>a/u)}}const ce=(i,t)=>{const e=(t-i.o[2])/i.d[2];return[i.o[0]+i.d[0]*e,i.o[1]+i.d[1]*e,t]},E=new Ge(C);let K;const Y=new Worker(new URL(""+new URL("sim.worker-DnQSfNCw.js",import.meta.url).href,import.meta.url),{type:"module"}),B=[];let Lt=0,nt=20,it=40,ct=0,lt=0;Y.onmessage=({data:i})=>{if(i.type!=="snap"||i.gen!==Lt)return;B.push(i),ct=i.simMs,lt++;const t=performance.timeOrigin+performance.now()-i.wall;for(nt=Math.max(t,nt*.98+t*.02);B.length>6;){const e=B.shift();Y.postMessage({type:"recycle",gen:e.gen,verts:e.verts,centers:e.centers},[e.verts.buffer,e.centers.buffer])}};function Dt(){const i=Ve(C,Qt,M.halfH,M.aspect);E.bodies=i.bodies,M.zFront=i.zFront,Bt(k.width,k.height),K.setBodies(E.bodies),K.setMaterials(E.bodies,i.palette),Lt++,B.length=0,lt=0,nt=20,it=40,X.clear(),Y.postMessage({type:"reset",gen:Lt,params:{...C},seed:Qt,halfH:M.halfH,aspect:M.aspect,planes:M.planes})}function He(i){if(!B.length)return null;it+=Math.max(-.04,Math.min(.08,nt+qe*1e3+4-it));const t=performance.timeOrigin+i-it;let e=0;for(;e<B.length-1&&B[e+1].wall<=t;)e++;const s=B[e],o=B[Math.min(e+1,B.length-1)],n=o===s?0:Math.min(1,Math.max(0,(t-s.wall)/(o.wall-s.wall))),r=K.vdata,u=s.verts,a=o.verts;if(u.length!==r.length)return null;for(let c=0;c<r.length;c++)r[c]=u[c]+(a[c]-u[c])*n;return E.bodies.forEach((c,h)=>{for(let f=0;f<3;f++)c.c[f]=s.centers[h*3+f]+(o.centers[h*3+f]-s.centers[h*3+f])*n}),r}function le(){const i=B[B.length-1];i&&i.verts.length===K.vdata.length&&Fe(E.bodies,i.verts)}const X=new Map;k.addEventListener("pointerdown",i=>{k.setPointerCapture(i.pointerId);const t=At(i.offsetX,i.offsetY);le();const e=E.raycast(t.o,t.d);if(e){const s=E.bodies.indexOf(e.body);X.set(i.pointerId,{index:s,z:e.point[2]}),Y.postMessage({type:"grab",body:s,point:e.point}),k.style.cursor="grabbing"}else Y.postMessage({type:"impulse",point:ce(t,0),strength:9,radius:M.halfH*.9})});k.addEventListener("pointermove",i=>{const t=X.get(i.pointerId);if(t){const e=i.getCoalescedEvents?.().at(-1)??i;Y.postMessage({type:"target",body:t.index,target:ce(At(e.offsetX,e.offsetY),t.z)})}else if(i.pointerType==="mouse"&&!X.size){le();const e=At(i.offsetX,i.offsetY);k.style.cursor=E.raycast(e.o,e.d)?"grab":"default"}});const fe=i=>{const t=X.get(i.pointerId);t&&(X.delete(i.pointerId),[...X.values()].some(e=>e.index===t.index)||Y.postMessage({type:"release",body:t.index}),k.style.cursor="default")};k.addEventListener("pointerup",fe);k.addEventListener("pointercancel",fe);let q=Ft[D];function It(){const i=Ne(q,k.clientWidth,k.clientHeight),t=Math.max(1,Math.round(k.clientWidth*i)),e=Math.max(1,Math.round(k.clientHeight*i));t===k.width&&e===k.height||(k.width=t,k.height=e,Bt(t,e),K.resize(t,e))}function ft(i){q=Math.min(Math.max(i,0),Q.length-1),K.setQuality(Q[q].shader),It(),rt.reset()}const rt=new Ue,Zt=Re?Object.assign(document.body.appendChild(document.createElement("div")),{id:"debug"}):null;try{K=await Ot.create(k,{quality:Q[q].shader})}catch(i){throw document.body.classList.add("fallback"),document.querySelector(".stage")?.classList.add("fallback"),i}Bt(k.clientWidth,k.clientHeight);It();Dt();new ResizeObserver(It).observe(k);let Et=!1,Jt=!1;async function We(){if(!tt)for(let i=0;i<3;i++){await new Promise(e=>{const s=()=>lt>=50?e():setTimeout(s,50);s()});const t=Ee(D,ct,Jt);if(!t)break;Jt=!0,D=t,Object.assign(C,at[D]),ft(Ft[D]),Dt()}Et=!0,rt.reset(),k.classList.add("on"),he()}const Vt=document.getElementById("quality");function he(){for(const i of Vt.querySelectorAll("button"))i.classList.toggle("on",i.dataset.q===D);Vt.classList.add("ready")}Vt.addEventListener("click",async i=>{const t=i.target.dataset?.q;!t||t===D&&tt||(tt=t,localStorage.setItem(re,t),k.classList.add("quick"),k.classList.remove("on"),await new Promise(e=>setTimeout(e,260)),D=t,Object.assign(C,at[t]),ft(Ft[t]),Dt(),await new Promise(e=>{const s=()=>lt>=2?e():setTimeout(s,16);s()}),k.classList.add("on"),he())});We();let te=performance.now();function de(i){const t=i-te;te=i,Et&&!tt&&rt.frame(t)&&q<Q.length-1&&ft(q+1),K.render(E,M,C,i/1e3,He(i)),Zt&&(Zt.textContent=`physics ${D} · render L${q} (shader ${Q[q].shader}, ${k.width}×${k.height}) · sim ${ct.toFixed(1)}ms · refresh ${(1e3/rt.period).toFixed(0)}Hz · frame ${t.toFixed(1)}ms`),requestAnimationFrame(de)}requestAnimationFrame(de);window.__experience={get state(){return{physicsTier:D,level:q,simMs:ct,revealed:Et,size:[k.width,k.height]}},setLevel:ft};

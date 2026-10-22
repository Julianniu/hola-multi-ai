// 水银（WebGL）。整个界面只有两处用到：开会时几位大脑的交融（kind=meet），和主脑验收通过时流成的对勾（kind=check）。
// 原理：很多个小液团叠成一个"场"，场值过 1 的地方就是水银，所以轮廓不规则、会牵出液桥、会融合；
// 表面张力让顶面几乎是平的镜子，只有边缘是圆弧；镜面反射一个慢慢转动的摄影棚（柔光箱 + 红 / 蓝 / 绿三束光）。
// 只用一个隐藏的 WebGL 画布画所有水银，画完复制到页面上的普通画布里（浏览器同时能开的 WebGL 数量有限）。
// 动画只在状态刚发生时播一次，播完停在最后一帧；翻聊天记录、换深浅色、系统要求"减少动画"时直接画最后一帧。
// 页面里：<canvas class="merc" data-merc="meet|check" data-state="live|merge|split|pass" data-n="3" data-colors="#FF5A4E,#3D7BFF" data-key="消息id" data-ts="毫秒">
// 然后 Merc.scan(容器)。电脑不支持 WebGL 时：对勾画成一笔普通的勾，开会的水银不画（不报错）。
(function () {
  'use strict';
  const FRAG = (N) => `
precision highp float;
uniform vec2 uRes;uniform float uTime;uniform float uDark;uniform float uTint;uniform vec3 uB[${N}];uniform vec3 uC[${N}];
float fieldOnly(vec2 p){float f=0.0;for(int i=0;i<${N};i++){vec2 d=p-uB[i].xy;float r2=uB[i].z*uB[i].z;f+=r2/(dot(d,d)+0.06*r2+1e-7);}return f;}
float hgt(float f){return 0.068*sqrt(clamp(1.0-exp(-3.6*(f-1.0)),0.0,1.0));}
vec3 env(vec3 r){
  float a=sin(uTime*0.35)*0.35;r=vec3(r.x*cos(a)-r.z*sin(a),r.y,r.x*sin(a)+r.z*cos(a));
  float y=r.y;vec3 col;float box=exp(-pow(abs(r.x+0.08)/0.34,6.0)-pow(abs(y-0.24)/0.11,6.0));
  if(uDark>0.5){
    col=mix(vec3(0.010,0.012,0.018),vec3(0.30,0.32,0.38),smoothstep(-0.45,0.95,y));
    col+=vec3(1.05)*exp(-pow((r.x+0.42)/0.22,2.0)-pow((y-0.55)/0.26,2.0));
    col+=vec3(0.75,0.80,0.92)*exp(-pow((r.x-0.50)/0.16,2.0)-pow((y-0.40)/0.34,2.0));
    col+=vec3(0.55)*exp(-pow((y-0.92)/0.08,2.0));
    col*=1.0-0.70*exp(-pow((y+0.05)/0.10,2.0));
    col+=vec3(0.92,0.94,1.0)*0.95*box;
  } else {
    col=mix(vec3(0.20,0.22,0.26),vec3(1.0),smoothstep(-0.50,0.70,y));
    col*=1.0-0.62*exp(-pow((y-0.16)/0.16,2.0));
    col*=1.0-0.55*exp(-pow((r.x-0.55)/0.12,2.0)-pow((y-0.45)/0.35,2.0));
    col*=1.0-0.30*exp(-pow((r.x+0.62)/0.18,2.0));
    col+=vec3(0.25)*exp(-pow((r.x+0.30)/0.18,2.0)-pow((y-0.62)/0.20,2.0));
    col=mix(col,vec3(1.0),0.85*box);
  }
  col+=vec3(1.0,0.34,0.28)*0.85*pow(max(dot(r,normalize(vec3(-0.70,0.55,0.45))),0.0),26.0);
  col+=vec3(0.22,0.46,1.0)*0.80*pow(max(dot(r,normalize(vec3(-0.40,-0.70,0.60))),0.0),22.0);
  col+=vec3(0.12,0.85,0.58)*0.80*pow(max(dot(r,normalize(vec3(0.75,-0.30,0.60))),0.0),24.0);
  return col;
}
void main(){
  vec2 p=(gl_FragCoord.xy-0.5*uRes)/uRes.y;
  float f=0.0;vec3 tint=vec3(0.0);
  for(int i=0;i<${N};i++){vec2 d=p-uB[i].xy;float r2=uB[i].z*uB[i].z;float c=r2/(dot(d,d)+0.06*r2+1e-7);f+=c;tint+=c*uC[i];}
  float fs=fieldOnly(p+vec2(0.0,0.022));float sa=smoothstep(0.55,1.0,fs)*(uDark>0.5?0.40:0.16);
  if(f<0.9){gl_FragColor=vec4(0.0,0.0,0.0,sa);return;}
  tint/=f;
  float e=1.0/uRes.y;
  float gx=(hgt(fieldOnly(p+vec2(e,0.0)))-hgt(fieldOnly(p-vec2(e,0.0))))/(2.0*e);
  float gy=(hgt(fieldOnly(p+vec2(0.0,e)))-hgt(fieldOnly(p-vec2(0.0,e))))/(2.0*e);
  vec3 n=normalize(vec3(-gx,-gy,1.0));
  vec3 r=reflect(normalize(vec3(p*0.55,-1.0)),n);
  vec3 c=env(normalize(vec3(r.x,r.y+0.12,abs(r.z))));
  float fr=pow(1.0-n.z,3.0);
  if(uDark>0.5){c=mix(c,env(normalize(vec3(r.x,r.y+0.6,0.25)))*1.15,fr*0.55);}else{c=mix(c,c*0.42,fr*0.85);}
  vec3 L=normalize(vec3(-0.45,0.65,0.62));
  c+=vec3(1.0)*pow(max(dot(reflect(-L,n),vec3(0.0,0.0,1.0)),0.0),140.0)*1.6;
  c=mix(c,c*(0.6+tint*0.7),uTint*0.22);
  c=c/(1.0+c*0.10);
  float a=smoothstep(0.96,1.04,f);
  gl_FragColor=vec4(c*a,a+sa*(1.0-a));
}`;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const spring = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.exp(-6 * t) * Math.cos(10 * t));
  const rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return [0.8, 0.82, 0.86]; const v = parseInt(m[1], 16); return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; };

  // 开会：每位大脑一滴，带着自己的颜色；k = 靠近的程度（0 各自，1 融成一滩），m = 融合后收紧，shiver = 没谈拢时的轻颤
  function meetBlobs(t, n, k, m, shiver, colors) {
    const base = n === 2 ? [[-0.2, 0.02], [0.2, -0.02]] : [[0, 0.2], [-0.23, -0.13], [0.23, -0.13]];
    const out = [];
    base.forEach(([x, y], i) => {
      const bob = 1 - k;
      const cx = x * (1 - 0.78 * k) + Math.sin(t * 1.3 + i * 2.1) * 0.012 * bob + Math.sin(t * 23 + i) * shiver;
      const cy = y * (1 - 0.78 * k) + Math.cos(t * 1.1 + i * 1.7) * 0.016 * bob;
      const R = [0.060, 0.047, 0.040, 0.020];
      for (let j = 0; j < 4; j++) {
        const ph = i * 2.4 + j * 2.1, sp = 0.55 + 0.27 * j + 0.15 * i;
        const orbit = (j === 3 ? 0.085 + 0.03 * Math.sin(t * 0.9 + ph) : 0.034 + 0.016 * Math.sin(t * 0.7 + ph)) * (1 - 0.12 * k);
        out.push({ p: [cx + Math.cos(t * sp + ph) * orbit * 1.25, cy + Math.sin(t * sp * 1.17 + ph) * orbit * 0.85, (R[j] + 0.007 * Math.sin(t * 1.4 + ph)) * m * (j === 3 ? 1 : 1.05)], c: rgb(colors[i]) });
      }
    });
    return out;
  }
  // 验收通过：一滴水银落下，顺着笔画流成一个对勾
  const CHECK = [[-0.23, 0.0], [-0.075, -0.15], [0.235, 0.17]];
  function checkPoint(u) {
    const [a, b, c] = CHECK, l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]), s = u * (l1 + l2);
    if (s <= l1) return [a[0] + (b[0] - a[0]) * s / l1, a[1] + (b[1] - a[1]) * s / l1];
    const v = (s - l1) / l2;
    return [b[0] + (c[0] - b[0]) * v, b[1] + (c[1] - b[1]) * v];
  }
  function checkBlobs(t, N, color) {
    const out = [], grow = spring(clamp(t / 0.55)), col = rgb(color);
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const home = [Math.cos(t * 1.7 + i * 1.3) * 0.022, -0.02 + Math.sin(t * 1.4 + i * 2.2) * 0.022];
      const go = spring(clamp((t - 0.5 - 0.6 * u) / 0.75));
      const q = checkPoint(u), wave = Math.sin(t * 3.2 - u * 9) * 0.004 * go;
      out.push({ p: [home[0] + (q[0] - home[0]) * go - wave * 0.7, home[1] + (q[1] - home[1]) * go + wave, (0.0178 + 0.0018 * Math.sin(t * 2.1 + i * 0.7)) * grow], c: col });
    }
    return out;
  }

  // ---------- 共用的 WebGL
  let glc = null, gl = null, progs = {}, broken = false;
  function program(N) {
    if (progs[N]) return progs[N];
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader'); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}'));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG(N)));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link');
    const U = (n) => gl.getUniformLocation(p, n);
    progs[N] = { p, a: gl.getAttribLocation(p, 'a'), res: U('uRes'), time: U('uTime'), dark: U('uDark'), tint: U('uTint'), b: U('uB'), c: U('uC'), B: new Float32Array(N * 3), C: new Float32Array(N * 3) };
    return progs[N];
  }
  function ready() {
    if (broken) return false;
    if (gl) return true;
    try {
      glc = document.createElement('canvas');
      gl = glc.getContext('webgl', { premultipliedAlpha: true, antialias: true, alpha: true, preserveDrawingBuffer: true });
      if (!gl) throw new Error('no webgl');
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      glc.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; progs = {}; });
      return true;
    } catch (_) { broken = true; gl = null; return false; }
  }
  const isDark = () => getComputedStyle(document.documentElement).getPropertyValue('--blend').trim() === 'screen';

  function paint(el, list, N, t, tint, scale) {
    const w = el.width, h = el.height, ctx = el.getContext('2d');
    if (!ctx || !w || !h) return;
    if (!ready()) return fallback(el);
    try {
      const pr = program(N);
      if (glc.width !== w || glc.height !== h) { glc.width = w; glc.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pr.p);
      gl.enableVertexAttribArray(pr.a); gl.vertexAttribPointer(pr.a, 2, gl.FLOAT, false, 0, 0);
      for (let i = 0; i < N; i++) {
        const b = list[i] || { p: [9, 9, 0], c: [0, 0, 0] };
        pr.B.set([b.p[0] * scale, b.p[1] * scale, b.p[2] * scale], i * 3); pr.C.set(b.c, i * 3);
      }
      gl.uniform2f(pr.res, w, h); gl.uniform1f(pr.time, t); gl.uniform1f(pr.dark, isDark() ? 1 : 0); gl.uniform1f(pr.tint, tint);
      gl.uniform3fv(pr.b, pr.B); gl.uniform3fv(pr.c, pr.C);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(glc, 0, 0);
    } catch (_) { broken = true; fallback(el); }
  }
  function fallback(el) {
    const ctx = el.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, el.width, el.height);
    if (el.dataset.merc !== 'check') return;
    const s = Math.min(el.width, el.height);
    ctx.strokeStyle = getComputedStyle(el).color || '#0F9F6E'; ctx.lineWidth = s * 0.1; ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(el.width / 2 - s * 0.3, el.height / 2); ctx.lineTo(el.width / 2 - s * 0.1, el.height / 2 + s * 0.2); ctx.lineTo(el.width / 2 + s * 0.32, el.height / 2 - s * 0.22); ctx.stroke();
  }

  // ---------- 每个画布的状态：e = 状态发生后过了几秒（播完就停在 END）
  const END = { merge: 2.4, split: 2.0, pass: 2.4 };
  const seed = (k) => { let h = 7; for (const ch of String(k || '')) h = (h * 31 + ch.charCodeAt(0)) % 997; return h / 997; };
  function frame(el, now) {
    const d = el.dataset, kind = d.merc, st = d.state || 'pass';
    // 画布实际大小 × 屏幕缩放
    const dpr = Math.min(window.devicePixelRatio || 1, 2), cw = Math.round(el.clientWidth * dpr), ch = Math.round(el.clientHeight * dpr);
    if (!cw || !ch) return;
    if (el.width !== cw || el.height !== ch) { el.width = cw; el.height = ch; }
    const e = st === 'live' ? 0 : Math.min((now - el._start) / 1000, END[st] || 2.4);
    if (kind === 'check') return paint(el, checkBlobs(e, 30, d.colors || '#22D39A'), 30, 3 + e, 1.4, 1.7);
    const n = +d.n === 2 ? 2 : 3, colors = String(d.colors || '').split(','), scale = n === 2 ? 2.2 : 1.8;
    const flow = st === 'live' ? now / 1000 : 3 + seed(d.key) * 20 + e;
    let k = 0.18, m = 1, tint = 1, shiver = 0;
    if (st === 'live') k = 0.18 + 0.05 * Math.sin(now / 2000);
    else if (st === 'merge') { k = 0.18 + 0.82 * ease(clamp(e / 1.2)); m = 1 - 0.30 * spring(clamp((e - 0.9) / 1.0)); tint = 1 - ease(clamp(e / 1.5)); }
    else if (st === 'split') { k = 0.18 + 0.06 * ease(clamp(e / 1.0)); shiver = e > 0.6 && e < 1.9 ? 0.006 * (1 - (e - 0.6) / 1.3) : 0; }
    paint(el, meetBlobs(flow, n, k, m, shiver, colors), 12, flow, tint, scale);
  }

  const live = new Set(), played = new Map();
  let raf = 0;
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function loop(now) {
    raf = 0;
    for (const el of [...live]) {
      if (!el.isConnected) { live.delete(el); continue; }
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue; // 不在屏幕上就先不画
      frame(el, now);
      const st = el.dataset.state;
      if (st !== 'live' && (now - el._start) / 1000 >= (END[st] || 2.4)) live.delete(el);
    }
    if (live.size) raf = requestAnimationFrame(loop);
  }
  function bind(el) {
    if (el._merc) return;
    el._merc = true;
    const d = el.dataset, st = d.state || 'pass', key = (d.key || '') + ':' + st, now = performance.now();
    const ts = +d.ts || 0, fresh = ts && Date.now() - ts < 15000;
    if (st === 'live' && !reduce()) { el._start = now; live.add(el); }
    else if (played.has(key)) { el._start = played.get(key); if ((now - el._start) / 1000 < (END[st] || 2.4)) live.add(el); }
    else if (fresh && !reduce()) { el._start = now; played.set(key, now); live.add(el); }
    else { el._start = now - 1e6; played.set(key, el._start); }
    requestAnimationFrame((t) => frame(el, t));
    if (live.size && !raf) raf = requestAnimationFrame(loop);
  }
  window.Merc = {
    scan(root) { try { (root || document).querySelectorAll('canvas.merc').forEach(bind); } catch (_) {} },
    // 换深浅色后：把停在最后一帧的都按新颜色重画一遍
    redraw() { try { const now = performance.now(); document.querySelectorAll('canvas.merc').forEach((el) => { if (el._merc) frame(el, now); }); } catch (_) {} },
  };
})();

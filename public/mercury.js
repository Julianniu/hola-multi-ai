// 水银（WebGL）· V3「银白水银 + 层叠玻璃」
// 规矩：水银只在"有事发生"时动。一直活着的只有顶栏的队友水银（Merc.lights，平时很慢地呼吸）；
// 其他都是平时静止、碰到才动：水银按钮（Merc.button：鼠标移上去鼓一下、按下去压扁、忙的时候里面流动）、
// 开关里的水银珠（Merc.bead 画一张静止的图给 CSS 用）、更新进度条（Merc.bar：只在检查 / 下载时流）、
// 验收通过的对勾（canvas.merc data-merc="check"，播一次停在最后一帧）。背景的液态银（Merc.wall）只画一次。
// 原理：很多个小液团叠成一个"场"，场值过 1 的地方就是水银，所以轮廓不规则、会牵出液桥、会融合；
// 镜面反射一个单色的摄影棚（柔光箱 + 两束白光），红绿蓝三个通道错开一点点，边缘有金属的色散。
// 只用一个隐藏的 WebGL 画布画所有水银，画完复制到页面上的普通画布里（浏览器同时能开的 WebGL 数量有限）。
// 电脑不支持 WebGL 时：对勾画成一笔普通的勾，顶栏画几个灰色圆点，按钮和开关用 CSS 自己的银色渐变（不报错）。
(function () {
  'use strict';
  const ENV = `
vec3 env(vec3 r){
  float a=sin(uTime*0.3)*0.35;r=vec3(r.x*cos(a)-r.z*sin(a),r.y,r.x*sin(a)+r.z*cos(a));
  float y=r.y;vec3 col;float box=exp(-pow(abs(r.x+0.08)/0.34,6.0)-pow(abs(y-0.24)/0.11,6.0));
  if(uDark>0.5){
    col=mix(vec3(0.012),vec3(0.31,0.32,0.34),smoothstep(-0.45,0.95,y));
    col+=vec3(1.0)*exp(-pow((r.x+0.42)/0.22,2.0)-pow((y-0.55)/0.26,2.0));
    col+=vec3(0.78)*exp(-pow((r.x-0.50)/0.16,2.0)-pow((y-0.40)/0.34,2.0));
    col*=1.0-0.70*exp(-pow((y+0.05)/0.10,2.0));
    col+=vec3(0.95)*0.95*box;
  } else {
    col=mix(vec3(0.21,0.22,0.24),vec3(1.0),smoothstep(-0.50,0.70,y));
    col*=1.0-0.62*exp(-pow((y-0.16)/0.16,2.0));
    col*=1.0-0.50*exp(-pow((r.x-0.55)/0.12,2.0)-pow((y-0.45)/0.35,2.0));
    col+=vec3(0.25)*exp(-pow((r.x+0.30)/0.18,2.0)-pow((y-0.62)/0.20,2.0));
    col=mix(col,vec3(1.0),0.85*box);
  }
  col+=vec3(1.0)*0.5*pow(max(dot(r,normalize(vec3(-0.70,0.55,0.45))),0.0),30.0);
  return col;
}`;
  // uS = 整体放大倍数（高度跟着放大，所以大水珠和顶栏的小水珠质感一样）；uLift = 反射往上抬多少（越大越亮）
  const FRAG = (N) => `
precision highp float;
uniform vec2 uRes;uniform float uTime;uniform float uDark;uniform float uPersp;uniform float uLift;uniform float uS;uniform vec3 uB[${N}];
float fo(vec2 p){float f=0.0;for(int i=0;i<${N};i++){vec2 d=p-uB[i].xy;float r2=uB[i].z*uB[i].z;f+=r2/(dot(d,d)+0.06*r2+1e-7);}return f;}
float hg(float f){return 0.068*uS*sqrt(clamp(1.0-exp(-3.6*(f-1.0)),0.0,1.0));}
${ENV}
void main(){
  vec2 p=(gl_FragCoord.xy-0.5*uRes)/uRes.y;
  float f=fo(p);float fs=fo(p+vec2(0.0,0.03));float sa=smoothstep(0.55,1.0,fs)*(uDark>0.5?0.45:0.22);
  if(f<0.9){gl_FragColor=vec4(0.0,0.0,0.0,sa);return;}
  float e=1.0/uRes.y;
  float gx=(hg(fo(p+vec2(e,0.0)))-hg(fo(p-vec2(e,0.0))))/(2.0*e);
  float gy=(hg(fo(p+vec2(0.0,e)))-hg(fo(p-vec2(0.0,e))))/(2.0*e);
  vec3 n=normalize(vec3(-gx,-gy,1.0));
  vec3 r=reflect(normalize(vec3(p*uPersp,-1.0)),n);
  vec3 c=vec3(env(normalize(vec3(r.x+0.006,r.y+uLift,abs(r.z)))).r,env(normalize(vec3(r.x,r.y+uLift,abs(r.z)))).g,env(normalize(vec3(r.x-0.006,r.y+uLift,abs(r.z)))).b);
  float fr=pow(1.0-n.z,3.0);
  if(uDark>0.5){c=mix(c,env(normalize(vec3(r.x,r.y+0.6,0.25)))*1.15,fr*0.55);}else{c=mix(c,c*0.42,fr*0.85);}
  vec3 L=normalize(vec3(-0.45,0.65,0.62));
  c+=vec3(1.0)*pow(max(dot(reflect(-L,n),vec3(0.0,0.0,1.0)),0.0),140.0)*1.6;
  c=c/(1.0+c*0.10);
  float a=smoothstep(0.96,1.04,f);
  gl_FragColor=vec4(c*a,a+sa*(1.0-a));
}`;
  // 背景：一整片起伏的液态银（只画一次，定格）
  const WALL = `
precision highp float;uniform vec2 uRes;uniform float uDark;
float hs(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float ns(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hs(i),hs(i+vec2(1.0,0.0)),f.x),mix(hs(i+vec2(0.0,1.0)),hs(i+vec2(1.0,1.0)),f.x),f.y);}
float fb(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*ns(p);p=p*2.03+vec2(1.7,9.2);a*=0.5;}return v;}
float H(vec2 p){vec2 q=vec2(fb(p+0.06),fb(p+vec2(5.2,1.3)-0.045));return fb(p*0.9+1.8*q);}
void main(){
  vec2 p=gl_FragCoord.xy/uRes.y*1.05;float e=0.006;float h=H(p);
  vec3 n=normalize(vec3((h-H(p+vec2(e,0.0)))/e*0.065,(h-H(p+vec2(0.0,e)))/e*0.065,1.0));
  vec3 r=reflect(vec3(0.0,0.0,-1.0),n);float y=r.y;vec3 c;
  if(uDark>0.5){c=mix(vec3(0.045,0.047,0.052),vec3(0.20,0.205,0.215),smoothstep(-0.35,0.55,y));c+=vec3(0.34)*exp(-pow((r.x+0.25)/0.22,2.0)-pow((y-0.30)/0.18,2.0));}
  else{c=mix(vec3(0.70,0.71,0.73),vec3(0.955,0.957,0.962),smoothstep(-0.35,0.55,y));c+=vec3(0.10)*exp(-pow((r.x+0.25)/0.22,2.0)-pow((y-0.30)/0.18,2.0));c*=1.0-0.10*exp(-pow((y+0.10)/0.12,2.0));}
  gl_FragColor=vec4(c,1.0);
}`;
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const spring = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.exp(-6 * t) * Math.cos(10 * t));
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dprOf = () => Math.min(window.devicePixelRatio || 1, 2);
  const OFF = [-9, 0, 0];

  // ---------- 共用的 WebGL
  let glc = null, gl = null, progs = {}, wallProg = null, broken = false;
  function compile(fs) {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader'); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}'));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link');
    const cache = {};
    return { p, a: gl.getAttribLocation(p, 'a'), U: (n) => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(p, n))) };
  }
  function program(N) { return progs[N] || (progs[N] = Object.assign(compile(FRAG(N)), { B: new Float32Array(N * 3) })); }
  function ready() {
    if (broken) return false;
    if (gl) return true;
    try {
      glc = document.createElement('canvas');
      gl = glc.getContext('webgl', { premultipliedAlpha: true, antialias: true, alpha: true, preserveDrawingBuffer: true });
      if (!gl) throw new Error('no webgl');
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      glc.addEventListener('webglcontextlost', (e) => { e.preventDefault(); gl = null; progs = {}; wallProg = null; });
      return true;
    } catch (_) { broken = true; gl = null; return false; }
  }
  const isDark = () => getComputedStyle(document.documentElement).getPropertyValue('--blend').trim() === 'screen';
  function use(pr, w, h) {
    if (glc.width !== w || glc.height !== h) { glc.width = w; glc.height = h; }
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(pr.p); gl.enableVertexAttribArray(pr.a); gl.vertexAttribPointer(pr.a, 2, gl.FLOAT, false, 0, 0);
  }
  // 把一组液团画进 el（普通 2D 画布）。list 里每项是 [x, y, 半径]，单位是画布高度
  function paint(el, list, o) {
    const w = el.width, h = el.height, ctx = el.getContext('2d');
    if (!ctx || !w || !h) return false;
    if (!ready()) return false;
    try {
      const pr = program(list.length);
      use(pr, w, h);
      list.forEach((b, i) => pr.B.set(b, i * 3));
      gl.uniform2f(pr.U('uRes'), w, h); gl.uniform1f(pr.U('uTime'), o.time == null ? 1.2 : o.time); gl.uniform1f(pr.U('uDark'), isDark() ? 1 : 0);
      gl.uniform1f(pr.U('uPersp'), o.persp == null ? 0.35 : o.persp); gl.uniform1f(pr.U('uLift'), o.lift == null ? (isDark() ? 0.22 : 0.30) : o.lift); gl.uniform1f(pr.U('uS'), o.s || 1);
      gl.uniform3fv(pr.U('uB'), pr.B);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(glc, 0, 0);
      return true;
    } catch (_) { broken = true; return false; }
  }
  // 画布像素大小跟着它在页面上的大小 × 屏幕缩放
  function fit(el) {
    const d = dprOf(), cw = Math.round(el.clientWidth * d), ch = Math.round(el.clientHeight * d);
    if (!cw || !ch) return false;
    if (el.width !== cw || el.height !== ch) { el.width = cw; el.height = ch; }
    return true;
  }

  // ---------- 一颗水珠（顶栏每位队友、水银按钮都是它）：一大三小在里面流，整体放大 s 倍
  const SUB = [[0.072, 0, 0], [0.056, 0.62, 1.7], [0.048, 0.8, 3.4], [0.026, 1.25, 5.1]];
  function drop(t, cx, cy, ang, s, amp, size) {
    return SUB.map(([r, orbit, ph], j) => {
      const o = orbit * 0.045 * amp, u = Math.cos(t * (0.5 + 0.2 * j) + ph) * o, v = Math.sin(t * (0.6 + 0.2 * j) + ph) * o * 0.8;
      return [(cx + u * Math.cos(ang) - v * Math.sin(ang)) * s, (cy + u * Math.sin(ang) + v * Math.cos(ang)) * s - 0.012 * s, r * size * s];
    });
  }

  // ---------- 验收通过：一滴水银落下，顺着笔画流成一个对勾（播一次，停在最后一帧）
  const CHECK = [[-0.23, 0.0], [-0.075, -0.15], [0.235, 0.17]];
  function checkPoint(u) {
    const [a, b, c] = CHECK, l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]), s = u * (l1 + l2);
    if (s <= l1) return [a[0] + (b[0] - a[0]) * s / l1, a[1] + (b[1] - a[1]) * s / l1];
    const v = (s - l1) / l2;
    return [b[0] + (c[0] - b[0]) * v, b[1] + (c[1] - b[1]) * v];
  }
  function checkBlobs(t, N) {
    const out = [], grow = spring(clamp(t / 0.55)), S = 1.7;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const home = [Math.cos(t * 1.7 + i * 1.3) * 0.022, -0.02 + Math.sin(t * 1.4 + i * 2.2) * 0.022];
      const go = spring(clamp((t - 0.5 - 0.6 * u) / 0.75));
      const q = checkPoint(u), wave = Math.sin(t * 3.2 - u * 9) * 0.004 * go;
      out.push([(home[0] + (q[0] - home[0]) * go - wave * 0.7) * S, (home[1] + (q[1] - home[1]) * go + wave) * S, (0.0178 + 0.0018 * Math.sin(t * 2.1 + i * 0.7)) * grow * S]);
    }
    return out;
  }
  function fallbackCheck(el) {
    const ctx = el.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, el.width, el.height);
    const s = Math.min(el.width, el.height);
    ctx.strokeStyle = getComputedStyle(el).color || '#5A5F68'; ctx.lineWidth = s * 0.1; ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(el.width / 2 - s * 0.3, el.height / 2); ctx.lineTo(el.width / 2 - s * 0.1, el.height / 2 + s * 0.2); ctx.lineTo(el.width / 2 + s * 0.32, el.height / 2 - s * 0.22); ctx.stroke();
  }
  const END = 2.4;
  function frame(el, now) {
    if (!fit(el)) return;
    const e = Math.min((now - el._start) / 1000, END);
    if (!paint(el, checkBlobs(e, 30), { time: 1.2, persp: 0.55, lift: 0.12 })) fallbackCheck(el);
  }
  const live = new Set(), played = new Map();
  let raf = 0;
  function loop(now) {
    raf = 0;
    for (const el of [...live]) {
      if (!el.isConnected) { live.delete(el); continue; }
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue; // 不在屏幕上就先不画
      frame(el, now);
      if ((now - el._start) / 1000 >= END) live.delete(el);
    }
    if (live.size) raf = requestAnimationFrame(loop);
  }
  function bind(el) {
    if (el._merc) return;
    el._merc = true;
    const d = el.dataset, key = (d.key || '') + ':' + (d.state || 'pass'), now = performance.now();
    const ts = +d.ts || 0, fresh = ts && Date.now() - ts < 15000;
    if (played.has(key)) { el._start = played.get(key); if ((now - el._start) / 1000 < END) live.add(el); }
    else if (fresh && !reduce()) { el._start = now; played.set(key, now); live.add(el); }
    else { el._start = now - 1e6; played.set(key, el._start); }
    requestAnimationFrame((t) => frame(el, t));
    if (live.size && !raf) raf = requestAnimationFrame(loop);
  }

  // ---------- 顶栏的队友水银：每位队友一颗，严格摆在正多边形的顶点上（2 = 左右、3 = 正三角形、4 = 正方形……），中心对称；
  // 每颗里面的流动都一样，只是按自己的角度转过去，所以任何时刻整体都是中心对称的。
  // 三种状态：idle = 各自分开、很慢地呼吸；meet = 开会中，参会的几颗融在一起又分开、反复；merge = 得出结论，融成一滩。
  // 不在线的那颗缩小；不参会的（帮手、这次没选上的）开会时待在原地。
  function lights(el) {
    let drops = [], mode = 'idle', last = 0, raf = 0, clock = 0;
    const t0 = performance.now();
    const shape = (n) => {
      if (n <= 1) return { ang: [Math.PI / 2], rad: 0, ds: 1.15 };
      if (n === 2) return { ang: [Math.PI, 0], rad: 0.22, ds: 1 };
      return { ang: Array.from({ length: n }, (_, i) => Math.PI / 2 + (2 * Math.PI * i) / n + (n === 4 ? Math.PI / 4 : 0)), rad: n === 3 ? 0.2 : n === 4 ? 0.235 : 0.27, ds: n === 3 ? 1 : n === 4 ? 0.74 : 0.6 };
    };
    function tick(now) {
      raf = 0;
      if (!el.isConnected) return;
      const idle = mode === 'idle' && drops.every((d) => d.k < 0.002);
      // 平时一秒画 15 次就够了（动得很慢）；开会、合并时 30 次
      if (!document.hidden && now - last > (idle ? 66 : 33)) {
        const dt = Math.min(0.1, (now - (last || now)) / 1000); last = now;
        clock += dt * (reduce() ? 0 : mode === 'idle' ? 0.35 : 1);
        const t = (now - t0) / 1000, cyc = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 4.2);
        for (const d of drops) {
          const target = !d.join || mode === 'idle' ? 0 : mode === 'merge' ? 1 : cyc;
          d.k += (target - d.k) * (1 - Math.exp(-dt * (mode === 'meet' ? 6 : 2.4)));
        }
        draw();
      }
      raf = requestAnimationFrame(tick);
    }
    function draw() {
      if (!drops.length || !fit(el)) return;
      const { ang, rad, ds } = shape(drops.length), out = [], t = clock;
      const breathe = 1 + 0.035 * Math.sin(t * 1.6);
      drops.forEach((d, i) => {
        const a = ang[i], k = d.k, cx = Math.cos(a) * rad * (1 - 0.95 * k), cy = Math.sin(a) * rad * (1 - 0.95 * k);
        const shrink = 1 - 0.2 * Math.max(0, (k - 0.75) / 0.25);
        out.push(...drop(t, cx, cy, a, 1.42, (1 - 0.4 * k) * (mode === 'idle' ? 0.7 : 1), ds * breathe * shrink * (d.on ? 1 : 0.6)));
      });
      if (!paint(el, out, { time: 1.2, persp: 0.35 })) fallbackLights();
    }
    // 没有 WebGL：画几个普通的灰色圆点
    function fallbackLights() {
      const ctx = el.getContext('2d'); if (!ctx) return;
      const { ang, rad } = shape(drops.length), w = el.width, h = el.height;
      ctx.clearRect(0, 0, w, h);
      drops.forEach((d, i) => {
        const k = d.k, x = w / 2 + Math.cos(ang[i]) * rad * (1 - 0.9 * k) * h * 1.42, y = h / 2 - Math.sin(ang[i]) * rad * (1 - 0.9 * k) * h * 1.42;
        ctx.globalAlpha = d.on ? 0.9 : 0.35; ctx.fillStyle = '#9AA0A9'; ctx.beginPath(); ctx.arc(x, y, h * 0.13, 0, Math.PI * 2); ctx.fill();
      });
      ctx.globalAlpha = 1;
    }
    return {
      // list: [{ id, on, join }]；mode: idle / meet / merge
      set(list, m) {
        const old = new Map(drops.map((d) => [d.id, d]));
        drops = list.map((x) => Object.assign(old.get(x.id) || { k: 0 }, x));
        mode = m || 'idle';
        if (!raf) raf = requestAnimationFrame(tick);
      },
      redraw() { draw(); },
    };
  }

  // ---------- 水银按钮：<button class="mb"><canvas class="mbc"></canvas><svg …/></button>，然后 Merc.button(按钮)
  // 平时是一颗静止的水珠；鼠标移上去鼓一点，按下去压扁再弹回；busy(true) 时里面的水银流动（比如正在检查更新）
  const buttons = new Set();
  let btnRaf = 0;
  function button(btn) {
    if (!btn || btn._mb) return btn && btn._mb;
    let cv = btn.querySelector('canvas.mbc');
    if (!cv) { cv = document.createElement('canvas'); cv.className = 'mbc'; cv.setAttribute('aria-hidden', 'true'); btn.prepend(cv); }
    const m = { btn, cv, h: 0, p: 0, hv: 0, pv: 0, busy: false, clk: 0, key: '' };
    btn.addEventListener('pointerenter', () => { m.h = 1; wake(); });
    btn.addEventListener('pointerleave', () => { m.h = 0; m.p = 0; wake(); });
    btn.addEventListener('pointerdown', () => { m.p = 1; wake(); });
    window.addEventListener('pointerup', () => { if (m.p) { m.p = 0; wake(); } });
    m.api = { busy(v) { m.busy = !!v; wake(); }, redraw() { m.key = ''; wake(); } };
    btn._mb = m.api;
    buttons.add(m);
    wake();
    return m.api;
  }
  function wake() { if (!btnRaf) btnRaf = requestAnimationFrame(btnLoop); }
  let btnLast = 0;
  function btnLoop(now) {
    btnRaf = 0;
    const dt = Math.min(0.05, (now - (btnLast || now)) / 1000); btnLast = now;
    let moving = false;
    for (const m of [...buttons]) {
      if (!m.btn.isConnected) { buttons.delete(m); continue; }
      m.hv += ((m.h ? 1 : 0) - m.hv) * (1 - Math.exp(-dt * 12));
      m.pv += ((m.p ? 1 : 0) - m.pv) * (1 - Math.exp(-dt * 20));
      if (m.busy && !reduce()) m.clk += dt * 3.2;
      const off = m.btn.disabled ? 1 : 0;
      const key = [m.hv.toFixed(3), m.pv.toFixed(3), m.clk.toFixed(2), off, m.cv.clientWidth, isDark() ? 1 : 0].join('|');
      if (Math.abs(m.hv - m.h) > 0.002 || Math.abs(m.pv - m.p) > 0.002 || (m.busy && !reduce())) moving = true;
      if (key === m.key || document.hidden) continue;
      m.key = key;
      if (!fit(m.cv)) continue;
      // 画布比按钮四周各大 12px（给影子留位置），所以水珠的大小按比例算
      const B = m.btn.clientWidth, C = m.cv.clientWidth, s = (B / 2) / C / 0.15;
      const br = (1 + 0.03 * Math.sin(m.clk * 1.6)) * (1 + 0.07 * m.hv);
      const list = SUB.map(([r, orbit, ph], j) => {
        const o = orbit * 0.045 * (m.busy ? 1.8 : 1), u = Math.cos(m.clk * (0.5 + 0.2 * j) + ph) * o, v = Math.sin(m.clk * (0.6 + 0.2 * j) + ph) * o * 0.8;
        return [u * 1.42 * s * (1 + 0.14 * m.pv), (v * 1.42 - 0.012) * s * (1 - 0.14 * m.pv), r * 1.42 * s * br * (1 - 0.04 * m.pv)];
      });
      if (paint(m.cv, list, { time: 1.2, s })) m.btn.classList.add('merc-on');
    }
    if (moving) btnRaf = requestAnimationFrame(btnLoop);
  }

  // ---------- 开关里的水银珠：画一张静止的图（每种深浅色一张），交给 CSS 当开关圆点的背景
  function beadURL(px) {
    if (!ready()) return '';
    const c = document.createElement('canvas'); c.width = c.height = px;
    const R = 0.235 / 0.5 * 0.42; // 珠子占画布的比例
    const list = [[0, 0.01, R], [0.02, -0.005, R * 0.8], [-0.025, -0.01, R * 0.55], [-0.02, 0.02, R * 0.5]];
    return paint(c, list, { time: 1.2, persp: 0.3, lift: 0.24, s: 2.2 }) ? c.toDataURL('image/png') : '';
  }
  function setBead() {
    const u = beadURL(96);
    if (u) document.documentElement.style.setProperty('--bead', `url("${u}")`);
  }

  // ---------- 进度条：一条水银在槽里往前流（下载）、来回晃（检查中）；平时一颗小水珠歇在左边，完全静止
  function bar(el) {
    let mode = 'idle', target = 0, fill = 0, slosh = 0, last = 0, raf = 0, since = performance.now(), key = '';
    function tick(now) {
      raf = 0;
      if (!el.isConnected) return;
      const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
      const el2 = (now - since) / 1000;
      fill += (target - fill) * (1 - Math.exp(-dt * (target > fill ? 30 : 5)));
      slosh += ((mode === 'checking' ? 1 : 0) - slosh) * (1 - Math.exp(-dt * 6));
      const moving = Math.abs(target - fill) > 0.002 || slosh > 0.01 || mode === 'downloading';
      if (!document.hidden && fit(el)) {
        // 水珠大小按画布高度算（原型里槽高 14px、画布 64px）
        const kk = 64 / Math.max(20, el.clientHeight), asp = el.width / el.height, x0 = -asp / 2 + 0.12 * kk, full = asp - 0.24 * kk, gap = 0.085 * kk, len = full * fill, out = [];
        const n = Math.max(1, Math.round(len / gap) + 1), sx = -(full / 2 - 0.3) * Math.cos(el2 * 3.1) * slosh, sv = (full / 2 - 0.3) * 3.1 * Math.sin(el2 * 3.1) * slosh;
        const wob = mode === 'downloading' && !reduce() ? 1 : 0;
        for (let i = 0; i < 90; i++) {
          if (fill > 0.01) { out.push(i < n ? [x0 + Math.min(len, i * gap), 0.003 * kk * wob * Math.sin(now / 333 + i * 0.4), (i === 0 ? 0.07 : 0.05) * kk] : OFF); continue; }
          if (slosh > 0.02 && i < 9) { const k = i / 8 - 0.5, st = Math.min(0.5, Math.abs(sv) * 0.07); out.push([sx + k * (0.55 + st) * kk - sv * 0.03 * (0.5 - Math.abs(k)), 0, (0.056 - Math.abs(k) * 0.016) * kk]); continue; }
          out.push(i === 0 ? [x0, 0, 0.065 * kk * (1 - slosh)] : OFF);
        }
        out.push(fill > 0.01 ? [x0 + len, 0, 0.074 * kk] : OFF);
        const k2 = [fill.toFixed(3), slosh.toFixed(3), wob ? now.toFixed(0) : 0, el.width, isDark() ? 1 : 0].join('|');
        if (k2 !== key) { key = k2; paint(el, out, { time: 1.2, persp: 0.05 }); }
      }
      if (moving) raf = requestAnimationFrame(tick);
    }
    const go = () => { if (!raf) raf = requestAnimationFrame(tick); };
    go();
    return {
      // mode: idle / checking / downloading / ready / latest；p: 下载进度 0~1（不知道时自己慢慢涨）
      set(m, p) { if (m !== mode) since = performance.now(); mode = m; target = m === 'downloading' ? (p == null ? 0.85 : p) : m === 'ready' ? 1 : 0; go(); },
      redraw() { key = ''; go(); },
    };
  }

  // ---------- 背景的液态银：画一次（低分辨率，放大后本来就是柔的），窗口大小变了、换深浅色时重画
  let wallEl = null, wallT = 0;
  function wall(el) {
    wallEl = el;
    const draw = () => {
      if (!wallEl || !ready()) { document.documentElement.classList.add('no-wall'); return; }
      try {
        const w = Math.max(64, Math.round(innerWidth / 3)), h = Math.max(64, Math.round(innerHeight / 3));
        if (!wallProg) wallProg = compile(WALL);
        use(wallProg, w, h);
        gl.uniform2f(wallProg.U('uRes'), w, h); gl.uniform1f(wallProg.U('uDark'), isDark() ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        wallEl.width = w; wallEl.height = h;
        wallEl.getContext('2d').drawImage(glc, 0, 0);
        document.documentElement.classList.remove('no-wall');
      } catch (_) { document.documentElement.classList.add('no-wall'); }
    };
    draw();
    addEventListener('resize', () => { clearTimeout(wallT); wallT = setTimeout(draw, 250); });
    wall.draw = draw;
  }

  const bars = new Set();
  window.Merc = {
    lights,
    wall,
    button,
    bar(el) { const b = bar(el); bars.add(b); return b; },
    bead: setBead,
    scan(root) {
      try {
        (root || document).querySelectorAll('canvas.merc').forEach(bind);
        (root || document).querySelectorAll('.mb').forEach(button);
      } catch (_) {}
    },
    // 换深浅色后：背景、开关珠子、按钮、停在最后一帧的对勾都按新颜色重画一遍
    redraw() {
      try {
        if (wall.draw) wall.draw();
        setBead();
        const now = performance.now();
        document.querySelectorAll('canvas.merc').forEach((el) => { if (el._merc) frame(el, now); });
        for (const m of buttons) m.key = '';
        wake();
        bars.forEach((b) => b.redraw());
      } catch (_) {}
    },
  };
})();

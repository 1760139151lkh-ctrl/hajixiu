// VisionKit 2D landmarks: https://res.wx.qq.com/wxdoc/dist/assets/img/facelmk.7d1dc6ea.png
const leftEye = [52, 53, 72, 54, 55, 56, 73, 57];
const rightEye = [58, 59, 75, 60, 61, 62, 76, 63];
const leftBrow = [33, 34, 35, 36, 37, 67, 66, 65, 64];
const rightBrow = [38, 39, 40, 41, 42, 71, 70, 69, 68];
const lips = [84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95];
const between = (a, b, k = .5) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });

export function createFaceDetector() {
  let session, starting, stopStart, stopDetection, unavailable = false;
  function close() {
    stopStart?.();
    stopDetection?.();
    const previous = session;
    session = starting = undefined;
    try { previous?.destroy(); } catch { /* The platform may have already closed it. */ }
  }

  async function start() {
    if (unavailable || typeof wx.createVKSession !== 'function') return null;
    if (!starting) {
      try {
        session = wx.createVKSession({ version: 'v1', track: { face: { mode: 2 } } });
        const current = session;
        starting = new Promise(resolve => {
          let finished = false;
          const finish = result => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            stopStart = undefined;
            resolve(result);
          };
          const timer = setTimeout(() => finish(null), 1800);
          stopStart = () => finish(null);
          try { current.start(error => finish(error ? null : current)); }
          catch { finish(null); }
        });
      } catch {
        unavailable = true;
        close();
        return null;
      }
    }
    const task = starting;
    const found = await task;
    if (starting !== task) return null;
    if (!found) { unavailable = true; close(); }
    return found;
  }

  async function detect(frameBuffer, width, height, sourceType) {
    const native = await start();
    if (!native || native !== session || stopDetection) return null;
    return new Promise(resolve => {
      let finished = false;
      const finish = anchor => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { native.off('updateAnchors', receive); } catch { /* The session may already be closed. */ }
        stopDetection = undefined;
        resolve(anchor);
      };
      // A mode-2 call emits one updateAnchors event, including when no face was found.
      const receive = anchors => finish(anchors?.filter(anchor => anchor.size && anchor.points?.length >= 106 &&
        anchor.points.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)))
        .sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height)[0] || null);
      const timer = setTimeout(() => { finish(null); close(); }, 1800);
      stopDetection = () => finish(null);
      try {
        native.on('updateAnchors', receive);
        native.detectFace({ frameBuffer, width, height, sourceType, modelModel: 1, scoreThreshold: .5 });
      } catch { finish(null); close(); }
    });
  }
  return { start, detect, close };
}

function features(pts) {
  const chin = pts[16], browLine = between(pts[35], pts[40]);
  return {
    chin, top: between(browLine, chin, -.42),
    cheekL: pts[5], cheekR: pts[27], nose: pts[46],
    eyeL: between(pts[52], pts[55]), eyeR: between(pts[58], pts[61]),
  };
}

export function trackingFace(anchor, aspect) {
  if (!anchor) return null;
  const pts = anchor.points;
  const f = features(pts);
  const distance = (a, b) => Math.hypot((b.x - a.x) * aspect, b.y - a.y);
  return { ...f, pts, center: between(f.top, f.chin), width: distance(f.cheekL, f.cheekR),
    height: distance(f.top, f.chin), roll: Math.atan2(f.eyeR.y - f.eyeL.y, (f.eyeR.x - f.eyeL.x) * aspect),
    seen: performance.now() };
}

export async function faceOfCanvas(canvas, { requireSupport = false } = {}) {
  const w = canvas.width, h = canvas.height;
  const detector = createFaceDetector();
  try {
    if (requireSupport && !await detector.start()) throw new Error('Face detection is unavailable');
    const pixels = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const anchor = await detector.detect(pixels.buffer, w, h, 1);
    return anchor && regionsFor(anchor.points.map(({ x, y }) => ({ x: x * w, y: y * h })), w, h);
  } finally { detector.close(); }
}

function regionsFor(pts, w, h) {
  const { chin, top, cheekL, cheekR, nose, eyeL, eyeR } = features(pts);
  const rise = { x: top.x - chin.x, y: top.y - chin.y };
  const lift = (p, k) => ({ x: p.x + rise.x * k, y: p.y + rise.y * k });
  const jaw = pts.slice(0, 33);
  const bw = Math.hypot(cheekR.x - cheekL.x, cheekR.y - cheekL.y);
  const bh = Math.hypot(rise.x, rise.y);
  const middle = between(top, chin);
  const crown = [pts[0], lift(pts[33], .19), top, lift(pts[42], .19), pts[32]];
  const face = [...jaw, ...crown.slice(1, -1).reverse()];
  const at = indexes => indexes.map(i => pts[i]);
  const expand = (points, kx, ky) => {
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    return points.map(p => ({ x: cx + (p.x - cx) * kx, y: cy + (p.y - cy) * ky }));
  };
  const oval = (center, rx, ry) => Array.from({ length: 28 }, (_, i) => {
    const phi = i * Math.PI / 14;
    return { x: center.x + Math.cos(phi) * rx, y: center.y + Math.sin(phi) * ry };
  });
  const cheek = (eye, edge) => between(between(eye, edge, .65), nose, .2);
  const regions = {
    face: [expand(face, 1.04, 1.04)],
    brows: [expand(at(leftBrow), 1.45, 2.1), expand(at(rightBrow), 1.45, 2.1)],
    eyes: [expand(at(leftEye), 1.55, 2.4), expand(at(rightEye), 1.55, 2.4)],
    lips: [expand(at(lips), 1.18, 1.3)],
    blush: [oval(cheek(eyeL, pts[7]), bw * .14, bh * .085), oval(cheek(eyeR, pts[25]), bw * .14, bh * .085)],
    bangs: [[...crown.map(p => lift(p, .3)), pts[61], ...at([71, 70, 69, 68, 67, 66, 65, 64]), pts[52]]],
    beard: [[...jaw.slice(5, 16), lift(chin, -.22), ...jaw.slice(17, 28), ...at([83, 49, 82])]],
    ears: [oval(pts[4], bw * .13, bh * .2), oval(pts[28], bw * .13, bh * .2)],
    head: [[...crown, ...crown.map(p => lift(p, .48)).reverse()]],
    glasses: [expand(at([33, 34, 36, 39, 41, 42, 61, 62, 63, 58, 55, 56, 57, 52]), 1.12, 1.25)],
  };
  const hairExclusion = {
    brows: [expand(at(leftBrow), 1.12, 1.55), expand(at(rightBrow), 1.12, 1.55)],
    lowerFace: [...jaw.slice(7, 26), ...at([83, 49, 82])],
    samples: [between(pts[94], chin), cheek(eyeL, pts[7]), cheek(eyeR, pts[25])],
  };
  return { pts, w, h, box: [middle.x - bw / 2, top.y, bw, bh], regions, hairExclusion };
}

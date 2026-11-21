import { assetPath, connectFamily, selectFile, saveFile, writeBlob, removeFile, readBlob, secureImage, canvasImage, fetch as studioFetch, createImageBitmap as bitmapOf } from './platform.js';
import { faceOfCanvas } from './vision.js';
import { hairConfidence } from './hair-segmentation/index.js';

// On the web an omitted URL still creates a history entry for a sheet.
// Kbone ignores that call unless we pass the current address explicitly.
for (const name of ['pushState', 'replaceState']) {
  const update = window.history[name].bind(window.history);
  window.history[name] = (state, title, url) => update(state, title, url || window.location.href);
}

function canvasOf(width, height, type = '2d') {
  const canvas = wx.createOffscreenCanvas({ type, width, height });
  canvas.toBlob = (done, type, quality) => {
    try {
      const encoded = canvas.toDataURL(type, quality).split(',')[1];
      if (encoded) {
        const path = `${wx.env.USER_DATA_PATH}/canvas-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const fs = wx.getFileSystemManager();
        fs.writeFileSync(path, encoded, 'base64');
        try { done(readBlob(path, type)); } finally { removeFile(path); }
        return;
      }
    } catch { /* Try native canvas export. */ }
    wx.canvasToTempFilePath({
      canvas, fileType: type === 'image/png' ? 'png' : 'jpg', quality,
      success: ({ tempFilePath }) => done(readBlob(tempFilePath, type)), fail: () => done(null),
    });
  };
  return canvas;
}

const objectPaths = new Set();
export const URL = {
  createObjectURL(blob) {
    const path = writeBlob(blob);
    objectPaths.add(path);
    return path;
  },
  revokeObjectURL(path) { if (objectPaths.delete(path)) removeFile(path); },
};

function withGeometry(node) {
  if (node.__hjxGeometry || !node.$$getBoundingClientRect) return;
  node.__hjxGeometry = true;
  let rect, pending;
  const update = () => {
    if (pending) return;
    pending = true;
    Promise.resolve(node.$$getBoundingClientRect()).then(value => {
      if (value?.width) rect = { ...value, x: value.left, y: value.top };
    }).catch(() => {}).finally(() => { pending = false; });
  };
  node.getBoundingClientRect = () => {
    update();
    const { windowWidth: width, windowHeight: height } = wx.getWindowInfo();
    return rect || { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height };
  };
}

function observeSize(callback) {
  let active = true, timer;
  return {
    observe(node) {
      withGeometry(node);
      let last = '';
      const observe = async () => {
        if (!active) return;
        if (node.isConnected !== false) {
          const box = await Promise.resolve(node.$$getBoundingClientRect?.()).catch(() => null);
          const size = box && box.width + ':' + box.height;
          if (size && size !== last) { last = size; callback([{ target: node, contentRect: box }]); }
        }
        if (active) timer = setTimeout(observe, 350);
      };
      timer = setTimeout(observe, 100);
    },
    disconnect() { active = false; clearTimeout(timer); },
  };
}

const create = document.createElement.bind(document);
function adapt(node, tag = node.tagName?.toLowerCase()) {
  if (!tag || node.__hjxAdapted) return node;
  node.__hjxAdapted = true;
  withGeometry(node);
  const set = node.setAttribute.bind(node), remove = node.removeAttribute.bind(node);
  const tracked = new Set(['hidden', 'disabled', 'aria-pressed', 'aria-selected', 'aria-current', 'aria-checked']);
  const styleAttribute = (name, value) => {
    const cls = 'hjx-attr-' + name;
    const stale = node.className.split(' ').filter(token => token === cls || token.startsWith(cls + '-'));
    if (stale.length) node.classList.remove(...stale);
    if (value != null) {
      node.classList.add(cls);
      if (/^[a-zA-Z0-9_-]+$/.test(value)) node.classList.add(cls + '-' + value);
    }
  };
  const dataset = node.dataset;
  const mirror = new Proxy(dataset, {
    set(target, key, value) {
      target[key] = value;
      styleAttribute('data-' + key.replace(/[A-Z]/g, s => '-' + s.toLowerCase()), value);
      return true;
    },
    deleteProperty(target, key) {
      delete target[key];
      styleAttribute('data-' + key.replace(/[A-Z]/g, s => '-' + s.toLowerCase()), null);
      return true;
    },
  });
  Object.defineProperty(node, 'dataset', { get: () => mirror });
  node.setAttribute = (name, value) => {
    set(name, value);
    if (tracked.has(name)) styleAttribute(name, String(value));
  };
  node.removeAttribute = name => {
    remove(name);
    if (tracked.has(name)) styleAttribute(name, null);
  };
  Object.defineProperty(node, 'hidden', {
    get: () => node.hasAttribute('hidden'),
    set: hidden => { if (hidden) node.setAttribute('hidden', ''); else node.removeAttribute('hidden'); },
  });
  let htmlProperty;
  for (let prototype = Object.getPrototypeOf(node); prototype && !htmlProperty; prototype = Object.getPrototypeOf(prototype)) {
    htmlProperty = Object.getOwnPropertyDescriptor(prototype, 'innerHTML');
  }
  if (htmlProperty?.set) Object.defineProperty(node, 'innerHTML', {
    get: () => htmlProperty.get.call(node),
    set: html => htmlProperty.set.call(node, String(html).replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/g, (svg, attrs) => {
      const cls = attrs.match(/class="([^"]*)"/)?.[1] || '';
      const mask = encodeURIComponent(svg.replace('currentColor', '#000').replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'));
      return `<span class="${cls} hjx-svg" style="-webkit-mask-image:url(data:image/svg+xml,${mask})"></span>`;
    })),
  });
  const appendable = child => child instanceof Node ? child : document.createTextNode(String(child));
  if (!node.append) node.append = (...children) => {
    for (const child of children) if (child != null) node.appendChild(appendable(child));
  };
  if (!node.prepend) node.prepend = (...children) => {
    const before = node.firstChild || null;
    for (const child of children) if (child != null) node.insertBefore(appendable(child), before);
  };
  if (!node.remove) node.remove = () => node.parentNode?.removeChild(node);
  if (!node.focus) node.focus = () => {};
  if (!node.blur) node.blur = () => {};
  if (!node.matches) node.matches = query => [...document.querySelectorAll(query)].includes(node);
  if (!node.closest) node.closest = query => {
    for (let parent = node; parent; parent = parent.parentElement) {
      if (parent.matches?.(query)) return parent;
    }
    return null;
  };
  if (tag === 'wx-scroll-view') {
    Object.defineProperties(node, {
      scrollLeft: {
        get: () => Number(node.getAttribute('scroll-left')) || 0,
        set: value => {
          const next = Math.max(0, Math.round(Number(value) || 0));
          const current = Number(node.getAttribute('scroll-left'));
          node.setAttribute('scroll-left', String(current === next ? next + 0.01 : next));
        },
      },
      scrollTop: {
        get: () => Number(node.getAttribute('scroll-top')) || 0,
        set: value => {
          const next = Math.max(0, Math.round(Number(value) || 0));
          const current = Number(node.getAttribute('scroll-top'));
          node.setAttribute('scroll-top', String(current === next ? next + 0.01 : next));
        },
      },
    });
  }
  if (!node.scrollTo) node.scrollTo = ({ left, top, behavior }) => {
    if (tag !== 'wx-scroll-view') return;
    node.setAttribute('scroll-with-animation', Boolean(behavior === 'smooth'));
    if (Number.isFinite(left)) node.scrollLeft = left;
    if (Number.isFinite(top)) node.scrollTop = top;
  };
  if (!node.scrollIntoView) node.scrollIntoView = () => {
    let parent = node.parentElement;
    while (parent && !parent.getAttribute('scroll-x') && !parent.getAttribute('scroll-y')) parent = parent.parentElement;
    if (!parent) return;
    nativelyCenter(parent, node, false);
  };
  const pointers = { pointerdown: 'touchstart', pointermove: 'touchmove', pointerup: 'touchend', pointercancel: 'touchcancel', pointerleave: 'touchcancel' };
  const listen = node.addEventListener.bind(node), unlisten = node.removeEventListener.bind(node);
  const handlers = new WeakMap();
  node.addEventListener = (name, fn, opts) => {
    const touch = pointers[name];
    if (!touch) return listen(name, fn, opts);
    const listener = event => {
      const point = event.changedTouches?.[0] || event.touches?.[0];
      if (!point) return;
      const mapped = Object.create(event);
      Object.defineProperties(mapped, {
        clientX: { value: point.clientX ?? point.pageX ?? point.x },
        clientY: { value: point.clientY ?? point.pageY ?? point.y },
        pointerId: { value: point.identifier ?? 0 }, button: { value: 0 },
        preventDefault: { value: () => event.preventDefault() },
        stopPropagation: { value: () => event.stopPropagation() },
      });
      fn.call(node, mapped);
    };
    const map = handlers.get(fn) || {};
    map[name] = listener;
    handlers.set(fn, map);
    return listen(touch, listener, opts);
  };
  node.removeEventListener = (name, fn, opts) => unlisten(pointers[name] || name, handlers.get(fn)?.[name] || fn, opts);
  if (tag === 'img') {
    node.setAttribute('webp', true);
    node.setAttribute('mode', 'aspectFill');
    let originalSrc;
    for (let proto = Object.getPrototypeOf(node); proto && !originalSrc; proto = Object.getPrototypeOf(proto)) {
      originalSrc = Object.getOwnPropertyDescriptor(proto, 'src');
    }
    let measured = null;
    node.addEventListener('load', event => {
      if (event?.detail?.width) measured = event.detail;
    });
    Object.defineProperties(node, {
      naturalWidth: { get: () => measured?.width || node.$_naturalWidth || 0 },
      naturalHeight: { get: () => measured?.height || node.$_naturalHeight || 0 },
      complete: { get: () => Boolean(node.naturalWidth) },
    });
    const setSrc = s => {
      const src = String(s || '');
      if (node.__hjxSrc !== src) measured = null;
      node.__hjxSrc = src;
      const secured = secureImage(src);
      if (!secured) return originalSrc.set.call(node, src);
      secured.then(path => {
        if (node.__hjxSrc === src) originalSrc.set.call(node, path);
      }).catch(() => {
        if (node.__hjxSrc === src) node.$$trigger('error');
      });
    };
    Object.defineProperty(node, 'src', { get: () => originalSrc.get.call(node), set: setSrc });
    const setAttr = node.setAttribute;
    node.setAttribute = (name, value) => { if (name === 'src') setSrc(value); else setAttr(name, value); };
    const removeAttr = node.removeAttribute;
    node.removeAttribute = name => {
      if (name === 'src') { node.__hjxSrc = ''; measured = null; }
      return removeAttr(name);
    };
  }
  if (!node.replaceChildren) node.replaceChildren = (...children) => {
    node.textContent = '';
    node.append(...children.filter(child => child != null));
  };
  if (!node.toggleAttribute) node.toggleAttribute = (attr, force = !node.hasAttribute(attr)) => {
    if (force) node.setAttribute(attr, '');
    else node.removeAttribute(attr);
    return force;
  };
  if (!node.setPointerCapture) node.setPointerCapture = () => {};
  if (!node.releasePointerCapture) node.releasePointerCapture = () => {};
  if (!node.animate) node.animate = (frames, options) => {
    let finish, timer;
    const animation = { finished: new Promise(resolve => { finish = resolve; }), cancel() { clearTimeout(timer); finish(); } };
    const duration = typeof options === 'number' ? options : options.duration;
    if (node.$$animate) node.$$animate(frames, duration);
    timer = setTimeout(() => { finish(); animation.onfinish?.(); }, duration);
    return animation;
  };
  if (tag === 'canvas') {
    let surface, preparing, fallback, preview;
    let width = 1, height = 1, previewQueued = false;
    // The drawing buffer is in device pixels. Kbone's default setters also change CSS size.
    Object.defineProperties(node, {
      width: { get: () => width, set: value => {
        width = value;
        if (node.$_node) node.$_node.width = value;
        if (fallback) fallback.width = value;
      } },
      height: { get: () => height, set: value => {
        height = value;
        if (node.$_node) node.$_node.height = value;
        if (fallback) fallback.height = value;
      } },
    });
    node.prepareHajixiuCanvas = (type = '2d') => {
      if (preparing) return preparing;
      node.setAttribute('type', type);
      const find = () => node.$$getNodesRef().then(ref => new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 210);
        try { ref.node(result => { clearTimeout(timer); resolve(result?.node); }).exec(); }
        catch { clearTimeout(timer); resolve(null); }
      }));
      preparing = (async () => {
        for (let i = 0; i < 5; i++) {
          const native = await find().catch(() => null);
          if (native) {
            native.width = width;
            native.height = height;
            node.$_node = native;
            surface = native.getContext(type);
            preview?.remove();
            preview = undefined;
            return surface;
          }
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        preparing = null;
        return null;
      })();
      return preparing;
    };
    node.getContext = type => {
      if (type !== '2d') return surface || null;
      fallback ||= canvasOf(width, height);
      const context2d = fallback.getContext('2d');
      return new Proxy(context2d, {
        get(_, name) {
          const context = surface || context2d;
          const value = context[name];
          return typeof value === 'function' ? value.bind(context) : value;
        },
        set(_, name, value) { (surface || context2d)[name] = value; return true; },
      });
    };
    node.flushHajixiuCanvas = () => {
      if (surface || !fallback || previewQueued || node.isConnected === false || !node.parentNode) return;
      previewQueued = true;
      requestAnimationFrame(() => {
        previewQueued = false;
        if (surface || !node.parentNode) return;
        try {
          if (!preview) {
            preview = document.createElement('img');
            preview.className = 'frame__brush-preview';
            preview.setAttribute('aria-hidden', 'true');
            node.parentNode.insertBefore(preview, node);
          }
          preview.src = fallback.toDataURL('image/png');
        } catch { /* This runtime cannot surface an offscreen buffer. */ }
      });
    };
  }
  return node;
}

document.createElement = tag => adapt(create(tag), tag);
function adaptTree(node) {
  adapt(node);
  for (const child of node.children || []) adaptTree(child);
}

function createControl(tag, classes, props) {
  if (tag === 'input' && props?.type === 'range') {
    const slider = document.createElement('wx-slider');
    slider.setAttribute('block-size', 18);
    const listen = slider.addEventListener;
    slider.addEventListener = (name, fn, opts) => {
      if (name !== 'input' && name !== 'change') return listen(name, fn, opts);
      return listen(name === 'input' ? 'changing' : 'change', event => {
        slider.value = String(event.detail.value);
        fn.call(slider, event);
      }, opts);
    };
    return slider;
  }
  if (!classes.some(name => ['carousel__track', 'res__styles', 'versions', 'pp__parts', 'pills', 'chat__thread'].includes(name))) return null;
  const scroll = document.createElement('wx-scroll-view');
  const vertical = classes.includes('chat__thread');
  scroll.setAttribute(vertical ? 'scroll-y' : 'scroll-x', true);
  if (!classes.includes('carousel__track')) scroll.setAttribute('enable-flex', true);
  scroll.setAttribute('show-scrollbar', false);
  // Native scroll-view inserts a layout container. Put the original flex
  // gap on its children so spacing comes from WXSS on either renderer.
  const append = scroll.appendChild.bind(scroll);
  const margin = vertical ? 'margin-top' : 'margin-left';
  scroll.appendChild = child => {
    if (scroll.children.length && child.style) child.style.setProperty(margin, 'var(--hjx-scroll-gap)');
    return append(child);
  };
  return scroll;
}

async function nativelyCenter(track, child, smooth) {
  try {
    const [{ left, width }, card] = await Promise.all([track.$$getBoundingClientRect(), child.$$getBoundingClientRect()]);
    if (card.width) track.scrollTo({ left: Math.max(0, track.scrollLeft + card.left + card.width / 2 - left - width / 2), behavior: smooth ? 'smooth' : 'auto' });
  } catch { /* A screen can close during measurement. */ }
}

function captureLivePreview(view, overlay, render, raw) {
  if (!render || view.classList.contains('hjx-raw-camera')) return raw;
  const width = view.width, height = view.height;
  const result = canvasOf(width, height);
  const context = result.getContext('2d');
  try {
    const pixels = new Uint8Array(width * height * 4);
    render.readPixels(0, 0, width, height, render.RGBA, render.UNSIGNED_BYTE, pixels);
    const image = context.createImageData(width, height);
    const stride = width * 4;
    for (let y = 0; y < height; y++) {
      const row = (height - y - 1) * stride;
      image.data.set(pixels.subarray(row, row + stride), y * stride);
    }
    context.putImageData(image, 0, 0);
  } catch {
    return raw;
  }
  if (overlay.$_node) {
    try { context.drawImage(overlay.$_node, 0, 0, width, height); } catch { /* The preview still has its live grade. */ }
  }
  return result;
}

window.$$hjx = {
  assetPath, connectFamily, selectFile, saveFile, canvasOf, observeSize, adaptTree, createControl, nativelyCenter, faceOfCanvas,
  adaptImage: (width, height) => adapt(new window.Image(width, height), 'img'),
  captureLivePreview, hairConfidence,
  async loadCanvasImage(path) {
    if (path.startsWith('/img/')) return canvasImage(path);
    const image = await studioFetch(path);
    if (!image.ok) throw new Error('贴纸无法读取');
    return bitmapOf(await image.blob());
  },
  webglCanvasOf: (width, height) => canvasOf(width, height, 'webgl'),
  reload: () => wx.reLaunch({ url: '/pages/index/index' }),
};
wx.onNetworkStatusChange(({ isConnected }) => { if (isConnected) window.$$trigger('online'); });
window.addEventListener('wxshow', () => {
  document.$$trigger('visibilitychange');
});
window.addEventListener('wxhide', () => {
  window.$$trigger('pagehide');
  document.$$trigger('visibilitychange');
});

/**
 * Platform I/O for the existing browser modules. Requests still use the same
 * studio routes, upload form fields, job IDs and polling event format.
 */
import manifest from '../../web/img/manifest.json';

const fs = wx.getFileSystemManager();
const local = wx.getDeviceInfo().platform === 'devtools';
const settingsKey = 'hjx.wechat.connection';
const settings = wx.getStorageSync(settingsKey) || {};
let base = HJX_STUDIO_URL || localOrigin(settings.base) || '';
let conn = settings.base === base ? settings : { base };
let builds = {};
let serial = 0;
const assetPacks = new Map();
const imageFiles = new Map();
const artDirectory = `${wx.env.USER_DATA_PATH}/hjx-artwork`;
let artDirectoryReady = false;
const base85 = new Map([...('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' + '!#$%&()*+-;<=>?@^_`{|}~')].map((char, i) => [char, i]));

function localOrigin(value) {
  const m = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/.exec(value || '');
  if (!m) return '';
  const [a, b, c, d, port = 80] = m.slice(1).map(part => part === undefined ? 80 : Number(part));
  if (Math.max(a, b, c, d) > 255 || port < 1 || port > 65535) return '';
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 ||
    local && a === 127 && b === 0 && c === 0 && d === 1 ? value : '';
}

function decodeArtwork([length, encoded]) {
  const bytes = new Uint8Array(length);
  for (let i = 0, offset = 0; i < encoded.length; i += 5, offset += 4) {
    let packed = 0;
    for (let digit = i; digit < i + 5; digit++) packed = packed * 85 + base85.get(encoded[digit]);
    bytes[offset] = packed >>> 24;
    bytes[offset + 1] = packed >>> 16;
    bytes[offset + 2] = packed >>> 8;
    bytes[offset + 3] = packed;
  }
  return bytes.buffer;
}

function fullStyleArt(path) {
  return path.startsWith('/img/styles/') && path.endsWith('.webp') &&
    !path.endsWith('-m.webp') && !path.endsWith('-t.webp');
}

function fullPersonArt(path) {
  return path.startsWith('/img/people/') && path.endsWith('.webp') &&
    !path.endsWith('-m.webp') && !path.endsWith('-t.webp');
}

function pruneArtwork(keepPath) {
  let dropped = 0;
  for (const [key] of imageFiles) {
    if (key === keepPath) continue;
    const f = `${artDirectory}/${encodeURIComponent(key.slice(5)).replace(/%2F/g, '~')}`;
    imageFiles.delete(key);
    try { fs.unlinkSync(f); } catch {}
    if (++dropped >= 24) break;
  }
  if (!dropped) {
    try {
      for (const name of fs.readdirSync(artDirectory).slice(0, 24)) {
        const p = `${artDirectory}/${name}`;
        if (`${artDirectory}/${encodeURIComponent(keepPath.slice(5)).replace(/%2F/g, '~')}` !== p) {
          try { fs.unlinkSync(p); } catch {}
        }
      }
    } catch {}
  }
}

function loadArt(path) {
  if (!path.startsWith('/img/')) return null;
  if (!HJX_ART_INDEX[path] && fullStyleArt(path)) path = path.replace(/\.webp$/, '-m.webp');
  const pack = HJX_ART_INDEX[path];
  if (!pack) return null;
  if (!assetPacks.has(pack)) {
    const pending = getApp().loadArtPack(pack).catch(error => { assetPacks.delete(pack); throw error; });
    assetPacks.set(pack, pending);
  }
  if (!imageFiles.has(path)) {
    const pending = assetPacks.get(pack).then(files => {
      const file = `${artDirectory}/${encodeURIComponent(path.slice(5)).replace(/%2F/g, '~')}`;
      if (!artDirectoryReady) {
        try { fs.accessSync(artDirectory); } catch { fs.mkdirSync(artDirectory, true); }
        artDirectoryReady = true;
      }
      const raw = decodeArtwork(files[path]);
      try {
        fs.writeFileSync(file, raw);
      } catch {
        pruneArtwork(path);
        fs.writeFileSync(file, raw);
      }
      return file;
    }).catch(error => { imageFiles.delete(path); throw error; });
    imageFiles.set(path, pending);
  }
  return imageFiles.get(path);
}

export function assetPath(path) {
  const group = path.split('/')[0];
  const local = '/' + path;
  const wantRemoteFull = base && builds.img && (fullStyleArt(local) || fullPersonArt(local));
  if (group === 'img' && !wantRemoteFull) return local;
  if (base && builds[group]) return base + '/' + builds[group] + '/' + path;
  return base ? base + '/' + path : '/' + path;
}

const privateImage = /\/(?:api\/assets\/|v[0-9a-f]{16}\/img\/(?:people|styles)\/)/;
const downloads = new Map();
export function secureImage(path) {
  const absolute = '/' + path.replace(/^\/+/, '');
  const localFile = loadArt(absolute);
  if (localFile) return localFile;
  if (!privateImage.test(absolute)) return null;
  const url = /^https?:/.test(path) ? path : base + absolute;
  if (!base || !url.startsWith(base + '/')) return Promise.reject(new Error('工作室地址不一致'));
  if (!downloads.has(url)) {
    const pending = call('downloadFile', { url, header: headersFor(), timeout: 25000 })
      .then(result => {
        if (result.statusCode !== 200) throw new Error('图片暂时无法读取');
        return result.tempFilePath;
      })
      .catch(error => {
        downloads.delete(url);
        const bundled = url.slice(base.length).match(/^\/v[0-9a-f]{16}(\/img\/.*)$/);
        const localFile = bundled && loadArt(bundled[1]);
        if (localFile) return localFile;
        throw error;
      });
    downloads.set(url, pending);
    if (downloads.size > 200) downloads.delete(downloads.keys().next().value);
  }
  return downloads.get(url);
}

function save(patch) {
  conn = { ...conn, ...patch };
  wx.setStorageSync(settingsKey, conn);
}

function headersFor(extra) {
  return {
    ...extra,
    'X-Likeness-Client': 'miniprogram',
    ...(conn.session ? { 'X-Likeness-Session': conn.session } : {}),
    ...(conn.device ? { 'X-Likeness-Device': conn.device } : {}),
  };
}

function call(api, options) {
  return new Promise((success, fail) => wx[api]({ ...options, success, fail }));
}

function capture(headers, sentSession, status) {
  const session = Object.keys(headers || {}).find(key => key.toLowerCase() === 'x-likeness-session');
  if (session && status < 400 && conn.session === sentSession) save({ session: headers[session] });
}

function utf8(text) {
  const raw = unescape(encodeURIComponent(text));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return decodeURIComponent(escape(raw));
}

export class Blob {
  constructor(parts = [], options = {}) {
    this.type = options.type || '';
    const chunks = parts.map(part => (
      part instanceof Blob ? new Uint8Array(part.bytes) :
        typeof part === 'string' ? utf8(part) :
        ArrayBuffer.isView(part) ? new Uint8Array(part.buffer, part.byteOffset, part.byteLength) : new Uint8Array(part)
    ));
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    this.bytes = bytes.buffer;
    this.size = bytes.byteLength;
  }

  async text() { return decodeText(this.bytes); }
  async arrayBuffer() { return this.bytes.slice(0); }
}

export function readBlob(path, type = '') {
  return new Blob([fs.readFileSync(path)], { type: type || typeOf(path) });
}

function typeOf(path) {
  const ext = path.split(/[?#]/, 1)[0].split('.').pop();
  return { png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg', jpg: 'image/jpeg', json: 'application/json' }[ext] || 'image/jpeg';
}

export function writeBlob(blob, filename = '') {
  const ext = { 'image/png': 'png', 'image/webp': 'webp', 'application/json': 'json' }[blob.type] || 'jpg';
  const name = filename || `temp-${Date.now()}-${++serial}.${ext}`;
  const file = `${wx.env.USER_DATA_PATH}/${name}`;
  fs.writeFileSync(file, blob.bytes);
  return file;
}

export function removeFile(path) {
  try { fs.unlinkSync(path); } catch { /* already gone */ }
}

export class FormData {
  constructor() { this.fields = new Map(); }
  append(name, value) { this.fields.set(name, value); }
}

export class FileReader {
  readAsDataURL(blob) {
    Promise.resolve().then(() => {
      this.result = `data:${blob.type};base64,${wx.arrayBufferToBase64(blob.bytes)}`;
      this.onload?.();
    }).catch(error => { this.error = error; this.onerror?.(); });
  }
}

export class AbortSignal {
  listeners = new Set();
  aborted = false;
  addEventListener(type, listener) { if (type === 'abort') this.listeners.add(listener); }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  static timeout(ms) {
    const signal = new AbortSignal();
    signal.milliseconds = ms;
    return signal;
  }
}

export class AbortController {
  signal = new AbortSignal();
  abort() { this.signal.abort(); }
}

function response(status, data, type = '') {
  return {
    status, ok: status >= 200 && status < 300,
    async json() { return typeof data === 'string' ? JSON.parse(data) : data; },
    async blob() { return data instanceof Blob ? data : new Blob([data], { type }); },
  };
}

export async function fetch(path, init = {}) {
  const input = String(path);
  if (/^(?:wxfile|http):\/\/usr\//.test(input) || input.startsWith('wxfile://')) return response(200, readBlob(input));
  if (input.startsWith('data:')) {
    const [meta, encoded] = input.slice(5).split(',', 2);
    return response(200, new Blob([meta.endsWith(';base64') ? wx.base64ToArrayBuffer(encoded) : decodeURIComponent(encoded)], { type: meta.split(';')[0] }));
  }
  if (/^\/?img\//.test(input)) {
    const key = '/' + input.replace(/^\/+/, '');
    if (key === '/img/manifest.json') return response(200, manifest);
    const file = await loadArt(key);
    return file ? response(200, readBlob(file)) : response(404, '');
  }
  if (!base) return response(404, '');
  const url = /^https?:/.test(input) ? input : base + '/' + input.replace(/^\/+/, '');
  if (!url.startsWith(base + '/')) throw new Error('工作室地址不一致');
  if (init.signal?.aborted) throw new Error('已取消');
  const session = conn.session;
  const header = headersFor(init.headers);
  const secure = secureImage(url);
  if (secure) {
    const file = await secure.catch(() => '');
    return file ? response(200, readBlob(file, typeOf(url))) : response(404, '');
  }
  if (init.body instanceof FormData) {
    const body = init.body.fields;
    const filePath = writeBlob(body.get('file'));
    try {
      const result = await call('uploadFile', {
        url, filePath, header, name: 'file', formData: { kind: body.get('kind') }, timeout: 60000,
      });
      capture(result.header, session, result.statusCode);
      return response(result.statusCode, result.data);
    } finally { removeFile(filePath); }
  }
  if (/\/api\/assets\/[^/?]+(?:\?|$)|\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)) {
    const result = await call('downloadFile', { url, header, timeout: 25000 });
    return response(result.statusCode, result.statusCode === 200 ? readBlob(result.tempFilePath, typeOf(url)) : '');
  }
  const result = await new Promise((success, fail) => {
    const task = wx.request({
      url, header, method: init.method || 'GET', data: init.body,
      timeout: init.signal?.milliseconds || 20000, dataType: 'json', success, fail,
    });
    init.signal?.addEventListener('abort', () => task.abort());
  });
  capture(result.header, session, result.statusCode);
  return response(result.statusCode, result.data);
}

async function pair(origin, key) {
  const result = await call('request', {
    url: origin + '/api/client/open', method: 'POST', timeout: 15000,
    header: origin === base ? headersFor({ 'content-type': 'application/json' }) :
      { 'content-type': 'application/json', 'X-Likeness-Client': 'miniprogram' },
    data: { key },
  });
  const info = result.data;
  if (result.statusCode !== 200 || !info?.device_token || !info.session) {
    throw new Error(info?.detail || '请核对工作室地址和私人链接');
  }
  base = origin;
  save({ base, device: info.device_token, session: info.session });
}

export async function connectFamily(link) {
  const match = /^(https?:\/\/[^/?#@]+)\/open\/([0-9a-f]{64})\/?$/i.exec(link.trim());
  if (!match || (HJX_STUDIO_URL ? match[1] !== HJX_STUDIO_URL : !localOrigin(match[1]))) {
    throw new Error(HJX_STUDIO_URL ? '请粘贴此工作室的完整私人链接' : '请粘贴家里电脑生成的完整局域网私人链接');
  }
  await pair(match[1], match[2].toLowerCase());
  wx.reLaunch({ url: '/pages/index/index' });
}

export async function setupConnection() {
  let info;
  if (base && conn.device) {
    try {
      const res = await fetch('studio.json', { signal: AbortSignal.timeout(2200) });
      if (res.ok) info = await res.json();
      if (info) builds = info.builds || {};
    } catch { /* The original showcase remains available offline. */ }
  }
  const data = { 'studio-state': info || {}, 'studio-versions': {}, 'asset-manifest': manifest };
  for (const [id, value] of Object.entries(data)) {
    const el = document.createElement('script');
    el.id = id;
    el.textContent = JSON.stringify(value);
    document.head.appendChild(el);
  }
}

export async function createImageBitmap(blob) {
  const path = writeBlob(blob);
  try {
    return await canvasImage(path);
  } finally { removeFile(path); }
}

export async function canvasImage(path) {
  const source = await secureImage(path) || path;
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 });
  const image = canvas.createImage();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });
}

export async function selectFile(options = {}) {
  try {
    if (options.accept?.includes('json')) {
      const input = await call('chooseMessageFile', { count: 1, type: 'file', extension: ['json'] });
      return readBlob(input.tempFiles[0].path, 'application/json');
    }
    const result = await call('chooseMedia', {
      count: 1, mediaType: ['image'], sourceType: options.capture ? ['camera'] : ['album'],
      camera: 'front', sizeType: ['original'],
    });
    return readBlob(result.tempFiles[0].tempFilePath);
  } catch (error) {
    if (String(error.errMsg).includes('cancel')) return null;
    throw new Error(options.capture ? '相机打不开，请检查微信的相机权限' : '没有读取到文件，请再试一次');
  }
}

export async function saveFile(url, name) {
  const image = !name.endsWith('.json');
  const path = /^(?:wxfile:|http:\/\/usr\/)/.test(url) ? url : writeBlob(await fetch(url).then(r => r.blob()));
  if (image) await call('saveImageToPhotosAlbum', { filePath: path });
  else await call('shareFileMessage', { filePath: path, fileName: name });
}

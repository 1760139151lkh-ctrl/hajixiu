import { readBlob } from './platform.js';
import { createFaceDetector, trackingFace } from './vision.js';

export function cameraPermission() {
  return new Promise(resolve => wx.getSetting({
    success({ authSetting }) {
      const value = authSetting['scope.camera'];
      resolve(value === true ? 'granted' : value === false ? 'denied' : 'prompt');
    },
    fail: () => resolve('prompt'),
  }));
}

export function createCamera(output) {
  let control, context, listener, opening, detector;
  let frame = null, facing = 'user';

  async function start() {
    if (context) return;
    if (opening) return opening;
    const node = document.createElement('wx-camera');
    node.className = 'live__video hjx-camera';
    node.setAttribute('device-position', facing === 'user' ? 'front' : 'back');
    node.setAttribute('resolution', 'high');
    node.setAttribute('frame-size', 'medium');
    node.setAttribute('flash', 'off');
    control = node;
    opening = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('camera timeout'), { reason: 'none' })), 6500);
      node.addEventListener('initdone', () => {
        clearTimeout(timer);
        if (control !== node) return reject(new Error('camera closed'));
        context = wx.createCameraContext();
        try {
          listener = context.onCameraFrame(event => { frame = event; });
          listener.start({ fail: () => { listener = null; } });
        } catch { /* The native view and shutter still work without a frame feed. */ }
        resolve();
      }, { once: true });
      node.addEventListener('error', event => {
        clearTimeout(timer);
        const detail = String(event.detail?.errMsg || event.detail?.message || '');
        reject(Object.assign(new Error(detail), { reason: /auth|permission|deny/i.test(detail) ? 'denied' : 'none' }));
      }, { once: true });
      output.parentNode.insertBefore(node, output);
    });
    try { await opening; }
    catch (error) { stop(); throw error; }
    finally { opening = null; }
  }

  function stop() {
    detector?.close();
    detector = null;
    listener?.stop();
    listener = null;
    context = null;
    frame = null;
    control?.remove();
    control = null;
  }

  async function flip() {
    const old = facing;
    stop();
    facing = old === 'user' ? 'environment' : 'user';
    try { await start(); }
    catch (error) { facing = old; await start(); throw error; }
  }

  async function takePhoto() {
    if (!context) throw new Error('相机还没准备好');
    const path = await new Promise((resolve, reject) => context.takePhoto({
      quality: 'high', selfieMirror: facing === 'user',
      success: result => resolve(result.tempImagePath), fail: reject,
    }));
    return readBlob(path);
  }

  async function detectFace() {
    const image = frame;
    if (!image) return null;
    const active = detector ||= createFaceDetector();
    const anchor = await active.detect(image.data, image.width, image.height, 0);
    return detector === active ? trackingFace(anchor, image.width / image.height) : null;
  }

  return { start, stop, flip, takePhoto, detectFace, get on() { return Boolean(context); },
    get ready() { return Boolean(context); }, get facing() { return facing; }, get frame() { return frame; } };
}

import { createHairSegmenter } from './run.js';

let loading;

function loadModel() {
  if (!loading) {
    loading = getApp().loadHairModel().then(graph => ({
      graph,
      weights: wx.base64ToArrayBuffer(graph.weights),
    }));
    loading.catch(() => { loading = null; });
  }
  return loading;
}

// The MediaPipe graph stretches the image to its tensor size and then maps
// the confidence image back to the source coordinates, using pixel centers.
function fitMask(input, sw, sh, width, height) {
  if (sw === width && sh === height) return input;
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(sh - 1, (y + .5) * sh / height - .5));
    const row = Math.floor(sy), lower = Math.min(sh - 1, row + 1);
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(sw - 1, (x + .5) * sw / width - .5));
      const col = Math.floor(sx), right = Math.min(sw - 1, col + 1);
      const a = input[row * sw + col] + (input[row * sw + right] - input[row * sw + col]) * (sx - col);
      const b = input[lower * sw + col] + (input[lower * sw + right] - input[lower * sw + col]) * (sx - col);
      output[y * width + x] = a + (b - a) * (sy - row);
    }
  }
  return output;
}

export async function hairConfidence(canvas) {
  const { graph, weights } = await loadModel();
  const model = createHairSegmenter(graph, weights);
  const { width: w, height: h } = model;
  const image = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
  const context = image.getContext('2d');
  context.drawImage(canvas, 0, 0, w, h);
  const confidence = await model.segment(context.getImageData(0, 0, w, h).data);
  const { width, height } = canvas;
  return { width, height, data: fitMask(confidence, w, h, width, height) };
}

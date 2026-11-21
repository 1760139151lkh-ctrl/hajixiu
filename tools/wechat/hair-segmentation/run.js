// Float32 NHWC operators used by the original MediaPipe hair segmenter.
// Weight layouts are those of the bundled TFLite file (OHWI for conv).
function dot(source, from, filter, weight, channels) {
  let sum = 0;
  for (let c = 0; c < channels; c++) sum += source[from + c] * filter[weight + c];
  return sum;
}

function conv(source, filter, bias, target, stride, dilation, pad, kh, kw) {
  const { h, w, c, data } = source, { h: dh, w: dw, c: dc, data: dst } = target;
  const weights = filter.data, kernelSize = kh * kw * c;
  if (kh === 1 && kw === 1 && stride === 1) {
    for (let i = 0; i < dh * dw; i++) for (let d = 0; d < dc; d++) {
      dst[i * dc + d] = dot(data, i * c, weights, d * c, c) + bias.data[d];
    }
    return;
  }
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    for (let d = 0; d < dc; d++) {
      let sum = bias.data[d];
      for (let ky = 0; ky < kh; ky++) {
        const sy = y * stride - pad + ky * dilation;
        if (sy < 0 || sy >= h) continue;
        for (let kx = 0; kx < kw; kx++) {
          const sx = x * stride - pad + kx * dilation;
          if (sx < 0 || sx >= w) continue;
          sum += dot(data, (sy * w + sx) * c, weights, d * kernelSize + (ky * kw + kx) * c, c);
        }
      }
      dst[(y * dw + x) * dc + d] = sum;
    }
  }
}

function depthwise(source, filter, bias, target, stride, dilation, pad, kh, kw) {
  const { h, w, c, data } = source, dst = target.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let ch = 0; ch < c; ch++) {
    let sum = bias.data[ch];
    for (let ky = 0; ky < kh; ky++) {
      const sy = y * stride - pad + dilation * ky;
      if (sy < 0 || sy >= h) continue;
      for (let kx = 0; kx < kw; kx++) {
        const sx = x * stride - pad + dilation * kx;
        if (sx < 0 || sx >= w) continue;
        sum += data[(sy * w + sx) * c + ch] * filter.data[(ky * kw + kx) * c + ch];
      }
    }
    dst[(y * w + x) * c + ch] = sum;
  }
}

function transpose(source, filter, bias, target, stride, dilation, pad, kh, kw) {
  const { h, w, c, data } = source, { h: dh, w: dw, c: dc, data: dst } = target;
  for (let i = 0; i < dst.length; i += dc) dst.set(bias.data, i);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const from = (y * w + x) * c;
    for (let ky = 0; ky < kh; ky++) {
      const dy = y * stride - pad + ky * dilation;
      if (dy < 0 || dy >= dh) continue;
      for (let kx = 0; kx < kw; kx++) {
        const dx = x * stride - pad + kx * dilation;
        if (dx < 0 || dx >= dw) continue;
        const to = (dy * dw + dx) * dc;
        for (let d = 0; d < dc; d++) {
          const weight = ((d * kh + ky) * kw + kx) * c;
          dst[to + d] += dot(data, from, filter.data, weight, c);
        }
      }
    }
  }
}

function pool(source, target, indices) {
  const { w, c, data } = source, dw = target.w;
  const steps = [0, c, w * c, (w + 1) * c];
  for (let y = 0; y < target.h; y++) for (let x = 0; x < dw; x++) {
    const from = (y * 2 * w + x * 2) * c, to = (y * dw + x) * c;
    for (let ch = 0; ch < c; ch++) {
      let k = 0, best = data[from + ch];
      for (let j = 1; j < 4; j++) {
        const value = data[from + steps[j] + ch];
        if (value > best) { best = value; k = j; }
      }
      target.data[to + ch] = best;
      indices.data[to + ch] = k;
    }
  }
}

function unpool(source, indices, target) {
  const { w, c, data } = source, dw = target.w, dst = target.data;
  const steps = [0, c, dw * c, (dw + 1) * c];
  dst.fill(0);
  for (let y = 0; y < source.h; y++) for (let x = 0; x < w; x++) {
    const from = (y * w + x) * c, to = (y * 2 * dw + x * 2) * c;
    for (let ch = 0; ch < c; ch++) dst[to + steps[indices.data[from + ch]] + ch] = data[from + ch];
  }
}

function add(a, b, out) {
  const dst = out.data, first = a.data, second = b.data;
  for (let i = 0; i < dst.length; i++) dst[i] = first[i] + second[i];
}

function prelu(a, b, out) {
  const dst = out.data, values = a.data, weights = b.data, channels = out.c;
  for (let i = 0; i < dst.length; i += channels) for (let c = 0; c < channels; c++) {
    const value = values[i + c];
    dst[i + c] = value < 0 ? value * weights[c] : value;
  }
}

function concat(a, b, out) {
  const dst = out.data;
  for (let i = 0; i < out.h * out.w; i++) {
    const to = i * out.c;
    for (let c = 0; c < a.c; c++) dst[to + c] = a.data[i * a.c + c];
    for (let c = 0; c < b.c; c++) dst[to + a.c + c] = b.data[i * b.c + c];
  }
}

const CONVOLUTION = { conv, depthwise, transpose };
const PAIR = { prelu, add, unpool, concat };

export function createHairSegmenter(graph, weightBytes) {
  const arena = new ArrayBuffer(graph.size * 4);
  const views = graph.views.map(([offset, length, h, w, c]) => ({
    h, w, c, data: offset < 0
      ? new Float32Array(weightBytes, (-offset - 1) * 4, length)
      : new Float32Array(arena, offset * 4, length),
  }));
  const input = views[graph.input], output = views[graph.output];
  const jobs = graph.nodes.map(([name, inputs, outputs, ...options]) => {
    const [a, b, d] = inputs.map(i => views[i]);
    const [target, indices] = outputs.map(i => views[i]);
    if (name === 'pool') return () => pool(a, target, indices);
    if (PAIR[name]) return () => PAIR[name](a, b, target);
    return () => CONVOLUTION[name](a, b, d, target, ...options);
  });
  async function segment(rgba) {
    const values = input.data;
    for (let i = 0; i < values.length; i += 4) {
      values[i] = rgba[i] / 255;
      values[i + 1] = rgba[i + 1] / 255;
      values[i + 2] = rgba[i + 2] / 255;
      values[i + 3] = 0;
    }
    let frameStarted = Date.now();
    for (const job of jobs) {
      job();
      if (Date.now() - frameStarted > 16) {
        await new Promise(resolve => setTimeout(resolve, 0));
        frameStarted = Date.now();
      }
    }
    const confidence = new Float32Array(output.data.length / 2);
    for (let i = 0; i < confidence.length; i++) {
      confidence[i] = 1 / (1 + Math.exp(output.data[2 * i] - output.data[2 * i + 1]));
    }
    return confidence;
  }
  return { segment, width: input.w, height: input.h };
}

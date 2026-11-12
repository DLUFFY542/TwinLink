import { StreamDecoder } from '../src/renderer/js/decoder.js';

const canvas = document.getElementById('phone-canvas');
const errors = [];
let decodedFrames = 0;
let framesPushed = 0;
let firstFrameAt = 0;
let lastDecodedAt = 0;
let finished = false;

const decoder = new StreamDecoder({
  canvas,
  onError: (error) => {
    errors.push(String(error.message || error));
    if (errors.length > 10) window.pipeline.fail(errors.join('; '));
  },
  onSize: (width, height) => {
    console.log(`canvas resized by decoder: ${width}x${height}`);
  },
  onDecoded: () => {
    decodedFrames += 1;
    lastDecodedAt = performance.now();
    if (decodedFrames >= 30) scheduleFinish(250);
  },
});

window.pipeline.onSession((info) => {
  decoder.setSession(info);
});

window.pipeline.onFrame((frame) => {
  if (finished) return;
  if (!firstFrameAt) firstFrameAt = performance.now();

  const data = frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);

  // Exercise the exact renderer path: same call signature as mirror.js.
  decoder.push({ data, isConfig: frame.isConfig, isKey: frame.isKey });
  framesPushed += 1;
});

function countDistinctColors(width, height) {
  const context = canvas.getContext('2d', { alpha: false });
  const pixels = context.getImageData(0, 0, width, height).data;
  const colors = new Set();
  const step = 8;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      colors.add((pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2]);
    }
  }
  return colors.size;
}

function finish() {
  if (finished) return;
  finished = true;

  let distinctColors = 0;
  try {
    distinctColors = countDistinctColors(canvas.width, canvas.height);
  } catch (error) {
    errors.push(`pixel readback failed: ${error.message}`);
  }

  window.pipeline.result({
    decodedFrames,
    framesPushed,
    canvas: { width: canvas.width, height: canvas.height },
    distinctColors,
    decoderErrors: errors,
    firstFrameAfterMs: firstFrameAt ? Math.round(firstFrameAt) : null,
    lastDecodeAfterMs: lastDecodedAt ? Math.round(lastDecodedAt) : null,
  });
}

let finishTimer = null;
function scheduleFinish(delay) {
  if (finishTimer) return;
  finishTimer = setTimeout(finish, delay);
}

// Fallback: report whatever decoded if frames stop arriving.
setInterval(() => {
  if (finished || !firstFrameAt) return;
  if (performance.now() - firstFrameAt > 6000) finish();
}, 250);

window.addEventListener('error', (event) => {
  window.pipeline.fail(event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  window.pipeline.fail(String(event.reason));
});

// IPC listeners are registered before signalling readiness so no early frame
// can be missed.
window.pipeline.ready();

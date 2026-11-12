/**
 * H.264 decoding pipeline built on WebCodecs.
 *
 * scrcpy sends Annex-B H.264: SPS/PPS arrive as a separate config packet right
 * before key frames. WebCodecs accepts Annex-B when no `description` is given,
 * but the codec string still has to describe the SPS profile, so it is derived
 * from the SPS NAL unit itself.
 */

function findSps(data) {
  const length = data.length;
  let i = 0;
  while (i + 4 < length) {
    let nalStart = -1;
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      nalStart = i + 3;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      nalStart = i + 4;
    }

    if (nalStart !== -1) {
      if (nalStart + 3 < length && (data[nalStart] & 0x1f) === 7) {
        return { profile: data[nalStart + 1], constraints: data[nalStart + 2], level: data[nalStart + 3] };
      }
      i = nalStart + 1;
    } else {
      i += 1;
    }
  }
  return null;
}

function hex(value) {
  return value.toString(16).padStart(2, '0');
}

function codecStringFromSps(sps) {
  return `avc1.${hex(sps.profile)}${hex(sps.constraints)}${hex(sps.level)}`;
}

function concatenate(first, second) {
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}

export class StreamDecoder {
  constructor({ canvas, onError, onSize, onDecoded }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.onError = onError || (() => {});
    this.onSize = onSize || (() => {});
    this.onDecoded = onDecoded || (() => {});

    this.decoder = null;
    this.codecString = null;
    this.configData = null;
    this.width = 0;
    this.height = 0;
    this.timestamp = 0;
    this.closed = false;
    this.failures = 0;
  }

  setSession({ width, height }) {
    this.width = width;
    this.height = height;
    // A new capture session (rotation/resize) restarts the encoder, so the
    // decoder must be rebuilt from the next SPS/PPS + key frame pair.
    this.reset();
  }

  reset() {
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = null;
  }

  #configure() {
    if (this.decoder || !this.codecString) return false;
    const codedWidth = this.width || 720;
    const codedHeight = this.height || 1280;

    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this.#render(frame),
        error: (err) => this.#handleDecoderError(err),
      });
      this.decoder.configure({
        codec: this.codecString,
        codedWidth,
        codedHeight,
        optimizeForLatency: true,
        hardwareAcceleration: 'no-preference',
      });
      this.failures = 0;
      return true;
    } catch (err) {
      this.decoder = null;
      this.#handleDecoderError(err);
      return false;
    }
  }

  push({ data, isConfig, isKey }) {
    if (this.closed || !data || data.length === 0) return;

    const sps = findSps(data);
    if (sps) {
      const nextCodec = codecStringFromSps(sps);
      if (nextCodec !== this.codecString) {
        this.codecString = nextCodec;
        if (this.decoder) this.reset();
      }
    }

    if (isConfig) {
      this.configData = data;
      return;
    }

    if (!this.decoder && !this.#configure()) {
      return;
    }

    // The decoder must start on a key frame; prepend SPS/PPS so configuration
    // is present even if the separate config packet was missed.
    if (!isKey && this.decoder.decodeQueueSize > 24) {
      return; // drop stale delta frames instead of growing latency
    }

    let payload = data;
    if (isKey && this.configData) {
      payload = concatenate(this.configData, data);
    }

    this.timestamp += 1000;
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: this.timestamp,
          data: payload,
        }),
      );
    } catch (err) {
      this.#handleDecoderError(err);
    }
  }

  #render(frame) {
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    if (!width || !height) {
      frame.close();
      return;
    }

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.onSize(width, height);
    }

    try {
      this.ctx.drawImage(frame, 0, 0, width, height);
    } finally {
      frame.close();
    }
    this.onDecoded(width, height);
  }

  #handleDecoderError(err) {
    this.failures += 1;
    this.reset();
    if (this.failures <= 3) {
      this.onError(err instanceof Error ? err : new Error(String(err?.message || err)));
    }
  }

  close() {
    this.closed = true;
    this.reset();
  }
}

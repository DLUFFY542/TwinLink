/**
 * Experimental OPUS playback for scrcpy's audio stream.
 *
 * The device sends an "OpusHead" config packet followed by OPUS frames. This
 * path is implemented but has not been validated on a physical device, so the
 * UI labels it experimental and failures degrade to video-only mirroring.
 */
export class AudioPlayer {
  constructor({ onError } = {}) {
    this.onError = onError || (() => {});
    this.ctx = null;
    this.gain = null;
    this.decoder = null;
    this.nextTime = 0;
    this.muted = false;
    this.sampleRate = 48000;
    this.channels = 2;
    this.timestamp = 0;
    this.ready = false;
  }

  async init() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio is unavailable');
      this.ctx = new Ctx({ latencyHint: 'interactive', sampleRate: 48000 });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx.state === 'running';
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.01);
    }
  }

  configure(codec) {
    if (codec !== 'opus') {
      throw new Error(`unsupported audio codec: ${codec}`);
    }
    if (!('AudioDecoder' in window)) {
      throw new Error('WebCodecs AudioDecoder is unavailable');
    }
    this.codec = codec;
  }

  #ensureDecoder(description) {
    if (this.decoder) return;
    this.decoder = new AudioDecoder({
      output: (data) => this.#play(data),
      error: (err) => this.#fail(err),
    });

    const config = {
      codec: 'opus',
      sampleRate: this.sampleRate,
      numberOfChannels: this.channels,
    };
    if (description && description.length > 0) {
      config.description = description;
    }
    this.decoder.configure(config);
    this.ready = true;
  }

  push({ data, isConfig }) {
    if (!this.ctx) return;
    try {
      if (isConfig) {
        // The config packet starts with the OpusHead identification header.
        const head = data.subarray(0, Math.min(data.length, 19));
        if (head.length >= 10 && String.fromCharCode(...head.subarray(0, 8)) === 'OpusHead') {
          this.channels = head[9] || 2;
          this.sampleRate = head[12] | (head[13] << 8) | (head[14] << 16) | (head[15] << 24);
          if (!Number.isFinite(this.sampleRate) || this.sampleRate < 8000 || this.sampleRate > 192000) {
            this.sampleRate = 48000;
          }
        }
        this.#ensureDecoder(head);
        return;
      }

      if (!this.decoder) return;
      this.timestamp += 20000;
      this.decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: this.timestamp,
          data,
        }),
      );
    } catch (err) {
      this.#fail(err);
    }
  }

  #play(audioData) {
    try {
      const channels = audioData.numberOfChannels;
      const frames = audioData.numberOfFrames;
      const rate = audioData.sampleRate;
      if (!frames) return;

      const buffer = this.ctx.createBuffer(channels, frames, rate);

      if (audioData.format === 'f32') {
        const interleaved = new Float32Array(frames * channels);
        audioData.copyTo(interleaved, { planeIndex: 0 });
        for (let channel = 0; channel < channels; channel += 1) {
          const plane = new Float32Array(frames);
          for (let i = 0; i < frames; i += 1) {
            plane[i] = interleaved[i * channels + channel];
          }
          buffer.copyToChannel(plane, channel);
        }
      } else {
        for (let channel = 0; channel < channels; channel += 1) {
          const plane = new Float32Array(frames);
          audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
          buffer.copyToChannel(plane, channel);
        }
      }

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);

      const now = this.ctx.currentTime;
      if (this.nextTime < now || this.nextTime > now + 0.5) {
        this.nextTime = now + 0.03;
      }
      source.start(this.nextTime);
      this.nextTime += buffer.duration;
    } catch (err) {
      this.#fail(err);
    } finally {
      audioData.close();
    }
  }

  #fail(err) {
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = null;
    this.ready = false;
    this.onError(err instanceof Error ? err : new Error(String(err?.message || err)));
  }

  close() {
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = null;
    this.ready = false;
    this.nextTime = 0;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.gain = null;
    }
  }
}

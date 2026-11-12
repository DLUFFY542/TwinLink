export const RECORDING_FORMATS = Object.freeze({
  'webm-vp9': Object.freeze({
    id: 'webm-vp9',
    container: 'webm',
    mime: 'video/webm;codecs=vp9',
    label: 'WebM · VP9',
  }),
  'webm-vp8': Object.freeze({
    id: 'webm-vp8',
    container: 'webm',
    mime: 'video/webm;codecs=vp8',
    label: 'WebM · VP8',
  }),
  'webm-av1': Object.freeze({
    id: 'webm-av1',
    container: 'webm',
    mime: 'video/webm;codecs=av01',
    label: 'WebM · AV1',
  }),
  'mp4-h264': Object.freeze({
    id: 'mp4-h264',
    container: 'mp4',
    mime: 'video/mp4;codecs=avc1.42E01E',
    label: 'MP4 · H.264',
  }),
});

const FALLBACK_ORDER = ['webm-vp9', 'webm-vp8', 'webm-av1', 'mp4-h264'];

export function isRecordingFormatSupported(id) {
  const format = RECORDING_FORMATS[id];
  return Boolean(format) && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(format.mime);
}

/** Return the preferred format when the runtime supports it, otherwise the first supported fallback. */
export function resolveRecordingFormat(preferred) {
  if (isRecordingFormatSupported(preferred)) return RECORDING_FORMATS[preferred];
  for (const id of FALLBACK_ORDER) {
    if (isRecordingFormatSupported(id)) return RECORDING_FORMATS[id];
  }
  return null;
}

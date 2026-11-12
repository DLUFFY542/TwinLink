const bridge = window.twinlink;

if (!bridge) {
  throw new Error('Twinlink preload bridge is unavailable');
}

export const api = bridge;

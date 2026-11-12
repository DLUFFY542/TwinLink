export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

export function formatBitrate(kbps) {
  if (!kbps) return '0 Mbps';
  const mbps = kbps / 1000;
  return `${mbps >= 10 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function stateLabel(state) {
  switch (state) {
    case 'idle':
      return 'Idle';
    case 'starting':
      return 'Connecting';
    case 'streaming':
      return 'Live';
    case 'reconnecting':
      return 'Reconnecting';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Error';
    default:
      return state || 'Unknown';
  }
}

export function deviceStateLabel(device) {
  switch (device.state) {
    case 'device':
      return 'Ready';
    case 'unauthorized':
      return 'Authorize';
    case 'offline':
      return 'Offline';
    case 'authorizing':
      return 'Authorizing';
    case 'connecting':
      return 'Connecting';
    default:
      return device.state;
  }
}

export function deviceStateKind(device) {
  switch (device.state) {
    case 'device':
      return 'ok';
    case 'unauthorized':
    case 'authorizing':
      return 'warn';
    case 'offline':
    case 'no permissions':
      return 'error';
    default:
      return 'muted';
  }
}

export function createToasts(container) {
  return function toast(message, kind = 'info', timeout = 4200) {
    if (!container) return;
    const node = el('div', 'toast', String(message));
    node.dataset.kind = kind;
    container.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity 160ms ease';
      setTimeout(() => node.remove(), 180);
    }, timeout);
  };
}

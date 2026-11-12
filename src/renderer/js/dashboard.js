import { api } from './api.js';
import { el, icon, clear, deviceStateLabel, deviceStateKind } from './ui.js';

export function createDashboard({ state, toast, navigate, prepareAudio }) {
  const refs = {};

  function init() {
    refs.grid = document.getElementById('device-grid');
    refs.empty = document.getElementById('dashboard-empty');
    refs.alert = document.getElementById('adb-alert');
    refs.alertTitle = document.getElementById('adb-alert-title');
    refs.alertText = document.getElementById('adb-alert-text');
    refs.refresh = document.getElementById('refresh-devices');

    refs.refresh.addEventListener('click', async () => {
      refs.refresh.disabled = true;
      try {
        await api.devices.refresh();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        refs.refresh.disabled = false;
      }
    });

    document.getElementById('adb-locate').addEventListener('click', async () => {
      try {
        const result = await api.adb.pick();
        if (!result.canceled) {
          toast('adb path updated', 'ok');
          render(state.devices);
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('adb-recheck').addEventListener('click', async () => {
      try {
        await api.adb.redetect();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function render(snapshot) {
    if (!snapshot) return;
    const devices = snapshot.devices || [];

    renderAdbState(snapshot);
    clear(refs.grid);

    if (devices.length === 0) {
      refs.empty.classList.remove('hidden');
      return;
    }
    refs.empty.classList.add('hidden');

    for (const device of devices) {
      refs.grid.appendChild(renderDevice(device));
    }
  }

  function renderAdbState(snapshot) {
    const adbMissing = !snapshot.exe || !snapshot.exe.path;
    const failed = Boolean(snapshot.error);

    if (adbMissing) {
      refs.alert.classList.remove('hidden');
      refs.alertTitle.textContent = 'adb was not found';
      refs.alertText.textContent =
        'Twinlink needs Android Platform Tools (adb.exe). Install them, then locate adb.exe here.';
      return;
    }

    if (failed) {
      refs.alert.classList.remove('hidden');
      refs.alertTitle.textContent = 'adb is not responding';
      refs.alertText.textContent = snapshot.error;
      return;
    }

    refs.alert.classList.add('hidden');
  }

  function metaItem(iconName, text) {
    const node = el('span', 'meta-item');
    node.appendChild(icon(iconName));
    node.appendChild(document.createTextNode(text));
    return node;
  }

  function renderDevice(device) {
    const card = el('article', 'device-card');
    card.dataset.state = device.state;

    const head = el('div', 'device-head');
    const iconWrap = el('div', 'device-icon');
    iconWrap.appendChild(icon('phone'));
    head.appendChild(iconWrap);

    const titleWrap = el('div', 'device-title');
    const title = el('h3', null, device.details?.model || device.model || device.serial);
    const serial = el('span', 'device-serial', device.serial);
    titleWrap.appendChild(title);
    titleWrap.appendChild(serial);
    head.appendChild(titleWrap);

    const badge = el('span', `badge badge-${deviceStateKind(device)}`, deviceStateLabel(device));
    head.appendChild(badge);

    card.appendChild(head);

    const meta = el('div', 'device-meta');
    meta.appendChild(metaItem(device.connection === 'network' ? 'wifi' : 'usb', device.connection === 'network' ? 'Wi-Fi' : 'USB'));
    const details = device.details;
    if (details?.manufacturer) meta.appendChild(metaItem('phone', details.manufacturer));
    if (details?.androidVersion) meta.appendChild(metaItem('check', `Android ${details.androidVersion}`));
    if (details?.screenWidth && details?.screenHeight) {
      meta.appendChild(metaItem('expand', `${details.screenWidth} × ${details.screenHeight}`));
    }
    card.appendChild(meta);

    const actions = el('div', 'device-actions');

    if (device.state === 'device') {
      const connect = el('button', 'btn btn-primary', 'Connect');
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        connect.textContent = 'Connecting…';
        try {
          await prepareAudio(state.settings);
          await api.mirror.start(device.serial);
          navigate('mirror');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          connect.disabled = false;
          connect.textContent = 'Connect';
        }
      });
      actions.appendChild(connect);

      if (device.connection === 'network') {
        const forget = el('button', 'btn btn-ghost', 'Disconnect');
        forget.addEventListener('click', async () => {
          try {
            const result = await api.wireless.disconnect({ address: device.serial });
            toast(result.output || 'Disconnected', 'ok');
          } catch (err) {
            toast(err.message, 'error');
          }
        });
        actions.appendChild(forget);
      }
    } else if (device.state === 'unauthorized') {
      actions.appendChild(
        el(
          'div',
          'device-note',
          'Unlock the phone and accept the “Allow USB debugging?” prompt. Tick “Always allow” for automatic reconnects.',
        ),
      );
    } else if (device.state === 'offline') {
      actions.appendChild(
        el('div', 'device-note', 'The device is offline. Reconnect the cable or restart adb from Settings.'),
      );
    } else {
      actions.appendChild(el('div', 'device-note', `Device state: ${device.state}`));
    }

    card.appendChild(actions);
    return card;
  }

  return { init, render };
}

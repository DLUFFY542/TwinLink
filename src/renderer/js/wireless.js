import { api } from './api.js';
import { clear, el, icon } from './ui.js';

const ADDRESS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}:\d{1,5}$/;

export function createWireless({ toast }) {
  const refs = {};
  let activeTab = 'pair';

  function init() {
    refs.modal = document.getElementById('wireless-modal');
    refs.pairAddress = document.getElementById('pair-address');
    refs.pairCode = document.getElementById('pair-code');
    refs.connectAddress = document.getElementById('connect-address');
    refs.pairOutput = document.getElementById('pair-output');
    refs.connectOutput = document.getElementById('connect-output');
    refs.discoverOutput = document.getElementById('discover-output');
    refs.discoveredList = document.getElementById('discovered-list');

    document.getElementById('open-wireless').addEventListener('click', open);
    document.getElementById('close-wireless').addEventListener('click', close);

    refs.modal.addEventListener('click', (event) => {
      if (event.target === refs.modal) close();
    });

    for (const tab of document.querySelectorAll('[data-wtab]')) {
      tab.addEventListener('click', () => showTab(tab.dataset.wtab));
    }

    document.getElementById('do-pair').addEventListener('click', () => void pair());
    document.getElementById('do-connect').addEventListener('click', () => void connect());
    document.getElementById('do-discover').addEventListener('click', () => void discover());

    refs.pairCode.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void pair();
    });
    refs.connectAddress.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void connect();
    });
    refs.pairAddress.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void pair();
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !refs.modal.classList.contains('hidden')) close();
    });
  }

  function open() {
    refs.modal.classList.remove('hidden');
    showTab('pair');
    setTimeout(() => refs.pairAddress.focus(), 30);
  }

  function close() {
    refs.modal.classList.add('hidden');
  }

  function showTab(name) {
    activeTab = name;
    for (const tab of document.querySelectorAll('[data-wtab]')) {
      tab.classList.toggle('is-active', tab.dataset.wtab === name);
    }
    for (const panel of document.querySelectorAll('.wtab')) {
      panel.classList.toggle('is-active', panel.id === `wtab-${name}`);
    }
    if (name === 'discovered') void discover();
  }

  function showOutput(node, text, isError) {
    node.textContent = text;
    node.classList.remove('hidden');
    node.style.color = isError ? 'var(--danger)' : '';
  }

  async function pair() {
    const address = refs.pairAddress.value.trim();
    const code = refs.pairCode.value.trim();

    if (!ADDRESS_PATTERN.test(address)) {
      toast('Pairing address must look like 192.168.1.42:41567', 'warn');
      return;
    }
    if (!/^\d{4,8}$/.test(code)) {
      toast('Pairing code must be the number shown on the phone', 'warn');
      return;
    }

    const button = document.getElementById('do-pair');
    button.disabled = true;
    try {
      const result = await api.wireless.pair({ address, code });
      showOutput(refs.pairOutput, result.output || (result.ok ? 'Paired.' : 'Pairing failed.'), !result.ok);
      if (result.ok) {
        toast('Paired. Now connect using the wireless debugging port.', 'ok');
        showTab('connect');
        refs.connectAddress.focus();
      }
    } catch (err) {
      showOutput(refs.pairOutput, err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function connect() {
    const address = refs.connectAddress.value.trim();
    if (!ADDRESS_PATTERN.test(address)) {
      toast('Connection address must look like 192.168.1.42:39101', 'warn');
      return;
    }

    const button = document.getElementById('do-connect');
    button.disabled = true;
    try {
      const result = await api.wireless.connect({ address });
      showOutput(refs.connectOutput, result.output || (result.ok ? 'Connected.' : 'Connection failed.'), !result.ok);
      if (result.ok) {
        toast('Connected wirelessly', 'ok');
        setTimeout(close, 700);
      }
    } catch (err) {
      showOutput(refs.connectOutput, err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  async function discover() {
    const button = document.getElementById('do-discover');
    button.disabled = true;
    try {
      const result = await api.wireless.discover();
      clear(refs.discoveredList);

      if (!result.services || result.services.length === 0) {
        refs.discoveredList.appendChild(
          el('li', 'muted small', 'No services found. Make sure wireless debugging is on and both devices share the network.'),
        );
        refs.discoverOutput.classList.add('hidden');
        return;
      }

      for (const service of result.services) {
        const item = el('li');

        const wrap = el('div', 'svc');
        wrap.appendChild(el('code', null, service.address));
        wrap.appendChild(
          el('span', null, service.kind === 'pairing' ? 'pairing endpoint' : 'connection endpoint'),
        );
        item.appendChild(wrap);

        const use = el('button', 'btn btn-small', 'Use');
        use.appendChild(icon(service.kind === 'pairing' ? 'wifi' : 'usb'));
        use.addEventListener('click', () => {
          if (service.kind === 'pairing') {
            refs.pairAddress.value = service.address;
            showTab('pair');
            refs.pairCode.focus();
          } else {
            refs.connectAddress.value = service.address;
            showTab('connect');
          }
        });
        item.appendChild(use);
        refs.discoveredList.appendChild(item);
      }
      refs.discoverOutput.classList.add('hidden');
    } catch (err) {
      showOutput(refs.discoverOutput, err.message, true);
    } finally {
      button.disabled = false;
    }
  }

  return { init, open, close };
}

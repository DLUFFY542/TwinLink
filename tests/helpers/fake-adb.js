'use strict';

/**
 * Test double for adb.exe. Invoked as: node fake-adb.js <args...>
 * Behaviour is controlled with environment variables so a single script can
 * emulate devices, properties, failures and slow commands.
 */

const args = process.argv.slice(2);

function out(text) {
  process.stdout.write(text);
}

function fail(text, code = 1) {
  process.stderr.write(text);
  process.exit(code);
}

if (args[0] === 'version') {
  out('Android Debug Bridge version 1.0.41\nVersion 37.0.1-15733141\n');
  process.exit(0);
}

if (args[0] === 'devices' && args.includes('-l')) {
  out(process.env.FAKE_DEVICES || 'List of devices attached\n\n');
  process.exit(0);
}

if (args[0] === 'mdns' && args[1] === 'services') {
  out(
    process.env.FAKE_MDNS ||
      'List of discovered mdns services\nadb-ABC123\t_adb-tls-pairing._tcp\t192.168.1.5:41567\nadb-ABC123\t_adb-tls-connect._tcp\t192.168.1.5:39101\n',
  );
  process.exit(0);
}

if (args[0] === 'connect' || args[0] === 'disconnect' || args[0] === 'pair') {
  if (process.env.FAKE_ADB_LINK_FAIL === '1') {
    fail(`failed to ${args[0]}: connection refused\n`);
  }
  out(`${args[0]} ${args[1]} succeeded\n`);
  process.exit(0);
}

if (args[0] === 'fail') {
  fail('forced failure\n', 2);
}

if (args[0] === 'sleep') {
  setTimeout(() => out('slept\n'), 4000);
} else if (args[0] === '-s') {
  const [, serial, command] = args;
  if (command === 'shell') {
    const shellArgs = args.slice(3);
    if (shellArgs[0] === 'getprop') {
      const prop = shellArgs[1] || '';
      const props = {
        'ro.product.model': process.env.FAKE_MODEL || 'Pixel 7',
        'ro.product.manufacturer': 'Google',
        'ro.build.version.release': '14',
        'ro.build.version.sdk': '34',
      };
      out(`${props[prop] ?? ''}\n`);
      process.exit(0);
    }
    if (shellArgs[0] === 'wm' && shellArgs[1] === 'size') {
      out('Physical size: 1080x2400\n');
      process.exit(0);
    }
    if (shellArgs[0] === 'wm' && shellArgs[1] === 'density') {
      out('Physical density: 420\n');
      process.exit(0);
    }
    if (shellArgs[0] === 'sleep-forever') {
      setTimeout(() => out('done\n'), 10000);
    } else {
      out(`shell ok for ${serial}\n`);
      process.exit(0);
    }
  } else if (command === 'forward') {
    out(`forwarded ${serial}\n`);
    process.exit(0);
  } else if (command === 'push') {
    out('1 file pushed\n');
    process.exit(0);
  } else {
    out(`ok ${command}\n`);
    process.exit(0);
  }
} else {
  out('unknown command\n');
  process.exit(0);
}

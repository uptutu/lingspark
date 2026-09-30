// The icon codec is build tooling, not shipped code, so it is checked here
// rather than in packages/*/src/**/*.test.ts (vitest only collects there).
// Run: node packages/desktop/scripts/lib/icon.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeIco, encodePng, resize } from './icon.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', 'build', 'icon.png');
const original = decodePng(readFileSync(source));

let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
};

console.log('icon codec');

check('decodes the real icon', () => {
  assert.equal(original.width, 1024);
  assert.equal(original.height, 1024);
  assert.equal(original.data.length, 1024 * 1024 * 4);
});

check('every PNG row survives an encode/decode round trip', () => {
  const back = decodePng(encodePng(original));
  assert.equal(back.width, original.width);
  assert.equal(back.height, original.height);
  assert.ok(back.data.equals(original.data));
});

check('resizes to each size the platforms ask for', () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const small = resize(original, size);
    assert.equal(small.width, size, `width at ${String(size)}`);
    assert.equal(small.height, size, `height at ${String(size)}`);
    assert.equal(small.data.length, size * size * 4, `byte length at ${String(size)}`);
    const back = decodePng(encodePng(small));
    assert.ok(back.data.equals(small.data), `round trip at ${String(size)}`);
  }
});

check('resizing keeps the logo opaque, not a black square', () => {
  // A resize that dropped the alpha channel, or averaged against an
  // uninitialised buffer, would still decode -- it would just be wrong. The
  // middle of the icon is the mark itself, so it must stay covered.
  const small = resize(original, 64);
  let opaque = 0;
  for (let i = 3; i < small.data.length; i += 4) if (small.data[i] > 0) opaque++;
  assert.ok(opaque > 64 * 64 * 0.5, `only ${String(opaque)} of ${String(64 * 64)} pixels opaque`);
});

check('resizing to the same size is the identity', () => {
  assert.equal(resize(original, 1024), original);
});

check('refuses to enlarge', () => {
  assert.throws(() => resize(original, 2048), /缩小/);
});

check('packs an .ico whose every entry decodes to its own size', () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const ico = encodeIco(sizes, original);
  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type: icon');
  assert.equal(ico.readUInt16LE(4), sizes.length, 'entry count');

  for (let i = 0; i < sizes.length; i++) {
    const entry = 6 + i * 16;
    const want = sizes[i];
    // 256 does not fit the one-byte field and is stored as 0.
    const declared = ico[entry] === 0 ? 256 : ico[entry];
    assert.equal(declared, want, `directory entry ${String(i)} size`);
    assert.equal(ico[entry + 1], ico[entry], `width and height agree at ${String(i)}`);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    const image = decodePng(ico.subarray(offset, offset + length));
    assert.equal(image.width, want, `entry ${String(i)} decodes at its declared size`);
    assert.equal(image.height, want, `entry ${String(i)} height`);
  }
});

check('rejects a PNG it cannot read honestly', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /PNG/);
});

console.log(`\n${String(checks)} checks passed`);

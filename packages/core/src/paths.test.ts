import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { dataDir, findProjectRoot, type PathEnv } from './paths.js';

const mac: PathEnv = { platform: 'darwin', env: {}, homedir: '/Users/x' };
const win: PathEnv = {
  platform: 'win32',
  env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
  homedir: 'C:\\Users\\x',
};
const linux: PathEnv = { platform: 'linux', env: {}, homedir: '/home/x' };

describe('dataDir', () => {
  it('uses Application Support on macOS', () => {
    expect(dataDir(mac)).toBe(path.join('/Users/x', 'Library', 'Application Support', 'lingspark'));
  });

  it('uses APPDATA on Windows', () => {
    expect(dataDir(win)).toBe(path.join('C:\\Users\\x\\AppData\\Roaming', 'lingspark'));
  });

  it('falls back to AppData\\Roaming when APPDATA is unset', () => {
    expect(dataDir({ ...win, env: {} })).toBe(
      path.join('C:\\Users\\x', 'AppData', 'Roaming', 'lingspark'),
    );
  });

  it('honours XDG_DATA_HOME, and falls back to ~/.local/share', () => {
    expect(dataDir({ ...linux, env: { XDG_DATA_HOME: '/data' } })).toBe(
      path.join('/data', 'lingspark'),
    );
    expect(dataDir(linux)).toBe(path.join('/home/x', '.local', 'share', 'lingspark'));
  });

  it('treats an empty XDG_DATA_HOME as unset', () => {
    expect(dataDir({ ...linux, env: { XDG_DATA_HOME: '' } })).toBe(
      path.join('/home/x', '.local', 'share', 'lingspark'),
    );
  });

  it('lets LINGSPARK_DATA_DIR override every platform', () => {
    const over = { LINGSPARK_DATA_DIR: path.resolve('/tmp/dl') };
    expect(dataDir({ ...mac, env: over })).toBe(path.resolve('/tmp/dl'));
    expect(dataDir({ ...win, env: { ...win.env, ...over } })).toBe(path.resolve('/tmp/dl'));
  });
});

describe('findProjectRoot', () => {
  const root = path.resolve(path.sep, 'w', 'proj');
  const marker = path.join(root, '.lingspark', 'config.yaml');
  const exists = (p: string) => p === marker;

  it('finds the marker in an ancestor directory', () => {
    expect(findProjectRoot(path.join(root, 'docs', 'a', 'b'), exists)).toBe(root);
  });

  it('finds the marker in the start directory itself', () => {
    expect(findProjectRoot(root, exists)).toBe(root);
  });

  it('returns null and terminates when no marker exists anywhere', () => {
    expect(findProjectRoot(path.join(root, 'docs'), () => false)).toBeNull();
  });
});

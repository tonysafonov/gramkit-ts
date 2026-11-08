import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileManager } from './files';

const root = mkdtempSync(join(tmpdir(), 'gramkit-files-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('FileManager', () => {
  it('creates the static directory', () => {
    const path = join(root, 'a', 'static');
    new FileManager(path, 'https://api.example.com');
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it('resolves paths inside the static directory', () => {
    const manager = new FileManager(join(root, 'b'), 'https://api.example.com');
    expect(manager.getFullPath('images/logo.png')).toBe(join(root, 'b', 'images', 'logo.png'));
  });

  it('builds URLs and drops the trailing slash of the domain', () => {
    const manager = new FileManager(join(root, 'c'), 'https://api.example.com///');
    expect(manager.getFullUrl('images/logo.png')).toBe('https://api.example.com/static/images/logo.png');
  });

  it('ensures a subdirectory and returns it, twice without error', () => {
    const manager = new FileManager(join(root, 'd'), 'https://api.example.com');
    const path = manager.ensureSubdirectory('uploads/avatars');
    expect(path).toBe(join(root, 'd', 'uploads', 'avatars'));
    expect(existsSync(path)).toBe(true);
    expect(manager.ensureSubdirectory('uploads/avatars')).toBe(path);
  });
});

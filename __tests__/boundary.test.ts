import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mechanical guard for the app boundary contract (AGENTS.md §2) and the
 * "scoped tokens end-to-end" requirement (ima-jin/imajin-ai#1974 pattern):
 * this app is an external client of the kernel.
 */

const ROOT = join(__dirname, '..');
const SOURCE_DIRS = ['app', 'src'];
const AUTHENTICATE_FILE = join('src', 'lib', 'auth', 'authenticate.ts');

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === '__tests__' || entry === 'node_modules') continue;
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));
const read = (file: string) => readFileSync(file, 'utf-8');
const rel = (file: string) => relative(ROOT, file);

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

describe('boundary contract', () => {
  it('scans a non-trivial set of source files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('never imports kernel-internal @imajin/* packages or monorepo paths', () => {
    const offenders = files.flatMap((file) =>
      importsOf(read(file))
        .filter((spec) => spec.startsWith('@imajin/') || /apps\/kernel|packages\//.test(spec))
        .map((spec) => `${rel(file)} -> ${spec}`)
    );
    expect(offenders).toEqual([]);
  });

  it('declares no workspace:* or @imajin/* dependencies', () => {
    const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.entries(all).filter(([, version]) => version.startsWith('workspace:'))).toEqual([]);
    expect(Object.keys(all).filter((name) => name.startsWith('@imajin/'))).toEqual([]);
  });

  it("funnels all inbound auth through authenticate(): only that file imports '@ima-jin/auth'", () => {
    const importers = files
      .filter((file) => importsOf(read(file)).includes('@ima-jin/auth'))
      .map(rel);
    expect(importers).toEqual([AUTHENTICATE_FILE]);
  });

  it('puts authenticate() on every route that acts on behalf of a user', () => {
    const userRoutes = [
      'app/api/listings/route.ts',
      'app/api/listings/[id]/route.ts',
      'app/api/listings/[id]/purchase/route.ts',
      'app/api/my/listings/route.ts',
      'app/api/seller/settings/route.ts',
      'app/api/me/route.ts',
    ];
    for (const route of userRoutes) {
      expect(read(join(ROOT, route)), route).toMatch(/authenticate(Optional)?\(/);
    }
  });

  it('never hard-codes a kernel or service URL', () => {
    const offenders = files
      .filter((file) => !rel(file).startsWith(join('src', 'lib', 'env.ts')))
      .flatMap((file) => {
        const withoutComments = read(file).replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        return (withoutComments.match(/['"`]https?:\/\/[^'"`$]+/g) ?? []).map((url) => `${rel(file)}: ${url}`);
      });
    expect(offenders).toEqual([]);
  });
});

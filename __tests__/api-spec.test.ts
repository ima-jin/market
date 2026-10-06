import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Keeps api-spec/openapi.yaml honest: the spec and the route files under
 * app/api must describe exactly the same operations, and the spec must be
 * internally consistent. Adding a route (or an HTTP method) without
 * documenting it — or documenting one that does not exist — fails here.
 */

const ROOT = join(__dirname, '..');
const API_DIR = join(ROOT, 'app', 'api');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Operation {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  responses?: Record<string, unknown>;
}

type Spec = {
  openapi: string;
  paths: Record<string, Record<string, Operation | unknown>>;
  components: { securitySchemes: Record<string, unknown>; [key: string]: unknown };
};

const spec = parse(readFileSync(join(ROOT, 'api-spec', 'openapi.yaml'), 'utf-8')) as Spec;

function findRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === '__tests__') continue;
    if (statSync(full).isDirectory()) {
      files.push(...findRouteFiles(full));
    } else if (entry === 'route.ts') {
      files.push(full);
    }
  }
  return files;
}

function routePath(file: string): string {
  const segments = relative(join(ROOT, 'app'), file).split(sep).slice(0, -1);
  return `/${segments.map((s) => s.replace(/^\[(.+)\]$/, '{$1}')).join('/')}`;
}

function exportedMethods(file: string): string[] {
  const source = readFileSync(file, 'utf-8');
  const methods: string[] = [];
  for (const method of HTTP_METHODS) {
    const upper = method.toUpperCase();
    const declared = new RegExp(String.raw`export\s+(?:async\s+)?function\s+${upper}\b|export\s+const\s+${upper}\b`);
    if (declared.test(source)) methods.push(method);
  }
  return methods;
}

function describedOperations(): Set<string> {
  const ops = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      if ((item as Record<string, unknown>)[method]) ops.add(`${method} ${path}`);
    }
  }
  return ops;
}

function implementedOperations(): Set<string> {
  const ops = new Set<string>();
  for (const file of findRouteFiles(API_DIR)) {
    for (const method of exportedMethods(file)) {
      ops.add(`${method} ${routePath(file)}`);
    }
  }
  return ops;
}

function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

function resolveRef(ref: string): unknown {
  let node: unknown = spec;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  return node;
}

describe('api-spec/openapi.yaml', () => {
  it('is an OpenAPI 3.1 document', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it('documents every implemented route handler', () => {
    const missing = [...implementedOperations()].filter((op) => !describedOperations().has(op));
    expect(missing).toEqual([]);
  });

  it('documents no operation that has no route handler', () => {
    const phantom = [...describedOperations()].filter((op) => !implementedOperations().has(op));
    expect(phantom).toEqual([]);
  });

  it('finds the routes it is meant to guard (the scan is not vacuous)', () => {
    expect(implementedOperations().size).toBeGreaterThanOrEqual(18);
    expect(implementedOperations()).toContain('post /api/listings/{id}/purchase');
    expect(implementedOperations()).toContain('patch /api/seller/settings');
  });

  it('resolves every $ref', () => {
    const unresolved = collectRefs(spec).filter((ref) => resolveRef(ref) === undefined);
    expect(unresolved).toEqual([]);
  });

  it('gives every operation a unique operationId and at least one response', () => {
    const ids: string[] = [];
    for (const item of Object.values(spec.paths)) {
      for (const method of HTTP_METHODS) {
        const op = (item as Record<string, Operation | undefined>)[method];
        if (!op) continue;
        expect(op.operationId, 'operationId').toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length).toBeGreaterThan(0);
        ids.push(op.operationId as string);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only references declared security schemes', () => {
    const declared = new Set(Object.keys(spec.components.securitySchemes));
    for (const item of Object.values(spec.paths)) {
      for (const method of HTTP_METHODS) {
        const op = (item as Record<string, Operation | undefined>)[method];
        for (const requirement of op?.security ?? []) {
          for (const scheme of Object.keys(requirement)) {
            expect(declared.has(scheme), scheme).toBe(true);
          }
        }
      }
    }
  });

  it('offers app-token auth on every user-authenticated route', () => {
    const userRoutes = [
      'post /api/listings',
      'patch /api/listings/{id}',
      'delete /api/listings/{id}',
      'get /api/my/listings',
      'get /api/seller/settings',
      'patch /api/seller/settings',
    ];
    for (const key of userRoutes) {
      const [method, path] = key.split(' ');
      const op = (spec.paths[path] as Record<string, Operation>)[method];
      const schemes = (op.security ?? []).flatMap((r) => Object.keys(r));
      expect(schemes, key).toContain('bearerAuth');
    }
  });
});

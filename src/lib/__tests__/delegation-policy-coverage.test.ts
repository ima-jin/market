import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DELEGATION_EXCEPTIONS, DELEGATION_ROUTES } from '@/lib/delegation-policy';

const ROOT = resolve(__dirname, '../../..');
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routes(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

/** Includes function declarations, wrappers, SDK handlers, and named re-exports. */
function exportedMutations(file: string, text = readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const handlers: { method: string; path: string; source: string }[] = [];
  const path = `/${relative(join(ROOT, 'app'), file).replaceAll('\\', '/').slice(0, -'/route.ts'.length)}`;
  function add(method: string, node: ts.Node) {
    if (MUTATIONS.has(method)) handlers.push({ method, path, source: node.getText(source) });
  }
  for (const node of source.statements) {
    // An opaque export cannot silently hide mutating handlers.
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause) throw new Error(`Explicit route exports required: ${file}`);
      if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) add(element.name.text, node);
      }
    }
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration);
      }
    }
  }
  return handlers;
}

const handlers = routes(join(ROOT, 'app')).flatMap((file) => exportedMutations(file));
const inventory = [...Object.values(DELEGATION_ROUTES), ...DELEGATION_EXCEPTIONS];
const signature = (entry: { method: string; path: string }) => `${entry.method} ${entry.path}`;

describe('delegation mutation coverage (#28)', () => {
  it('discovers all current mutating exports', () => {
    expect(handlers).toHaveLength(8);
  });

  it.each(handlers)('$method $path has exactly one classification or documented exception', (handler) => {
    expect(inventory.filter((entry) => signature(entry) === signature(handler))).toHaveLength(1);
  });

  it.each(inventory)('$method $path points at exactly one real exported handler', (entry) => {
    expect(entry.why.length).toBeGreaterThan(10);
    expect(handlers.filter((handler) => signature(handler) === signature(entry))).toHaveLength(1);
  });

  it.each(Object.values(DELEGATION_ROUTES))('$method $path reaches the central auth policy', (entry) => {
    const handler = handlers.find((candidate) => signature(candidate) === signature(entry));
    if (entry.class === 'reversible' && entry.action === 'checkout') {
      expect(handler?.source).toContain('await resolveBuyer(request, listing.sellerTier)');
      const purchase = readFileSync(join(ROOT, 'app/api/listings/[id]/purchase/route.ts'), 'utf8');
      expect(purchase).toContain('await authenticate(request)');
      expect(purchase).toContain('await authenticateOptional(request)');
    } else {
      expect(handler?.source).toContain('await authenticate(request)');
      expect(handler?.source).toContain('return authErrorResponse(authResult)');
    }
  });

  it('connects the common boundary before returning authenticated authority', () => {
    const auth = readFileSync(join(ROOT, 'src/lib/auth/authenticate.ts'), 'utf8');
    expect(auth).toContain('evaluateMarketDelegationPolicy(request, { id: result.auth.did, actingFor: result.auth.actingFor })');
    expect(auth.indexOf('const decision = evaluateMarketDelegationPolicy')).toBeLessThan(auth.indexOf('return { auth: result.auth }'));
  });

  it('discovers mutations regardless of declaration syntax', () => {
    const text = 'export async function POST() {} export const PUT = wrap(); export { handler as PATCH }; export { DELETE } from "./other";';
    expect(exportedMutations(join(ROOT, 'app/api/example/route.ts'), text).map((entry) => entry.method)).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
    expect(() => exportedMutations('route.ts', 'export * from "./other";')).toThrow('Explicit route exports required');
  });
});

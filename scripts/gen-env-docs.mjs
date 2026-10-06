#!/usr/bin/env node
/**
 * Regenerates docs/ENVIRONMENTS.md from scripts/lib/env-manifest.mjs and the
 * .env.dev.example / .env.prod.example files:  node scripts/gen-env-docs.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderEnvDocs } from './lib/env-docs-render.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => readFileSync(`${root}${name}`, 'utf8');

writeFileSync(
  `${root}docs/ENVIRONMENTS.md`,
  renderEnvDocs({ devExample: read('.env.dev.example'), prodExample: read('.env.prod.example') }),
);
console.log('Wrote docs/ENVIRONMENTS.md');

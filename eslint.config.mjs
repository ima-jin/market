import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // Listing images are user-supplied URLs on arbitrary hosts (or the media
      // service's CDN); next/image can only optimize an allow-listed set of
      // hosts, so plain <img> is deliberate here, as it was in the kernel app.
      '@next/next/no-img-element': 'off',
    },
  },
  {
    ignores: ['migrations/**', '.next/**', 'node_modules/**', 'next-env.d.ts', 'coverage/**'],
  },
];

export default eslintConfig;

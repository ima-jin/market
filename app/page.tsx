import { withBasePath } from '@/lib/base-path';

export default function HomePage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold text-white">Imajin App Template</h1>
      <p className="mt-4 text-gray-400">
        A working, forkable Next.js app that composes the Imajin platform through its public
        app surface only. See <code>AGENTS.md</code> and <code>docs/</code> before building on
        this template.
      </p>
      <ul className="mt-6 space-y-2 text-sm">
        <li>
          <a className="text-amber-400 hover:underline" href={withBasePath('/api/health')}>
            /api/health
          </a>
        </li>
        <li>
          <a className="text-amber-400 hover:underline" href={withBasePath('/api/spec')}>
            /api/spec
          </a>
        </li>
        <li>
          <a className="text-amber-400 hover:underline" href={withBasePath('/api/me')}>
            /api/me
          </a>{' '}
          — returns your DID once signed in
        </li>
      </ul>
    </div>
  );
}

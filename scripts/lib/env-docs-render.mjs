/**
 * Renders docs/ENVIRONMENTS.md from the env manifest and the two deployment
 * example files, so the doc cannot drift from the contract
 * (scripts/__tests__/env-docs.test.ts compares the committed file against this
 * output). Regenerate with: node scripts/gen-env-docs.mjs
 */
import { ENV_VARS } from './env-manifest.mjs';

const GROUPS = [
  ['Required on every deployed instance', ['required']],
  ['First boot only', ['first-boot']],
  ['Optional', ['optional']],
  ['Forbidden', ['forbidden']],
  ['Set by Next.js / pm2 (never in the env file)', ['runtime-set']],
  ['Read by dependencies on paths market does not use (leave unset)', ['dependency']],
  ['In the app template but unused here (safe to omit)', ['template-unused']],
];

const INTRO = `# Environments — market

Every environment variable the market app reads — directly, through its \`@ima-jin/*\` dependencies, or in its
scripts — with what it does, when it is read, and its dev and prod values. This file, \`.env.example\`, and
\`scripts/lib/env-manifest.mjs\` are kept in lock-step by \`scripts/__tests__/env-docs.test.ts\`: CI fails if code
(or an installed \`@ima-jin/*\` package) starts reading a variable that is not documented here, or if this file is
not the output of \`node scripts/gen-env-docs.mjs\`.

No secret values live in this repo. Examples are shape-only placeholders; real values live in the untracked
\`.env.local\` on each host. Key material is never an env var: this app's signing key is fetched at boot through the
kernel claim flow ([REGISTRATION.md](./REGISTRATION.md)).

## The env files

| File | Used for | Lands at |
|---|---|---|
| \`.env.example\` | local development (\`pnpm dev\`) | \`.env.local\` in your working copy |
| \`.env.dev.example\` | the dev deployment (\`dev-market\`, port 3104, \`https://dev-jin.imajin.ai/market\`) | \`~/dev/market/.env.local\` |
| \`.env.prod.example\` | the prod deployment (\`prod-market\`, port 7104, \`https://jin.imajin.ai/market\`) | \`~/prod/market/.env.local\` |

On a server: \`cp .env.<env>.example .env.local && chmod 600 .env.local\`, fill the placeholders, then
\`node scripts/check-env.mjs <prod|dev>\`. \`scripts/deploy.sh\` runs that check for you on every deploy, and pm2 loads
the same file with \`node --env-file\` (see \`ecosystem.config.cjs\`). The check prints variable names only, never values.

## Build-time vs runtime

\`next build\` bakes every \`NEXT_PUBLIC_*\` value into the build (including \`next.config.js\`'s \`basePath\` and the
\`/dashboard\` redirect). **Changing one means rebuilding** — \`scripts/deploy.sh\` loads the env file for the build, so
a normal deploy handles it. Variables marked *runtime* are read when the process starts or per request; a
\`pm2 restart --update-env\` is enough.

## Dev vs prod at a glance

- **Kernel host.** Dev talks only to \`https://dev-jin.imajin.ai\`; prod only to \`https://jin.imajin.ai\`.
  \`check-env.mjs\` rejects a dev file pointing at a non-\`dev-\` host and a prod file pointing at a \`dev-\` host.
- **\`IMAJIN_ENV\` and \`NEXT_PUBLIC_SERVICE_PREFIX\`.** \`dev\` / \`dev-\` on dev, **unset** on prod. A production build is
  \`NODE_ENV=production\` on both, so these are what tell dev from prod.
- **Database.** Separate Postgres database per environment; the schema name is \`market\` in both.
- **Identity.** Each environment has its own app DID, claim code and keystore file (\`IMAJIN_APP_KEYSTORE\`).
- **Secrets.** \`SESSION_SECRET\` and \`WEBHOOK_SECRET\` differ per environment.
- **Port.** dev 3104, prod 7104 (from \`ecosystem.config.cjs\`, not the env file).
`;

const escapePipes = (text) => text.replaceAll('|', String.raw`\|`);

const cell = (value) => (value.startsWith('(') ? value : `\`${escapePipes(value)}\``);

function renderGroup([title, statuses]) {
  const rows = ENV_VARS.filter((variable) => statuses.includes(variable.status));
  if (rows.length === 0) return '';
  const lines = rows.map((variable) => {
    const secret = variable.secret ? ' (secret)' : '';
    const summary = escapePipes(variable.summary);
    return `| \`${variable.name}\`${secret} | ${variable.phase} | ${cell(variable.dev)} | ${cell(variable.prod)} | ${summary} |`;
  });
  return `\n## ${title}\n\n| Variable | When | Dev | Prod | Notes |\n|---|---|---|---|---|\n${lines.join('\n')}\n`;
}

/**
 * @param {{ devExample: string, prodExample: string }} files contents of .env.dev.example / .env.prod.example
 */
export function renderEnvDocs({ devExample, prodExample }) {
  const fence = '```';
  return (
    INTRO +
    GROUPS.map(renderGroup).join('') +
    `\n## Dev example\n\n${fence}dotenv\n${devExample.trim()}\n${fence}\n` +
    `\n## Prod example\n\n${fence}dotenv\n${prodExample.trim()}\n${fence}\n`
  );
}

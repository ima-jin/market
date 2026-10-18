import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('@ima-jin/auth-client');
// Resolve the SDK's published crypto dependency without reaching into kernel code.
const sdkRequire = createRequire(require.resolve('@ima-jin/auth-client'));
const { deriveXKeypairFromEd25519, sealSecret, wrapFieldKey } = sdkRequire('@ima-jin/vault-core');

/** Test-only kernel; no real claim codes or signing material are accepted or returned. */
export function createClaimKernel(getMode = () => 'initial') {
  let bootstrapPublicKey;
  const sender = deriveXKeypairFromEd25519(sdk.generateBootstrapKeypair().privateKey, 'FAKE_TEST_ONLY_SENDER');
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/profile/api/profile/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        did: 'did:imajin:user-test', displayName: 'Test user', handle: 'test-user',
      }));
      return;
    }
    const paths = ['/api/apps/claim', '/api/apps/signing-key/fetch', '/api/apps/secrets/fetch'];
    if (request.method !== 'POST' || !paths.includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk.toString(); });
    request.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      if (request.url === '/api/apps/claim') {
        if (parsed.claimCode !== 'FAKE_BROWSER_CLAIM_CODE') {
          response.writeHead(400).end();
          return;
        }
        bootstrapPublicKey = parsed.bootstrapPublicKey;
      }
      if (request.url === '/api/apps/secrets/fetch') {
        const mode = getMode();
        if (mode === 'unreachable') {
          response.writeHead(503).end('FAKE_TEST_ONLY_PROVIDER_ERROR_MUST_NOT_LEAK');
          return;
        }
        const publicKey = createPublicKey({
          key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(bootstrapPublicKey, 'hex')]),
          format: 'der', type: 'spki',
        });
        if (!verify(null, Buffer.from(sdk.canonicalizeAppSecretFetchPayload(parsed)),
          publicKey, Buffer.from(parsed.signature, 'hex'))) {
          response.writeHead(403).end();
          return;
        }
        const name = parsed.keys[0];
        const values = {};
        const missing = [];
        if ((mode === 'missing' && name === 'DATABASE_URL')
          || (mode === 'missing-session' && name === 'SESSION_SECRET')) {
          missing.push(name);
        } else if (name === 'DATABASE_URL') {
          // No password, real host, or real database; postgres never executes a query.
          values[name] = 'postgres://localhost/FAKE_TEST_ONLY_DATABASE';
        } else {
          values[name] = mode === 'rotated'
            ? 'FAKE_TEST_ONLY_ROTATED_SESSION_MATERIAL'
            : 'FAKE_TEST_ONLY_VAULT_SESSION_MATERIAL';
        }
        const key = randomBytes(32);
        const envelope = {
          version: 1,
          senderXPub: sender.publicKey,
          wrappedKey: wrapFieldKey(key, parsed.recipientXPub, sender.privateKey),
          sealed: sealSecret(JSON.stringify({
            domain: parsed.domain, appDid: parsed.appDid, nonce: parsed.nonce,
            keys: parsed.keys, values, missing,
          }), key),
        };
        key.fill(0);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(envelope));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        appDid: 'did:imajin:app-under-test',
        privateKey: 'FAKE_TEST_SIGNING_PRIVATE_KEY',
        publicKey: 'FAKE_TEST_SIGNING_PUBLIC_KEY',
      }));
    });
  });
}

// Optional local fixture for inspecting the production claim form in a browser.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createClaimKernel().listen(4901, '127.0.0.1');
}

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/** Test-only kernel; no real claim codes or signing material are accepted or returned. */
export function createClaimKernel() {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url.startsWith('/profile/api/profile/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        did: 'did:imajin:user-test', displayName: 'Test user', handle: 'test-user',
      }));
      return;
    }
    const paths = ['/api/apps/claim', '/api/apps/signing-key/fetch'];
    if (request.method !== 'POST' || !paths.includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk.toString(); });
    request.on('end', () => {
      if (request.url === '/api/apps/claim') {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        if (parsed.claimCode !== 'FAKE_BROWSER_CLAIM_CODE') {
          response.writeHead(400).end();
          return;
        }
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

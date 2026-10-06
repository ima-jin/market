'use client';

import { useState, type FormEvent } from 'react';
import { withBasePath } from '@/lib/base-path';

/**
 * Operator-facing claim page (#2427) — closes the loop the kernel's `/jin`
 * approval card opens: paste the one-time claim code here instead of
 * ssh-ing in to edit an env file. Only reachable while this app is
 * unclaimed; `middleware.ts` 404s this route once the claim succeeds.
 *
 * No client-side "which app is this" confirmation field: `/api/claim`
 * itself verifies the kernel-returned `appDid` against this app's own
 * `IMAJIN_APP_DID` and refuses (409) a code issued for a different app
 * before ever adopting it — see `src/lib/signing-identity.ts`'s
 * `claimWithCode()`. A browser-only check couldn't run until after the
 * (single-use) code was already spent, so it added no real protection.
 */

interface ClaimResult {
  appDid: string;
  publicKey: string | null;
}

type ClaimFormState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }
  | { status: 'success'; result: ClaimResult };

interface ClaimResponseBody {
  appDid?: unknown;
  publicKey?: unknown;
  error?: unknown;
}

function parseClaimResult(body: ClaimResponseBody): ClaimResult | null {
  if (typeof body.appDid !== 'string') {
    return null;
  }
  return { appDid: body.appDid, publicKey: typeof body.publicKey === 'string' ? body.publicKey : null };
}

function errorMessageFrom(body: ClaimResponseBody): string {
  return typeof body.error === 'string' ? body.error : 'Unable to claim this app';
}

export default function ClaimPage() {
  const [claimCode, setClaimCode] = useState('');
  const [formState, setFormState] = useState<ClaimFormState>({ status: 'idle' });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormState({ status: 'submitting' });

    let response: Response;
    try {
      response = await fetch(withBasePath('/api/claim'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimCode }),
      });
    } catch {
      setFormState({ status: 'error', message: 'Could not reach this app — try again' });
      return;
    }

    const body = (await response.json().catch(() => ({}))) as ClaimResponseBody;
    const result = response.ok ? parseClaimResult(body) : null;

    if (!result) {
      setFormState({ status: 'error', message: errorMessageFrom(body) });
      return;
    }

    setFormState({ status: 'success', result });
  }

  if (formState.status === 'success') {
    return <ClaimSuccessView result={formState.result} />;
  }

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-semibold text-white">Claim this app</h1>
      <p className="mt-2 text-sm text-gray-400">
        Paste the one-time claim code from the kernel operator&apos;s <code>/jin</code> approval card to finish
        provisioning this app&apos;s signing identity.
      </p>
      <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="claimCode" className="block text-sm font-medium text-gray-300">
            Claim code
          </label>
          <input
            id="claimCode"
            name="claimCode"
            type="text"
            autoComplete="off"
            required
            value={claimCode}
            onChange={(event) => setClaimCode(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-white"
          />
        </div>
        {formState.status === 'error' && <p className="text-sm text-red-400">{formState.message}</p>}
        <button
          type="submit"
          disabled={formState.status === 'submitting'}
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-gray-950 disabled:opacity-50"
        >
          {formState.status === 'submitting' ? 'Claiming…' : 'Claim app'}
        </button>
      </form>
    </div>
  );
}

function ClaimSuccessView({ result }: Readonly<{ result: ClaimResult }>) {
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-semibold text-white">App claimed</h1>
      <p className="mt-2 text-sm text-gray-400">
        This app&apos;s signing identity is now active. The claim code has been spent and cannot be reused.
      </p>
      <dl className="mt-6 space-y-2 text-sm">
        <div>
          <dt className="text-gray-500">App DID</dt>
          <dd className="break-all text-white">{result.appDid}</dd>
        </div>
        {result.publicKey !== null && (
          <div>
            <dt className="text-gray-500">Public key</dt>
            <dd className="break-all text-white">{result.publicKey}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

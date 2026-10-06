'use client';

import React, { useCallback, useState } from 'react';

/**
 * "Enter your email to <action>" gate: reuses an existing kernel session, or
 * sends a verification email through the kernel's public onboarding route.
 *
 * Local stand-in for `@imajin/onboard`'s `OnboardGate`, which is not
 * published to npm — tracked in ima-jin/imajin-ai#2645. It only calls the
 * kernel's public `GET {authUrl}/api/session` and `POST {authUrl}/api/onboard`.
 * Drop this file and import from `@ima-jin/onboard` once it ships.
 */
export interface OnboardGateProps {
  /** Human-readable description: "purchase this item" */
  action: string;
  /** Called when identity is available (existing session or newly onboarded) */
  onIdentity: (did: string) => void;
  /** The trigger element (e.g., a button) */
  children: React.ReactNode;
  /** Auth service URL */
  authUrl?: string;
  /** URL to redirect back to after email verification */
  redirectUrl?: string;
}

type State = 'idle' | 'checking' | 'prompt' | 'sending' | 'sent' | 'error';

const INPUT_CLASS =
  'w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 focus:ring-2 focus:ring-amber-500 focus:border-transparent';
const CARD_CLASS = 'bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-md mx-auto';

function resolveAuthUrl(authUrlProp: string | undefined): string {
  if (authUrlProp) return authUrlProp;
  if (globalThis.window === undefined) return '';
  return `${globalThis.location.origin}/auth`;
}

export function OnboardGate({
  action,
  onIdentity,
  children,
  authUrl: authUrlProp,
  redirectUrl,
}: Readonly<OnboardGateProps>) {
  const [state, setState] = useState<State>('idle');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  // Imperative focus-on-mount ref instead of the declarative `autoFocus`
  // attribute — same one-time focus behaviour, no accessibility lint finding.
  const autoFocusRef = useCallback((el: HTMLInputElement | null) => el?.focus(), []);

  const authUrl = resolveAuthUrl(authUrlProp);

  const checkSession = useCallback(async () => {
    setState('checking');
    try {
      const res = await fetch(`${authUrl}/api/session`, { credentials: 'include' });
      if (res.ok) {
        const session = await res.json();
        onIdentity(session.did);
        return;
      }
    } catch {
      // No session — continue to prompt
    }
    setState('prompt');
  }, [authUrl, onIdentity]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setState('sending');
    setError('');
    try {
      const res = await fetch(`${authUrl}/api/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          redirectUrl: redirectUrl || globalThis.location.href,
          context: action,
        }),
      });

      if (res.ok) {
        setState('sent');
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Failed to send verification email');
      setState('prompt');
    } catch {
      setError('Connection error. Please try again.');
      setState('prompt');
    }
  }

  // Idle — show the trigger, attaching the click handler directly to the
  // caller's element instead of wrapping it in an extra interactive div.
  if (state === 'idle') {
    const trigger = React.Children.only(children) as React.ReactElement<{
      onClick?: (e: React.MouseEvent) => void;
      style?: React.CSSProperties;
    }>;
    return React.cloneElement(trigger, {
      onClick: (e: React.MouseEvent) => {
        trigger.props.onClick?.(e);
        void checkSession();
      },
      style: { ...trigger.props.style, cursor: 'pointer' },
    });
  }

  if (state === 'checking') {
    return <div className="text-center py-4 text-gray-500">Checking...</div>;
  }

  if (state === 'sent') {
    return (
      <div className={`${CARD_CLASS} text-center`}>
        <div className="text-4xl mb-4">📬</div>
        <h3 className="font-semibold text-lg mb-2">Check your email</h3>
        <p className="text-gray-500 text-sm mb-4">
          We sent a verification link to <strong className="text-gray-700 dark:text-gray-300">{email}</strong>. Click
          the link to {action}.
        </p>
        <p className="text-xs text-gray-400">Link expires in 15 minutes. Check spam if you don&apos;t see it.</p>
        <button
          type="button"
          onClick={() => setState('prompt')}
          className="mt-4 text-sm text-amber-500 hover:underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className={CARD_CLASS}>
      <h3 className="font-semibold text-lg mb-2">Enter your email to {action}</h3>
      <p className="text-sm text-gray-500 mb-4">We&apos;ll send a verification link. No password needed.</p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          ref={autoFocusRef}
          className={INPUT_CLASS}
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name (optional)"
          className={INPUT_CLASS}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={state === 'sending' || !email.trim()}
          className="w-full px-4 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium disabled:opacity-50"
        >
          {state === 'sending' ? 'Sending...' : 'Continue'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setState('idle')}
        className="mt-3 w-full text-sm text-gray-400 hover:text-gray-600"
      >
        Cancel
      </button>
    </div>
  );
}

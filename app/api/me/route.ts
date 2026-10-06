import { getSession } from '@ima-jin/auth-client';
import { NextResponse } from 'next/server';
import { authConfig } from '@/lib/auth-config';

/**
 * Example authenticated route: verifies the caller's Imajin session via the
 * published @ima-jin/auth-client SDK (never hand-rolled JWT code) and
 * returns their DID.
 */
export async function GET() {
  const user = await getSession(authConfig);

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  return NextResponse.json({ did: user.did });
}

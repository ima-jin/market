import { NextResponse } from 'next/server';
import { isAppClaimed } from '@/lib/signing-identity';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'market',
    timestamp: new Date().toISOString(),
    // Unclaimed boot mode (#2427): false until an operator pastes a claim
    // code at /claim (or IMAJIN_APP_CLAIM_CODE resolves it at boot).
    claimed: isAppClaimed(),
  });
}

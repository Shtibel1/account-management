import { NextResponse } from 'next/server';
import { readDb, writeDb } from '@/utils/supabase/mockDb';
import { isMockMode } from '@/lib/supabaseConfig';

export const dynamic = 'force-dynamic';

// Backing store of the browser mock client. Exists only in local mock mode (no Supabase env, not
// production); otherwise it would be an unauthenticated read/write endpoint.
function unavailable() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function GET() {
  if (!isMockMode()) return unavailable();
  const data = await readDb();
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  if (!isMockMode()) return unavailable();
  try {
    const body = await req.json();
    await writeDb(body);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

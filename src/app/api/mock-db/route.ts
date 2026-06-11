import { NextResponse } from 'next/server';
import { readDb, writeDb } from '@/utils/supabase/mockDb';

export async function GET() {
  const data = await readDb();
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    await writeDb(body);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

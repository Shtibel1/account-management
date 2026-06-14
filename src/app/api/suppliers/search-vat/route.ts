import { NextResponse } from 'next/server';
import { searchVatIdByName } from '@/utils/businessLookup';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');

  if (!name) {
    return NextResponse.json({ error: 'Missing supplier name parameter' }, { status: 400 });
  }

  try {
    const vatId = await searchVatIdByName(name);
    return NextResponse.json({ vatId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

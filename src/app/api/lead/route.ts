import { NextRequest, NextResponse } from 'next/server';
import { escapeHtml, sendEmail } from '@/lib/email';

const CONTACT_TO = process.env.CONTACT_TO_EMAIL || process.env.CONTACT_TO || process.env.CONTACT_EMAIL || 'nadavshtibel@gmail.com';
const CONTACT_FROM = process.env.CONTACT_FROM_EMAIL || process.env.CONTACT_FROM || 'contact@nadav-shtibel.com';

interface LeadData {
  name: string;
  contact: string;
  scanTypes: string[];
  volume: string;
  notes: string;
}

function formatLeadEmail(data: LeadData): { subject: string; textBody: string; htmlBody: string } {
  const scanTypesMap: Record<string, string> = {
    photos: 'תמונות ואלבומים',
    documents: 'מסמכים',
    invoices: 'חשבוניות וקבלות',
  };

  const scanTypesText = data.scanTypes.length > 0
    ? data.scanTypes.map(t => scanTypesMap[t] || t).join(', ')
    : 'לא צוין';

  const subject = `[סריקה בעברית] פנייה חדשה מ-${data.name}`;

  const textBody = `
פנייה חדשה מאתר סריקה בעברית
================================

שם: ${data.name}
פרטי קשר: ${data.contact}
סוג סריקה: ${scanTypesText}
כמות משוערת: ${data.volume || 'לא צוין'}
הערות: ${data.notes || 'אין'}

---
הודעה זו נשלחה אוטומטית מטופס ההזמנה באתר.
  `.trim();

  const htmlBody = `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Heebo', Arial, sans-serif; line-height: 1.6; color: #1c1917; background: #f5f5f4; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { color: #2563eb; margin-top: 0; font-size: 24px; }
    .field { margin-bottom: 16px; }
    .label { font-weight: 600; color: #57534e; font-size: 14px; }
    .value { margin-top: 4px; }
    .divider { border-top: 1px solid #e7e5e4; margin: 24px 0; }
    .footer { color: #a8a29e; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>פנייה חדשה מאתר סריקה בעברית</h1>
    
    <div class="field">
      <div class="label">שם</div>
      <div class="value">${escapeHtml(data.name)}</div>
    </div>
    
    <div class="field">
      <div class="label">פרטי קשר</div>
      <div class="value">${escapeHtml(data.contact)}</div>
    </div>
    
    <div class="field">
      <div class="label">סוג סריקה</div>
      <div class="value">${escapeHtml(scanTypesText)}</div>
    </div>
    
    <div class="field">
      <div class="label">כמות משוערת</div>
      <div class="value">${escapeHtml(data.volume || 'לא צוין')}</div>
    </div>
    
    <div class="field">
      <div class="label">הערות</div>
      <div class="value">${escapeHtml(data.notes || 'אין')}</div>
    </div>
    
    <div class="divider"></div>
    <div class="footer">הודעה זו נשלחה אוטומטית מטופס ההזמנה באתר.</div>
  </div>
</body>
</html>
  `.trim();

  return { subject, textBody, htmlBody };
}

async function sendViaSES(data: LeadData): Promise<void> {
  const { subject, textBody, htmlBody } = formatLeadEmail(data);
  await sendEmail({ from: CONTACT_FROM, to: [CONTACT_TO], subject, textBody, htmlBody });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { name, contact, scanTypes, volume, notes } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'שם הוא שדה חובה' }, { status: 400 });
    }

    if (!contact || typeof contact !== 'string' || contact.trim().length === 0) {
      return NextResponse.json({ error: 'פרטי קשר הם שדה חובה' }, { status: 400 });
    }

    const leadData: LeadData = {
      name: name.trim(),
      contact: contact.trim(),
      scanTypes: Array.isArray(scanTypes) ? scanTypes : [],
      volume: typeof volume === 'string' ? volume.trim() : '',
      notes: typeof notes === 'string' ? notes.trim() : '',
    };

    await sendViaSES(leadData);
    console.log(`[Lead] Sent via SES to ${CONTACT_TO}: ${leadData.name}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Lead] Error processing lead:', error);
    return NextResponse.json(
      { error: 'שגיאה בשליחת הפנייה. נסו שוב או פנו אלינו ישירות.' },
      { status: 500 }
    );
  }
}

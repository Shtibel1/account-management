import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

/**
 * SERVER-ONLY outgoing email via AWS SES (used by /api/lead and the client notifications of the
 * accountant review loop). Credentials come from the standard AWS environment / Amplify role.
 */

export const AWS_REGION = process.env.AWS_REGION || 'eu-west-1';

export interface OutgoingEmail {
  from: string;
  to: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  replyTo?: string[];
}

let sesClient: SESClient | null = null;

function client(): SESClient {
  if (!sesClient) sesClient = new SESClient({ region: AWS_REGION });
  return sesClient;
}

/** Sends one email; returns the SES message id. Throws on failure. */
export async function sendEmail(email: OutgoingEmail): Promise<string | null> {
  if (!AWS_REGION) throw new Error('AWS_REGION not configured');
  const command = new SendEmailCommand({
    Source: email.from,
    Destination: { ToAddresses: email.to },
    ReplyToAddresses: email.replyTo,
    Message: {
      Subject: { Data: email.subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: email.textBody, Charset: 'UTF-8' },
        ...(email.htmlBody ? { Html: { Data: email.htmlBody, Charset: 'UTF-8' } } : {}),
      },
    },
  });
  const result = await client().send(command);
  return result.MessageId ?? null;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

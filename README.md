# סריקה בעברית (Hebrew Scanning Services)

Public-facing Hebrew document and photo scanning service.

## Product

**סריקה בעברית** offers Hebrew-only image and document scanning services:
- Photo and album digitization
- Document and invoice scanning
- Hebrew OCR (Optical Character Recognition)

The public site allows visitors to learn about the service and submit lead requests.

## URLs

- `/` — Marketing home page (Hebrew RTL)
- `/order` — Lead capture form
- `/privacy` — Privacy policy

## Internal Dashboard

The invoice processing dashboard remains available at:
- `/clients` — Client management
- `/upload` — Invoice upload
- `/review` — Review and approval
- `/mappings` — Account mappings

## Deployment

Hosted on AWS Amplify (app `d1qccb7exs3uyj`). Uses Next.js with `WEB_COMPUTE` platform.

### Environment Variables

**Required for dashboard functionality:**
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`
- `GOOGLE_CLOUD_API_KEY`
- `ANTHROPIC_API_KEY`

**Optional for lead form email delivery (SES):**
- `AWS_REGION` — AWS region for SES (e.g., `eu-west-1`)
- `CONTACT_EMAIL` — Recipient email (default: `contact@nadav-shtibel.com`)
- `CONTACT_FROM` — Sender email (default: `contact@nadav-shtibel.com`)

If `AWS_REGION` is not set, lead submissions are logged to console instead of emailed.

## Development

```bash
npm install
npm run dev    # http://localhost:3001
npm run build  # Production build
```

## Notes

- No custom DNS configuration in this repository
- No pricing, testimonials, or fake metrics on the public site
- No checkout/payment functionality

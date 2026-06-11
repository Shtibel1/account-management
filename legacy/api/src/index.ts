import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { invoiceRoutes } from './routes/invoices.js';
import { exportRoutes } from './routes/export.js';

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const app = Fastify({ logger: true });

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : ['http://localhost:3000'];

await app.register(cors, { origin: allowedOrigins });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

await app.register(invoiceRoutes, { prefix: '/api' });
await app.register(exportRoutes,  { prefix: '/api' });

app.get('/health', async () => ({ ok: true }));

const port = parseInt(process.env.PORT ?? '3001');
await app.listen({ port, host: '0.0.0.0' });
console.log(`API running on http://localhost:${port}`);

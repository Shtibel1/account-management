import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { invoiceRoutes } from './routes/invoices.js';
import { exportRoutes } from './routes/export.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: 'http://localhost:3000' });
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

await app.register(invoiceRoutes, { prefix: '/api' });
await app.register(exportRoutes,  { prefix: '/api' });

app.get('/health', async () => ({ ok: true }));

const port = parseInt(process.env.PORT ?? '3001');
await app.listen({ port, host: '0.0.0.0' });
console.log(`API running on http://localhost:${port}`);

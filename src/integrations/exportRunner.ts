import type { AccountMapping, Invoice } from '@/shared/types';
import type {
  ExportInvoice,
  ExportPlugin,
  InvoiceExportRecord,
  InvoiceMapping,
  PluginContext,
} from '@/integrations/types';
import type { ExportStore } from '@/integrations/store';
import type { HttpRequestOptions, IntegrationHttpClient } from '@/integrations/types';
import { IntegrationHttpError } from '@/integrations/http';
import { writeMayHaveBeenProcessed } from '@/integrations/retry';
import { decideAfterLookup, decideExport, DECISION_MESSAGES } from '@/integrations/idempotency';
import { resolveInvoiceMapping, toExportInvoice } from '@/integrations/mapping';
import { redactDeep, scrubString, type RedactionOptions } from '@/integrations/redact';

/**
 * One export run: a set of invoices of ONE client (already access-checked by the route) to one plugin.
 * Every invoice gets an outcome; failures of one invoice never stop the others.
 */

export type InvoiceOutcomeStatus = 'success' | 'failed' | 'skipped' | 'blocked' | 'dry_run';

export interface InvoiceExportOutcome {
  invoiceId: string;
  status: InvoiceOutcomeStatus;
  reason?: string;
  message?: string;
  externalId?: string | null;
  url?: string | null;
  /** The document already existed in the target (findExisting) and was linked instead of re-created. */
  adopted?: boolean;
  /** Dry runs: the payload that would have been sent (redacted). */
  payload?: unknown;
}

export interface RunExportResult {
  correlationId: string;
  pluginId: string;
  dryRun: boolean;
  results: InvoiceExportOutcome[];
  summary: Record<InvoiceOutcomeStatus, number>;
  file?: { fileName: string; contentType: string; base64: string };
}

export interface RunExportInput {
  plugin: ExportPlugin;
  ctx: PluginContext<unknown>;
  invoices: Invoice[];
  accountMappings: AccountMapping[];
  vatAccount: string;
  store: ExportStore;
  dryRun: boolean;
  /** Re-send invoices whose earlier attempt is uncertain (stale pending, no findExisting). */
  force: boolean;
  redaction: RedactionOptions;
  now?: () => number;
}

function errorText(err: unknown, redaction: RedactionOptions): string {
  return scrubString(err instanceof Error ? err.message : String(err), redaction.secretValues).slice(0, 2000);
}

/** Only https links from the target are kept (they are rendered as links in the UI). */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Wraps the invoice's HTTP client and remembers whether any WRITE call ended in a state where the
 * target may have created the document anyway (timeout / connection lost / 5xx). Such a failure is
 * recorded as "uncertain" so the next run checks / blocks instead of creating a duplicate.
 */
function trackUncertainWrites(http: IntegrationHttpClient): { http: IntegrationHttpClient; uncertain: () => boolean } {
  let uncertain = false;
  const wrap = (inner: IntegrationHttpClient): IntegrationHttpClient => ({
    async request<T>(req: HttpRequestOptions) {
      const isWrite = !READ_METHODS.has(String(req.method).toUpperCase());
      try {
        const res = await inner.request<T>(req);
        if (isWrite && writeMayHaveBeenProcessed({ status: res.status }) && !res.ok) uncertain = true;
        return res;
      } catch (err) {
        if (isWrite) {
          const code = err instanceof IntegrationHttpError ? err.code : null;
          if (writeMayHaveBeenProcessed({ code })) uncertain = true;
        }
        throw err;
      }
    },
    forInvoice: (id: string | null) => wrap(inner.forInvoice(id)),
  });
  return { http: wrap(http), uncertain: () => uncertain };
}

function summarize(results: InvoiceExportOutcome[]): Record<InvoiceOutcomeStatus, number> {
  const summary: Record<InvoiceOutcomeStatus, number> = { success: 0, failed: 0, skipped: 0, blocked: 0, dry_run: 0 };
  for (const r of results) summary[r.status] += 1;
  return summary;
}

interface Prepared {
  invoice: Invoice;
  exportInvoice: ExportInvoice | null;
  record: InvoiceExportRecord | null;
}

export async function runExport(input: RunExportInput): Promise<RunExportResult> {
  const { plugin, ctx, store, dryRun, redaction } = input;
  const now = input.now ?? Date.now;
  const results: InvoiceExportOutcome[] = [];

  const records = await store.getRecords(input.invoices.map((i) => i.id), plugin.id);
  const recordByInvoice = new Map(records.map((r) => [r.invoice_id, r]));
  const prepared: Prepared[] = input.invoices.map((invoice) => ({
    invoice,
    exportInvoice: toExportInvoice(invoice),
    record: recordByInvoice.get(invoice.id) ?? null,
  }));

  const hasFindExisting = plugin.kind === 'api' && typeof plugin.findExisting === 'function';
  const toExport: { p: Prepared; ei: ExportInvoice; mapping: InvoiceMapping; checkExisting: boolean }[] = [];

  // 1. Decide per invoice.
  for (const p of prepared) {
    const decision = decideExport({
      invoiceStatus: p.invoice.status,
      record: p.record,
      hasFindExisting,
      force: input.force,
      now: now(),
    });

    if (decision.action === 'skip' || decision.action === 'blocked') {
      const outcome: InvoiceExportOutcome = {
        invoiceId: p.invoice.id,
        status: decision.action === 'skip' ? 'skipped' : 'blocked',
        reason: decision.reason,
        message: DECISION_MESSAGES[decision.reason],
        ...(decision.action === 'skip' && decision.reason === 'already_exported'
          ? { externalId: decision.externalId, url: decision.url }
          : {}),
      };
      results.push(outcome);
      if (!dryRun) {
        if (decision.reason === 'not_approved') {
          await store.recordSkipped({
            invoiceId: p.invoice.id, clientId: ctx.clientId, pluginId: plugin.id,
            correlationId: ctx.correlationId, reason: DECISION_MESSAGES.not_approved,
          });
        }
        await ctx.logger.record({
          operation: 'export_decision', outcome: decision.action === 'blocked' ? 'error' : 'ok',
          invoiceId: p.invoice.id, errorCode: decision.reason, errorMessage: outcome.message ?? null,
        });
      }
      continue;
    }

    if (!p.exportInvoice) {
      results.push({ invoiceId: p.invoice.id, status: 'failed', reason: 'no_data', message: 'אין נתונים לחשבונית' });
      continue;
    }
    const mapping = resolveInvoiceMapping(p.exportInvoice, input.accountMappings, input.vatAccount);
    const problems = [...mapping.missing, ...(plugin.validateInvoice?.(p.exportInvoice, mapping) ?? [])];
    if (problems.length > 0) {
      results.push({ invoiceId: p.invoice.id, status: 'failed', reason: 'invalid', message: `לא ניתן לייצא: ${problems.join(', ')}` });
      if (!dryRun) {
        await ctx.logger.record({
          operation: 'export_validation', outcome: 'error', invoiceId: p.invoice.id,
          errorCode: 'invalid', errorMessage: problems.join(', '),
        });
      }
      continue;
    }
    toExport.push({ p, ei: p.exportInvoice, mapping, checkExisting: decision.action === 'check_existing' });
  }

  // 2a. Dry run: build what would be sent, touch nothing.
  if (dryRun) {
    let file: RunExportResult['file'];
    if (plugin.kind === 'file' && toExport.length > 0) {
      const out = plugin.buildFile(ctx, toExport.map((t) => ({ invoice: t.ei, mapping: t.mapping })));
      file = { fileName: out.fileName, contentType: out.contentType, base64: out.body.toString('base64') };
    }
    for (const t of toExport) {
      const payload = plugin.kind === 'api'
        ? redactDeep(plugin.buildPayload(ctx, t.ei, t.mapping), redaction)
        : { supplierAccount: t.mapping.supplierAccount, expenseAccount: t.mapping.expenseAccount, vatAccount: t.mapping.vatAccount };
      results.push({
        invoiceId: t.ei.id, status: 'dry_run',
        message: t.checkExisting ? 'ייבדק קודם אם המסמך כבר קיים במערכת היעד' : undefined,
        payload,
      });
    }
    return { correlationId: ctx.correlationId, pluginId: plugin.id, dryRun, results, summary: summarize(results), file };
  }

  // 2b. Claim every invoice (optimistic lock on invoice_exports) before any side effect.
  const claimed: (typeof toExport[number] & { record: InvoiceExportRecord })[] = [];
  for (const t of toExport) {
    const record = await store.claim({
      invoiceId: t.ei.id, clientId: ctx.clientId, pluginId: plugin.id,
      correlationId: ctx.correlationId, previous: t.p.record,
    });
    if (!record) {
      results.push({ invoiceId: t.ei.id, status: 'skipped', reason: 'in_progress', message: DECISION_MESSAGES.in_progress });
      continue;
    }
    claimed.push({ ...t, record });
  }

  const succeeded: string[] = [];
  let file: RunExportResult['file'];

  if (plugin.kind === 'file') {
    if (claimed.length > 0) {
      const started = now();
      try {
        const out = plugin.buildFile(ctx, claimed.map((c) => ({ invoice: c.ei, mapping: c.mapping })));
        file = { fileName: out.fileName, contentType: out.contentType, base64: out.body.toString('base64') };
        const written = new Set(out.invoiceIds);
        for (const c of claimed) {
          if (written.has(c.ei.id)) {
            const externalId = `${out.fileName}#${ctx.correlationId}`;
            await store.complete(c.record.id, { status: 'success', external_id: externalId });
            succeeded.push(c.ei.id);
            results.push({ invoiceId: c.ei.id, status: 'success', externalId });
          } else {
            await store.complete(c.record.id, { status: 'failed', last_error: 'לא נכללה בקובץ' });
            results.push({ invoiceId: c.ei.id, status: 'failed', reason: 'not_in_file', message: 'לא נכללה בקובץ' });
          }
        }
        await ctx.logger.record({
          operation: 'export_file', outcome: 'ok', durationMs: now() - started,
          details: { fileName: out.fileName, bytes: out.body.length, invoices: out.invoiceIds.length },
        });
      } catch (err) {
        const message = errorText(err, redaction);
        for (const c of claimed) {
          await store.complete(c.record.id, { status: 'failed', last_error: message });
          results.push({ invoiceId: c.ei.id, status: 'failed', reason: 'error', message });
        }
        await ctx.logger.record({ operation: 'export_file', outcome: 'error', durationMs: now() - started, errorCode: 'build_failed', errorMessage: message });
      }
    }
  } else {
    for (const c of claimed) {
      const tracked = trackUncertainWrites(ctx.http.forInvoice(c.ei.id));
      const invoiceCtx: PluginContext<unknown> = { ...ctx, http: tracked.http };
      let exported: { externalId: string; url: string | null } | null = null;
      try {
        if (c.checkExisting && plugin.findExisting) {
          const after = decideAfterLookup(await plugin.findExisting(invoiceCtx, c.ei));
          if (after.action === 'adopt') {
            after.url = safeExternalUrl(after.url);
            await store.complete(c.record.id, { status: 'success', external_id: after.externalId, external_url: after.url });
            succeeded.push(c.ei.id);
            results.push({ invoiceId: c.ei.id, status: 'success', externalId: after.externalId, url: after.url, adopted: true, message: 'המסמך כבר היה קיים במערכת היעד וקושר' });
            continue;
          }
        }
        const res = await plugin.exportInvoice(invoiceCtx, c.ei, c.mapping);
        exported = { externalId: String(res.externalId).slice(0, 500), url: safeExternalUrl(res.url) };
        await store.complete(c.record.id, { status: 'success', external_id: exported.externalId, external_url: exported.url });
        succeeded.push(c.ei.id);
        results.push({ invoiceId: c.ei.id, status: 'success', externalId: exported.externalId, url: exported.url });
      } catch (err) {
        const message = errorText(err, redaction);
        if (exported) {
          // The document WAS created; only recording it failed. Never mark it failed (a later run
          // would create a duplicate): the row stays "pending", becomes stale and is then blocked /
          // checked with findExisting.
          ctx.logger.error('export succeeded but recording the result failed', {
            invoiceId: c.ei.id, externalId: exported.externalId, error: message,
          });
          succeeded.push(c.ei.id);
          results.push({
            invoiceId: c.ei.id, status: 'success', externalId: exported.externalId, url: exported.url,
            message: 'המסמך נוצר במערכת היעד אך שמירת הסטטוס נכשלה',
          });
          continue;
        }
        const uncertain = tracked.uncertain();
        ctx.logger.error('export_invoice failed', { invoiceId: c.ei.id, error: message, uncertain });
        try {
          await store.complete(c.record.id, { status: 'failed', last_error: message, uncertain });
        } catch (storeErr) {
          console.error(`[integrations] Failed to record export failure for invoice ${c.ei.id}:`, errorText(storeErr, redaction));
        }
        results.push({
          invoiceId: c.ei.id, status: 'failed', reason: uncertain ? 'uncertain' : 'error',
          message: uncertain ? `${message} (ייתכן שהמסמך נוצר בכל זאת: בדקו במערכת היעד)` : message,
        });
      }
    }
  }

  if (succeeded.length > 0) {
    try {
      await store.markInvoicesExported(succeeded);
    } catch (err) {
      // invoice_exports already holds the truth; the invoice status is cosmetic here.
      ctx.logger.error('failed to mark invoices exported', { invoices: succeeded.length, error: errorText(err, redaction) });
    }
  }

  return { correlationId: ctx.correlationId, pluginId: plugin.id, dryRun, results, summary: summarize(results), file };
}

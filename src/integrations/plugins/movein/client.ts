import { MoveinExporter } from '@/lib/exporters/movein';
import type { MoveinInput } from '@/integrations/plugins/movein/mapping';

/** File "client": writes the Move-in .dat (Windows-1255, fixed width) with the existing exporter. */
export function writeMoveinFile(input: MoveinInput): Buffer {
  return new MoveinExporter().export(input.invoices, input.accountMappings, input.vatAccount);
}

// Client names are not unique (nothing enforces it), so client pickers would show identical
// options. clientDisplayNames() keeps a unique name as is and adds just enough detail to tell
// same-named clients apart: the VAT account code, then the creation date, then a short id.

export interface ClientLabelSource {
  id: string;
  name: string;
  vat_account?: string | null;
  created_at?: string | null;
}

const MAX_DETAIL_CHARS = 20;

function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('he');
}

function shorten(value: string): string {
  const v = value.trim().replace(/\s+/g, ' ');
  return v.length > MAX_DETAIL_CHARS ? `${v.slice(0, MAX_DETAIL_CHARS - 1)}…` : v;
}

/** dd/MM/yyyy in Israel time; null for a missing / invalid date. */
function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jerusalem' })
    .format(date)
    .replace(/\./g, '/');
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

/** id -> label shown in client pickers and lists. */
export function clientDisplayNames(clients: readonly ClientLabelSource[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const group of groupBy([...clients], (c) => nameKey(c.name)).values()) {
    if (group.length === 1) {
      labels.set(group[0].id, group[0].name);
      continue;
    }
    // Same name: each detail is added only while it still leaves two clients looking the same
    const details = new Map<string, string[]>(group.map((c) => [c.id, []]));
    const steps: ((c: ClientLabelSource) => string | null)[] = [
      (c) => (c.vat_account?.trim() ? `חשבון מע״מ ${shorten(c.vat_account)}` : null),
      (c) => {
        const d = formatDate(c.created_at);
        return d ? `נוצר ${d}` : null;
      },
    ];
    for (const step of steps) {
      const current = groupBy(group, (c) => details.get(c.id)!.join(' · '));
      if ([...current.values()].every((g) => g.length === 1)) break;
      for (const same of current.values()) {
        if (same.length < 2) continue;
        const values = same.map(step);
        // A detail that is identical for the whole colliding set adds nothing
        if (new Set(values).size === 1) continue;
        same.forEach((c, i) => {
          if (values[i]) details.get(c.id)!.push(values[i]!);
        });
      }
    }
    // Still identical (same VAT account and same creation day): the short id always differs
    const final = groupBy(group, (c) => details.get(c.id)!.join(' · '));
    for (const same of final.values()) {
      if (same.length > 1) same.forEach((c) => details.get(c.id)!.push(`#${c.id.slice(0, 6)}`));
    }
    for (const c of group) {
      const extra = details.get(c.id)!;
      labels.set(c.id, extra.length > 0 ? `${c.name.trim()} (${extra.join(' · ')})` : c.name);
    }
  }
  return labels;
}

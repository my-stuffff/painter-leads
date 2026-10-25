import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { evidence } from '../db/schema';
import type { Confidence, EvidenceStatus, Field, SourceType } from '../types';
import { normaliseValue } from './normalise-value';

export interface EvidenceDraft {
  companyId?: number | null;
  listingId?: number | null;
  registryRecordId?: number | null;
  field: Field;
  value: string;
  valueNorm?: string;
  sourceType: SourceType;
  sourceUrl: string;
  pageSha256?: string | null;
  capturedAt: Date;
  snippet: string;
  extractor: string;
  extractorVersion: string;
  confidence: Confidence;
  status?: EvidenceStatus;
  rejectReason?: string | null;
  attrs?: Record<string, unknown>;
}

export interface EvidenceRow extends EvidenceDraft {
  id: number;
  valueNorm: string;
  status: EvidenceStatus;
  corroboratedBy: number[];
  attrs: Record<string, unknown>;
}

export interface EvidenceStore {
  record(d: EvidenceDraft): Promise<number>;
  recordMany(d: EvidenceDraft[]): Promise<number[]>;
  reject(id: number, reason: string): Promise<void>;
  setCompany(listingId: number, companyId: number): Promise<void>;
  /** Every row for the company (all statuses), ordered by id. */
  listForCompany(companyId: number, field?: Field): Promise<EvidenceRow[]>;
}

type EvidenceDbRow = typeof evidence.$inferSelect;

export function toEvidenceRow(r: EvidenceDbRow): EvidenceRow {
  return {
    id: r.id,
    companyId: r.companyId,
    listingId: r.listingId,
    registryRecordId: r.registryRecordId,
    field: r.field as Field,
    value: r.value,
    valueNorm: r.valueNorm,
    sourceType: r.sourceType as SourceType,
    sourceUrl: r.sourceUrl,
    pageSha256: r.pageSha256,
    capturedAt: r.capturedAt,
    snippet: r.snippet,
    extractor: r.extractor,
    extractorVersion: r.extractorVersion,
    confidence: r.confidence as Confidence,
    status: r.status as EvidenceStatus,
    rejectReason: r.rejectReason,
    corroboratedBy: r.corroboratedBy,
    attrs: (r.attrs ?? {}) as Record<string, unknown>,
  };
}

function toInsert(d: EvidenceDraft): typeof evidence.$inferInsert {
  return {
    companyId: d.companyId ?? null,
    listingId: d.listingId ?? null,
    registryRecordId: d.registryRecordId ?? null,
    field: d.field,
    value: d.value,
    valueNorm: d.valueNorm ?? normaliseValue(d.field, d.value),
    sourceType: d.sourceType,
    sourceUrl: d.sourceUrl,
    pageSha256: d.pageSha256 ?? null,
    capturedAt: d.capturedAt,
    snippet: d.snippet,
    extractor: d.extractor,
    extractorVersion: d.extractorVersion,
    confidence: d.confidence,
    status: d.status ?? 'accepted',
    rejectReason: d.rejectReason ?? null,
    attrs: d.attrs ?? {},
  };
}

export class DbEvidenceStore implements EvidenceStore {
  constructor(private readonly db: DbOrTx) {}

  async record(d: EvidenceDraft): Promise<number> {
    const [row] = await this.db.insert(evidence).values(toInsert(d)).returning({ id: evidence.id });
    if (!row) throw new Error('evidence insert returned no row');
    return row.id;
  }

  async recordMany(drafts: EvidenceDraft[]): Promise<number[]> {
    if (drafts.length === 0) return [];
    const rows = await this.db.insert(evidence).values(drafts.map(toInsert)).returning({ id: evidence.id });
    return rows.map((r) => r.id);
  }

  async reject(id: number, reason: string): Promise<void> {
    await this.db.update(evidence).set({ status: 'rejected', rejectReason: reason }).where(eq(evidence.id, id));
  }

  async setCompany(listingId: number, companyId: number): Promise<void> {
    await this.db.update(evidence).set({ companyId }).where(eq(evidence.listingId, listingId));
  }

  async listForCompany(companyId: number, field?: Field): Promise<EvidenceRow[]> {
    const where = field
      ? and(eq(evidence.companyId, companyId), eq(evidence.field, field))
      : eq(evidence.companyId, companyId);
    const rows = await this.db.select().from(evidence).where(where).orderBy(asc(evidence.id));
    return rows.map(toEvidenceRow);
  }
}

export class MemoryEvidenceStore implements EvidenceStore {
  private rows: EvidenceRow[] = [];
  private nextId = 1;

  async record(d: EvidenceDraft): Promise<number> {
    if (!d.snippet || !d.sourceUrl || !d.extractor || !d.extractorVersion || !(d.capturedAt instanceof Date)) {
      throw new Error('evidence needs source_url, captured_at, snippet, extractor and extractor_version');
    }
    if (d.companyId == null && d.listingId == null && d.registryRecordId == null) {
      throw new Error('evidence needs a company, listing or registry record');
    }
    const id = this.nextId++;
    this.rows.push({
      ...d,
      id,
      companyId: d.companyId ?? null,
      listingId: d.listingId ?? null,
      registryRecordId: d.registryRecordId ?? null,
      pageSha256: d.pageSha256 ?? null,
      valueNorm: d.valueNorm ?? normaliseValue(d.field, d.value),
      status: d.status ?? 'accepted',
      rejectReason: d.rejectReason ?? null,
      corroboratedBy: [],
      attrs: d.attrs ?? {},
    });
    return id;
  }

  async recordMany(drafts: EvidenceDraft[]): Promise<number[]> {
    const ids: number[] = [];
    for (const d of drafts) ids.push(await this.record(d));
    return ids;
  }

  async reject(id: number, reason: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) {
      r.status = 'rejected';
      r.rejectReason = reason;
    }
  }

  async setCompany(listingId: number, companyId: number): Promise<void> {
    for (const r of this.rows) if (r.listingId === listingId) r.companyId = companyId;
  }

  async listForCompany(companyId: number, field?: Field): Promise<EvidenceRow[]> {
    return this.rows
      .filter((r) => r.companyId === companyId && (field === undefined || r.field === field))
      .map((r) => ({ ...r }));
  }
}

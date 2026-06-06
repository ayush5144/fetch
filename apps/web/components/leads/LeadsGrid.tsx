'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, estimateCost, tablesApi, leadsApi, settingsApi, searchAvailability, isCellFailed, type Column, type Lead, type CellJob, type SearchAvailability } from '@/lib/api';
import { AddColumnPopover } from './AddColumnPopover';
import type { ColumnPayload } from './AddColumnPopover';
import { ColumnMenu } from './ColumnMenu';
import { CellPeek } from './CellPeek';
import { ImportModal } from './ImportModal';
import { AskBoneModal } from './AskBoneModal';
import { Modal } from '@/components/Modal';
import { predefinedFieldByKey } from '@/lib/predefinedFields';

/**
 * Clay-style spreadsheet grid for a single table.
 *
 * Features implemented (Phase B):
 * - Sticky header + sticky left columns (checkbox + row-number)
 * - Horizontal scroll
 * - Row selection checkboxes
 * - Per-column ▷ Run and ⋯ menu (run/edit/rename/duplicate/insert left|right/delete)
 * - Inline cell editing (click-to-edit, Enter saves, Esc cancels); type validation
 * - Edited marker on overridden computed cells
 * - Drag-to-resize columns (persists via PATCH /columns/:id)
 * - Drag-to-reorder columns (persists via POST /tables/:id/columns/reorder)
 * - Drag-to-reorder rows (persists via POST /tables/:id/leads/reorder)
 * - Cell state machine: empty → queued → running → filled → error
 * - Per-cell hover ▷ Run
 * - Inline + new lead row at bottom
 * - Cell side-peek panel
 * - Live polling via useApi (passed in as props)
 * - + Add column popover (anchored, not a center modal)
 */

// ── Type utilities ────────────────────────────────────────────────────────────

const COLUMN_ICONS: Record<string, string> = {
  text: 'T',
  email: '✉',
  url: '🔗',
  number: '#',
  date: '📅',
  select: '▾',
  checkbox: '☑',
  dogi: '🐕',
  formula: 'ƒ',
  manual: '✎',
  enrichment: '◈',
  agent: '◈',
};

function columnIcon(col: Column): string {
  // Recognize a predefined common field by the column's key first (so a
  // `company` text column shows 🏢 instead of the generic `T`). We only do this
  // for plain value columns — a dogi/formula column keeps its provenance icon
  // (🐕 / ƒ) even if its key happens to match a predefined field.
  if (col.type !== 'dogi' && col.type !== 'formula') {
    const predefined = predefinedFieldByKey(col.key);
    if (predefined) return predefined.icon;
  }
  return COLUMN_ICONS[col.config?.valueType ?? ''] ?? COLUMN_ICONS[col.type] ?? 'T';
}

function isRunnable(col: Column): boolean {
  return col.type === 'dogi' || col.type === 'enrichment' || col.type === 'agent';
}

/**
 * Who made / fills this column. Dogi columns self-identify by type; formula
 * likewise; a manual column Bone created carries `config.createdBy: 'bone'`;
 * everything else is a plain user column.
 */
function columnProvenance(col: Column): 'User' | 'Dogi' | 'Bone' | 'Formula' {
  if (col.type === 'dogi' || col.type === 'enrichment' || col.type === 'agent') return 'Dogi';
  if (col.type === 'formula') return 'Formula';
  if (col.config?.createdBy === 'bone') return 'Bone';
  return 'User';
}

const VALUE_TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  email: 'Email',
  url: 'URL',
  number: 'Number',
  date: 'Date',
  select: 'Select',
  checkbox: 'Checkbox',
};

/** A friendly value-type name for the column (falls back to a Text-ish label). */
function valueTypeLabel(col: Column): string {
  const vt = col.config?.valueType;
  if (vt && VALUE_TYPE_LABELS[vt]) return VALUE_TYPE_LABELS[vt];
  if (col.type === 'formula') return 'Formula';
  return 'Text';
}

/** Validate a raw string value against a column's valueType. Returns error or null. */
function validateValue(raw: string, col: Column): string | null {
  const vt = col.config?.valueType;
  if (!vt || !raw) return null;
  switch (vt) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? null : 'Not a valid email';
    case 'url':
      try { new URL(raw); return null; } catch { return 'Not a valid URL'; }
    case 'number':
      return isNaN(Number(raw)) ? 'Must be a number' : null;
    case 'date':
      return isNaN(Date.parse(raw)) ? 'Not a valid date' : null;
    default:
      return null;
  }
}

function cellState(
  lead: Lead,
  col: Column,
  jobs: CellJob[],
): 'empty' | 'queued' | 'running' | 'filled' | 'error' | 'failed' {
  // A live job (queued/running/error) always wins — it reflects the current run.
  const job = jobs.find((j) => j.leadId === lead.id && j.columnKey === col.key);
  if (job) {
    if (job.status === 'error') return 'error';
    if (job.status === 'running') return 'running';
    if (job.status === 'queued') return 'queued';
  }
  const v = getCellValue(lead, col);
  if (v !== undefined && v !== null && v !== '') return 'filled';
  // No value and no live job: a recorded failure in enrichmentConf means the
  // cell ran and found nothing — distinct from a never-run empty cell.
  if (isCellFailed(lead.enrichmentConf?.[col.key])) return 'failed';
  return 'empty';
}

function getCellValue(lead: Lead, col: Column): unknown {
  // System fields
  if (col.key === 'firstName') return lead.firstName;
  if (col.key === 'lastName') return lead.lastName;
  if (col.key === 'email') return lead.email;
  if (col.key === 'title') return lead.title;
  return lead.data?.[col.key];
}

/**
 * Does a lead match a (lowercased) search query? Case-insensitive substring
 * match across the recognized identity fields plus every value in `data`. This
 * is a pure view filter — it never touches data fetching.
 */
function leadMatches(lead: Lead, q: string): boolean {
  if (!q) return true;
  const identity = [lead.firstName, lead.lastName, lead.email, lead.title];
  for (const v of identity) {
    if (v && v.toLowerCase().includes(q)) return true;
  }
  for (const v of Object.values(lead.data ?? {})) {
    if (v != null && String(v).toLowerCase().includes(q)) return true;
  }
  return false;
}

// Column widths. Data columns never shrink below MIN_COL_WIDTH; the table grows
// to the sum of widths and scrolls horizontally past that point.
const MIN_COL_WIDTH = 140;
const DEFAULT_COL_WIDTH = 180;
// Fixed widths of the three permanent (pinned) columns.
const CHECK_W = 40;
const NUM_W = 44;
const ADD_W = 52;

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  tableId: string;
  leads: Lead[];
  columns: Column[];
  jobs: CellJob[];
  onRefreshLeads: () => void;
  onRefreshColumns: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LeadsGrid({ tableId, leads, columns, jobs, onRefreshLeads, onRefreshColumns }: Props) {
  // ── Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ── Row search (a view filter only — never changes data fetching)
  const [search, setSearch] = useState('');

  // ── Editing
  const [editCell, setEditCell] = useState<{ leadId: string; key: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ── Add column popover
  const [addColAnchor, setAddColAnchor] = useState<DOMRect | null>(null);

  // ── Column context menu
  const [colMenu, setColMenu] = useState<{ col: Column; rect: DOMRect } | null>(null);

  // ── Header hover tooltip (instant, on-brand; fixed-positioned so the grid's
  // overflow/scroll never clips it)
  const [thTip, setThTip] = useState<{ col: Column; x: number; y: number } | null>(null);

  // ── Rename inline
  const [renameCol, setRenameCol] = useState<{ col: Column; rect: DOMRect } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // ── Edit column (reopen popover with existing config)
  const [editColPopover, setEditColPopover] = useState<{ col: Column; rect: DOMRect } | null>(null);

  // ── BYOK API keys — in-memory only, never persisted
  // Maps columnId → apiKey string
  const [byokKeys, setByokKeys] = useState<Record<string, string>>({});

  // ── Cell peek panel
  const [peek, setPeek] = useState<{ lead: Lead; col: Column } | null>(null);

  // ── Import modal
  const [showImport, setShowImport] = useState(false);

  // ── Ask Dogi modal
  const [showAskDogi, setShowAskDogi] = useState(false);
  const [dogiSuccessMsg, setDogiSuccessMsg] = useState<string | null>(null);

  // ── Dedupe (Phase G) — confirm modal + result message
  const [dedupe, setDedupe] = useState<{ col: Column; groups: number; rows: number } | null>(null);
  const [dedupeBusy, setDedupeBusy] = useState(false);
  const [dedupeMsg, setDedupeMsg] = useState<string | null>(null);

  // ── Column resize
  const resizeState = useRef<{
    colId: string;
    startX: number;
    startWidth: number;
    el: HTMLTableCellElement;
  } | null>(null);

  // ── Column reorder drag
  const colDrag = useRef<{ key: string; startX: number } | null>(null);
  const [colDragOver, setColDragOver] = useState<string | null>(null);

  // ── Row reorder drag
  const rowDrag = useRef<{ id: string } | null>(null);
  const [rowDragOver, setRowDragOver] = useState<{ id: string; side: 'above' | 'below' } | null>(null);

  // ── Bulk actions
  const [bulkBusy, setBulkBusy] = useState<'delete' | 'run' | 'rerun' | null>(null);

  // ── Add row (blank — the user fills this table's own columns inline)
  const [addLeadBusy, setAddLeadBusy] = useState(false);

  // ── Column widths (local override, persisted on drag end)
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const c of columns) {
      if (c.width) map[c.id] = c.width;
    }
    return map;
  });

  // Web-search / scrape backend availability — fetched once so the add-column
  // Dogi form can gate the web/scrape source toggles. Non-blocking: if /settings
  // fails we leave it undefined and gate nothing.
  const [searchAvail, setSearchAvail] = useState<SearchAvailability | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    settingsApi
      .get()
      .then((s) => { if (alive) setSearchAvail(searchAvailability(s.search)); })
      .catch(() => { /* non-blocking — leave undefined, nothing gets gated */ });
    return () => { alive = false; };
  }, []);

  // Sync widths when columns change
  useEffect(() => {
    setColWidths((prev) => {
      const next = { ...prev };
      for (const c of columns) {
        if (c.width && !next[c.id]) next[c.id] = c.width;
      }
      return next;
    });
  }, [columns]);

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (editCell) {
      setTimeout(() => editInputRef.current?.focus(), 0);
    }
  }, [editCell]);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renameCol) {
      setTimeout(() => renameRef.current?.focus(), 0);
    }
  }, [renameCol]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === leads.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(leads.map((l) => l.id)));
    }
  }

  function startEdit(lead: Lead, col: Column) {
    const v = getCellValue(lead, col);
    setEditCell({ leadId: lead.id, key: col.key });
    setEditValue(v !== null && v !== undefined ? String(v) : '');
    setEditError(null);
  }

  async function commitEdit(lead: Lead, col: Column) {
    const err = validateValue(editValue, col);
    if (err) { setEditError(err); return; }
    setEditCell(null);
    setEditError(null);
    try {
      await api.patch(`/leads/${lead.id}/cell`, { key: col.key, value: editValue });
      onRefreshLeads();
    } catch (e) {
      console.error('cell save failed', e);
      onRefreshLeads();
    }
  }

  function cancelEdit() {
    setEditCell(null);
    setEditError(null);
  }

  async function runCell(lead: Lead, col: Column) {
    try {
      const isByok = col.config?.brain?.keySource === 'byok';
      const apiKey = isByok ? byokKeys[col.id] : undefined;
      // Prompt for the key if it's BYOK but not yet set
      if (isByok && !apiKey) {
        const entered = window.prompt(`Enter your ${col.config?.brain?.provider ?? 'AI'} API key for "${col.label}" (session only, never saved):`);
        if (!entered) return;
        setByokKeys((prev) => ({ ...prev, [col.id]: entered }));
        await api.post(`/leads/${lead.id}/run/${col.key}`, { apiKey: entered });
      } else {
        await api.post(`/leads/${lead.id}/run/${col.key}`, apiKey ? { apiKey } : undefined);
      }
      setTimeout(onRefreshLeads, 500);
    } catch (e) {
      console.error('run cell failed', e);
    }
  }

  async function runColumn(col: Column) {
    const leadIds = selected.size > 0 ? [...selected] : leads.map((l) => l.id);
    try {
      const isByok = col.config?.brain?.keySource === 'byok';
      const apiKey = isByok ? byokKeys[col.id] : undefined;
      // Prompt for the key if it's BYOK but not yet set
      if (isByok && !apiKey) {
        const entered = window.prompt(`Enter your ${col.config?.brain?.provider ?? 'AI'} API key for "${col.label}" (session only, never saved):`);
        if (!entered) return;
        setByokKeys((prev) => ({ ...prev, [col.id]: entered }));
        await api.post(`/tables/${tableId}/columns/${col.key}/run`, { leadIds, apiKey: entered });
      } else {
        await api.post(`/tables/${tableId}/columns/${col.key}/run`, { leadIds, ...(apiKey ? { apiKey } : {}) });
      }
      setTimeout(onRefreshLeads, 500);
    } catch (e) {
      console.error('run column failed', e);
    }
  }

  /** Phase E — Test 5: run the column on only the first 5 empty rows. */
  async function test5Column(col: Column) {
    try {
      const isByok = col.config?.brain?.keySource === 'byok';
      const apiKey = isByok ? byokKeys[col.id] : undefined;
      if (isByok && !apiKey) {
        const entered = window.prompt(`Enter your ${col.config?.brain?.provider ?? 'AI'} API key for "${col.label}" (session only, never saved):`);
        if (!entered) return;
        setByokKeys((prev) => ({ ...prev, [col.id]: entered }));
        await api.post(`/tables/${tableId}/columns/${col.key}/run`, { limit: 5, apiKey: entered });
      } else {
        await api.post(`/tables/${tableId}/columns/${col.key}/run`, { limit: 5, ...(apiKey ? { apiKey } : {}) });
      }
      setTimeout(onRefreshLeads, 500);
    } catch (e) {
      console.error('test 5 failed', e);
    }
  }

  /** Phase E — estimate cost before a full run. Returns a formatted string. */
  async function estimateColumnCost(col: Column): Promise<string | null> {
    const brain = col.config?.brain as { provider?: string; model?: string } | undefined;
    if (!brain?.provider || !brain?.model) return null;
    // Count empty rows for this column (reuse getCellValue helper defined at module level)
    const emptyCount = leads.filter((l) => {
      const v = getCellValue(l, col);
      return v === undefined || v === null || v === '';
    }).length;
    const rows = emptyCount > 0 ? emptyCount : leads.length;
    const webSearch = (col.config?.sources as Array<{ type: string }> | undefined)
      ?.some((s) => s.type === 'web') ?? false;
    try {
      const est = await estimateCost({
        provider: brain.provider,
        model: brain.model,
        rows,
        webSearch,
      });
      return `≈ $${est.total.toFixed(4)} for ${rows} row${rows !== 1 ? 's' : ''}`;
    } catch {
      return null;
    }
  }

  async function deleteColumn(col: Column) {
    if (!confirm(`Delete column "${col.label}"? This cannot be undone.`)) return;
    try {
      await api.del(`/columns/${col.id}`);
      onRefreshColumns();
    } catch (e) {
      console.error('delete column failed', e);
    }
  }

  async function duplicateColumn(col: Column) {
    try {
      await api.post(`/tables/${tableId}/columns/${col.key}/duplicate`);
      onRefreshColumns();
    } catch (e) {
      console.error('duplicate column failed', e);
    }
  }

  /**
   * Phase G — Dedupe rows by a column. First preview the count; if there are
   * duplicates open a confirm modal, otherwise just show an inline "no
   * duplicates" message.
   */
  async function startDedupe(col: Column) {
    setDedupeMsg(null);
    try {
      const preview = await tablesApi.duplicates(tableId, [col.key]);
      if (preview.groups === 0) {
        setDedupeMsg('No duplicates in this column.');
        setTimeout(() => setDedupeMsg(null), 5000);
        return;
      }
      setDedupe({ col, groups: preview.groups, rows: preview.rows });
    } catch (e) {
      console.error('dedupe preview failed', e);
      setDedupeMsg('Could not check for duplicates — please try again.');
      setTimeout(() => setDedupeMsg(null), 5000);
    }
  }

  async function confirmDedupe() {
    if (!dedupe || dedupeBusy) return;
    setDedupeBusy(true);
    try {
      const res = await tablesApi.dedupe(tableId, [dedupe.col.key]);
      setDedupe(null);
      setDedupeMsg(`Merged ${res.merged} duplicate row${res.merged !== 1 ? 's' : ''}`);
      setTimeout(() => setDedupeMsg(null), 5000);
      onRefreshLeads();
    } catch (e) {
      console.error('dedupe failed', e);
      setDedupeMsg('Dedupe failed — please try again.');
      setTimeout(() => setDedupeMsg(null), 5000);
      setDedupe(null);
    } finally {
      setDedupeBusy(false);
    }
  }

  async function insertColumn(col: Column, side: 'left' | 'right') {
    // Open the add popover — we'll anchor it to a reasonable position
    // For now, we open the add-column popover without a specific anchor
    // by using a dummy rect near the top of the grid
    const idx = columns.findIndex((c) => c.id === col.id);
    const targetPos = side === 'left' ? (col.position ?? idx) : (col.position ?? idx) + 1;
    // Store the insert position in a ref so the popover submit can use it
    insertPositionRef.current = targetPos;
    setAddColAnchor(new DOMRect(200, 100, 0, 0));
  }
  const insertPositionRef = useRef<number | null>(null);

  async function submitNewColumn(payload: ColumnPayload) {
    const body: Record<string, unknown> = {
      key: payload.key,
      label: payload.label,
      type: payload.type,
      config: payload.config,
    };
    if (insertPositionRef.current !== null) {
      body.position = insertPositionRef.current;
      insertPositionRef.current = null;
    }
    await api.post(`/tables/${tableId}/columns`, body);
    onRefreshColumns();
  }

  async function editColumnConfig(
    columnId: string,
    patch: { label: string; config: Record<string, unknown> },
  ) {
    await api.patch(`/columns/${columnId}`, patch);
    onRefreshColumns();
  }

  async function renameColumn(col: Column, newLabel: string) {
    setRenameError(null);
    try {
      await api.patch(`/columns/${col.id}`, { label: newLabel });
      setRenameCol(null);
      onRefreshColumns();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      setRenameError(
        msg.includes('409') || msg.includes('duplicate') || msg.includes('already')
          ? `A column named "${newLabel}" already exists.`
          : msg,
      );
    }
  }

  async function addRow() {
    if (addLeadBusy) return;
    setAddLeadBusy(true);
    try {
      // Create a blank row; the user fills this table's columns by editing cells.
      await api.post(`/tables/${tableId}/leads`, {});
      onRefreshLeads();
    } catch (e) {
      console.error('add row failed', e);
    } finally {
      setAddLeadBusy(false);
    }
  }

  async function bulkDelete() {
    const leadIds = [...selected];
    if (leadIds.length === 0) return;
    if (!confirm(`Delete ${leadIds.length} row${leadIds.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
    setBulkBusy('delete');
    try {
      await api.post(`/tables/${tableId}/leads/delete`, { leadIds });
      setSelected(new Set());
      onRefreshLeads();
    } catch (e) {
      console.error('bulk delete failed', e);
    } finally {
      setBulkBusy(null);
    }
  }

  async function bulkRun() {
    const leadIds = [...selected];
    if (leadIds.length === 0) return;
    setBulkBusy('run');
    try {
      await api.post(`/tables/${tableId}/run`, { leadIds });
      setTimeout(() => {
        onRefreshLeads();
        setBulkBusy(null);
      }, 500);
    } catch (e) {
      console.error('bulk run failed', e);
      setBulkBusy(null);
    }
  }

  /**
   * Re-run every Dogi column for one lead — `POST /leads/:id/run`. Used by the
   * row's "Re-run row" action (re-runs empty/failed cells; pass force to redo
   * filled ones too). Cells re-enter running → filled/failed after a refresh.
   */
  async function rerunRow(leadId: string, force?: boolean) {
    try {
      await leadsApi.rerunRow(leadId, force);
      setTimeout(onRefreshLeads, 500);
    } catch (e) {
      console.error('re-run row failed', e);
    }
  }

  /** Re-run all selected rows (bulk "Re-run row" from the selection bar). */
  async function bulkRerunRows() {
    const leadIds = [...selected];
    if (leadIds.length === 0) return;
    setBulkBusy('rerun');
    try {
      await Promise.all(leadIds.map((id) => leadsApi.rerunRow(id)));
      setTimeout(() => {
        onRefreshLeads();
        setBulkBusy(null);
      }, 500);
    } catch (e) {
      console.error('bulk re-run rows failed', e);
      setBulkBusy(null);
    }
  }

  // ── Column resize ──────────────────────────────────────────────────────────

  function onResizeStart(e: React.MouseEvent, col: Column, th: HTMLTableCellElement) {
    e.preventDefault();
    e.stopPropagation();
    const currentWidth = colWidths[col.id] ?? DEFAULT_COL_WIDTH;
    resizeState.current = { colId: col.id, startX: e.clientX, startWidth: currentWidth, el: th };
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
  }

  const onResizeMove = useCallback((e: MouseEvent) => {
    const rs = resizeState.current;
    if (!rs) return;
    const delta = e.clientX - rs.startX;
    const newWidth = Math.max(MIN_COL_WIDTH, rs.startWidth + delta);
    setColWidths((prev) => ({ ...prev, [rs.colId]: newWidth }));
    rs.el.style.width = `${newWidth}px`;
  }, []);

  const onResizeEnd = useCallback(async () => {
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
    const rs = resizeState.current;
    if (!rs) return;
    const width = colWidths[rs.colId] ?? DEFAULT_COL_WIDTH;
    resizeState.current = null;
    try {
      await api.patch(`/columns/${rs.colId}`, { width });
    } catch (e) {
      console.error('persist width failed', e);
    }
  }, [colWidths, onResizeMove]);

  // ── Column reorder ────────────────────────────────────────────────────────

  function onColDragStart(e: React.DragEvent, col: Column) {
    colDrag.current = { key: col.key, startX: e.clientX };
    e.dataTransfer.effectAllowed = 'move';
  }

  function onColDragOver(e: React.DragEvent, col: Column) {
    e.preventDefault();
    if (colDrag.current && colDrag.current.key !== col.key) {
      setColDragOver(col.key);
    }
  }

  async function onColDrop(e: React.DragEvent, targetCol: Column) {
    e.preventDefault();
    const src = colDrag.current;
    colDrag.current = null;
    setColDragOver(null);
    if (!src || src.key === targetCol.key) return;

    const srcIdx = columns.findIndex((c) => c.key === src.key);
    const tgtIdx = columns.findIndex((c) => c.key === targetCol.key);
    if (srcIdx < 0 || tgtIdx < 0) return;

    const order = columns.map((c) => c.key);
    order.splice(srcIdx, 1);
    order.splice(tgtIdx, 0, src.key);

    try {
      await api.post(`/tables/${tableId}/columns/reorder`, { order });
      onRefreshColumns();
    } catch (e) {
      console.error('reorder columns failed', e);
    }
  }

  function onColDragEnd() {
    colDrag.current = null;
    setColDragOver(null);
  }

  // ── Row reorder ───────────────────────────────────────────────────────────

  function onRowDragStart(e: React.DragEvent, lead: Lead) {
    rowDrag.current = { id: lead.id };
    e.dataTransfer.effectAllowed = 'move';
  }

  function onRowDragOver(e: React.DragEvent, lead: Lead) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    if (rowDrag.current && rowDrag.current.id !== lead.id) {
      setRowDragOver({ id: lead.id, side });
    }
  }

  async function onRowDrop(e: React.DragEvent, targetLead: Lead) {
    e.preventDefault();
    const src = rowDrag.current;
    rowDrag.current = null;
    setRowDragOver(null);
    if (!src || src.id === targetLead.id) return;

    const srcIdx = leads.findIndex((l) => l.id === src.id);
    const tgtIdx = leads.findIndex((l) => l.id === targetLead.id);
    if (srcIdx < 0 || tgtIdx < 0) return;

    const order = leads.map((l) => l.id);
    order.splice(srcIdx, 1);
    const insertAt = rowDragOver?.side === 'below' ? tgtIdx : Math.max(0, tgtIdx);
    order.splice(insertAt, 0, src.id);

    try {
      await api.post(`/tables/${tableId}/leads/reorder`, { order });
      onRefreshLeads();
    } catch (e) {
      console.error('reorder rows failed', e);
    }
  }

  function onRowDragEnd() {
    rowDrag.current = null;
    setRowDragOver(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const allSelected = leads.length > 0 && selected.size === leads.length;
  const someSelected = selected.size > 0 && !allSelected;

  // Row search is a pure view filter over the already-loaded leads.
  const q = search.trim().toLowerCase();
  const displayLeads = q ? leads.filter((l) => leadMatches(l, q)) : leads;

  const availableColumns = columns.map((c) => ({ key: c.key, label: c.label }));

  // How many cell jobs for this table are in flight (running or queued). Drives
  // the "Dogi working…" toolbar indicator. Errors aren't "in flight".
  const inFlightCount = jobs.filter(
    (j) => j.status === 'running' || j.status === 'queued',
  ).length;

  return (
    <>
      {/* Toolbar */}
      <div className="grid-toolbar">
        {selected.size > 0 ? (
          /* Bulk-action bar — replaces normal toolbar content when rows are checked */
          <div className="bulk-bar">
            <span className="bulk-bar-count">{selected.size} selected</span>
            <div className="bulk-bar-sep" />
            <button
              className="bulk-bar-btn"
              disabled={bulkBusy === 'run'}
              onClick={bulkRun}
            >
              {bulkBusy === 'run' ? 'Running…' : '▷ Run'}
            </button>
            <button
              className="bulk-bar-btn"
              disabled={bulkBusy === 'rerun'}
              title="Re-run every Dogi column for the selected rows"
              onClick={bulkRerunRows}
            >
              {bulkBusy === 'rerun' ? 'Re-running…' : '↻ Re-run row'}
            </button>
            <button
              className="bulk-bar-btn danger"
              disabled={bulkBusy === 'delete'}
              onClick={bulkDelete}
            >
              {bulkBusy === 'delete' ? 'Deleting…' : '🗑 Delete'}
            </button>
            <div className="bulk-bar-sep" />
            <button
              className="bulk-bar-btn ghost"
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </button>
          </div>
        ) : (
          <label className="search" style={{ minWidth: 220 }}>
            <span className="muted" style={{ fontSize: 13 }} aria-hidden>⌕</span>
            <input
              type="text"
              placeholder="Search rows…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search rows"
            />
          </label>
        )}
        {q && (
          <span className="muted" style={{ fontSize: 12 }}>
            {displayLeads.length} of {leads.length} rows
          </span>
        )}
        <div className="spacer" />
        {inFlightCount > 0 && (
          <span className="pill grid-working-pill" style={{ fontSize: 12 }}>
            <span className="dot" />
            Dogi working… {inFlightCount} running
          </span>
        )}
        {dogiSuccessMsg && (
          <span
            className="pill pill-green"
            style={{ fontSize: 12 }}
          >
            {dogiSuccessMsg}
          </span>
        )}
        {dedupeMsg && (
          <span className="pill pill-muted" style={{ fontSize: 12 }}>
            {dedupeMsg}
          </span>
        )}
        <button
          className="btn btn-accent btn-sm"
          onClick={() => { setDogiSuccessMsg(null); setShowAskDogi(true); }}
        >
          Ask Bone 🐕
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowImport(true)}>
          Import CSV
        </button>
      </div>

      {/* Scrollable grid. The table width is the sum of all column widths so
          columns keep a real width (never squish); past the viewport it scrolls
          horizontally, while the first two and the last column stay pinned. */}
      <div className="grid-scroll">
        <table
          className="grid-tbl"
          style={{
            width:
              CHECK_W +
              NUM_W +
              ADD_W +
              columns.reduce((sum, c) => sum + (colWidths[c.id] ?? DEFAULT_COL_WIDTH), 0),
          }}
        >
          <colgroup>
            <col className="grid-col-check" />
            <col className="grid-col-num" />
            {columns.map((c) => (
              <col key={c.id} style={{ width: colWidths[c.id] ?? DEFAULT_COL_WIDTH }} />
            ))}
            <col className="grid-col-add" />
          </colgroup>
          <thead>
            <tr>
              {/* Checkbox */}
              <th>
                <div className="grid-cell-check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleSelectAll}
                    style={{ cursor: 'pointer' }}
                  />
                </div>
              </th>
              {/* Row number placeholder */}
              <th>
                <div style={{ height: 36 }} />
              </th>
              {/* User columns */}
              {columns.map((col) => (
                <th
                  key={col.id}
                  style={{
                    width: colWidths[col.id] ?? DEFAULT_COL_WIDTH,
                    outline: colDragOver === col.key ? '2px solid var(--accent)' : undefined,
                  }}
                  draggable
                  onDragStart={(e) => onColDragStart(e, col)}
                  onDragOver={(e) => onColDragOver(e, col)}
                  onDrop={(e) => onColDrop(e, col)}
                  onDragEnd={onColDragEnd}
                  ref={(el) => {
                    if (el && resizeState.current?.colId === col.id) {
                      resizeState.current.el = el;
                    }
                  }}
                >
                  <div
                    className="grid-th-inner"
                    onMouseEnter={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setThTip({ col, x: r.left + r.width / 2, y: r.bottom + 6 });
                    }}
                    onMouseLeave={() => setThTip((t) => (t?.col.id === col.id ? null : t))}
                  >
                    <span className="grid-th-icon">{columnIcon(col)}</span>
                    <span className="grid-th-label">{col.label}</span>
                    <div className="grid-th-actions">
                      {isRunnable(col) && (
                        <button
                          className="grid-th-btn"
                          title="Run column"
                          onClick={(e) => { e.stopPropagation(); runColumn(col); }}
                        >
                          ▷
                        </button>
                      )}
                      <button
                        className="grid-th-btn"
                        title="Column menu"
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = (e.target as HTMLElement).getBoundingClientRect();
                          setColMenu({ col, rect });
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                    {/* Resize handle */}
                    <div
                      className="grid-resize-handle"
                      onMouseDown={(e) => {
                        const th = (e.target as HTMLElement).closest('th') as HTMLTableCellElement;
                        onResizeStart(e, col, th);
                      }}
                    />
                  </div>
                </th>
              ))}
              {/* Add column */}
              <th className="grid-th-add">
                <button
                  className="grid-th-add-btn"
                  title="Add column"
                  onClick={(e) => {
                    const rect = (e.target as HTMLElement).getBoundingClientRect();
                    setAddColAnchor(rect);
                  }}
                >
                  +
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {displayLeads.map((lead, idx) => {
              const isDragging = rowDrag.current?.id === lead.id;
              const isAbove = rowDragOver?.id === lead.id && rowDragOver.side === 'above';
              const isBelow = rowDragOver?.id === lead.id && rowDragOver.side === 'below';
              return (
                <tr
                  key={lead.id}
                  className={[
                    selected.has(lead.id) ? 'grid-row-selected' : '',
                    isDragging ? 'grid-row-dragging' : '',
                    isAbove ? 'grid-row-drop-above' : '',
                    isBelow ? 'grid-row-drop-below' : '',
                  ].filter(Boolean).join(' ')}
                  draggable
                  onDragStart={(e) => onRowDragStart(e, lead)}
                  onDragOver={(e) => onRowDragOver(e, lead)}
                  onDrop={(e) => onRowDrop(e, lead)}
                  onDragEnd={onRowDragEnd}
                >
                  {/* Checkbox */}
                  <td>
                    <div className="grid-cell-check">
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => toggleSelect(lead.id)}
                        style={{ cursor: 'pointer' }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  </td>
                  {/* Row number — hover reveals "Re-run row" (all Dogi columns) */}
                  <td>
                    <div className="grid-cell-num" title="Drag to reorder">
                      <span className="grid-cell-num-idx">{idx + 1}</span>
                      <button
                        className="grid-row-rerun"
                        title="Re-run all Dogi columns for this row"
                        onClick={(e) => { e.stopPropagation(); rerunRow(lead.id); }}
                      >
                        ↻
                      </button>
                    </div>
                  </td>
                  {/* User columns */}
                  {columns.map((col) => (
                    <GridCell
                      key={col.id}
                      lead={lead}
                      col={col}
                      jobs={jobs}
                      editing={editCell?.leadId === lead.id && editCell?.key === col.key}
                      editValue={editValue}
                      editError={editError}
                      editInputRef={editInputRef}
                      onStartEdit={() => startEdit(lead, col)}
                      onEditChange={(v) => { setEditValue(v); setEditError(null); }}
                      onCommit={() => commitEdit(lead, col)}
                      onCancel={cancelEdit}
                      onRun={() => runCell(lead, col)}
                      onPeek={() => setPeek({ lead, col })}
                    />
                  ))}
                  {/* Add column empty cell */}
                  <td style={{ background: 'var(--surface)' }} />
                </tr>
              );
            })}

            {displayLeads.length === 0 && (
              <tr>
                <td colSpan={columns.length + 3}>
                  <div className="empty">
                    <div className="empty-icon">☰</div>
                    {q
                      ? `No rows match “${search.trim()}”.`
                      : 'No rows yet. Add a row or import a CSV.'}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* + add row footer — creates a blank row; fill the table's columns inline */}
        <div
          className="grid-add-row"
          onClick={() => !addLeadBusy && addRow()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && !addLeadBusy && addRow()}
        >
          <span style={{ fontSize: 14 }}>+</span>
          <span>{addLeadBusy ? 'Adding…' : 'Add row'}</span>
        </div>
      </div>

      {/* Add column popover */}
      {addColAnchor && (
        <AddColumnPopover
          anchorRect={addColAnchor}
          tableId={tableId}
          availableColumns={availableColumns}
          searchAvailability={searchAvail}
          onSubmit={submitNewColumn}
          onClose={() => { setAddColAnchor(null); insertPositionRef.current = null; }}
        />
      )}

      {/* Column context menu */}
      {colMenu && (
        <ColumnMenu
          anchorRect={colMenu.rect}
          columnKey={colMenu.col.key}
          columnLabel={colMenu.col.label}
          provenance={columnProvenance(colMenu.col)}
          valueTypeLabel={valueTypeLabel(colMenu.col)}
          isRunnable={isRunnable(colMenu.col)}
          isProtected={Boolean(colMenu.col.config?.protected)}
          onRun={() => runColumn(colMenu.col)}
          onTest5={isRunnable(colMenu.col) ? () => test5Column(colMenu.col) : undefined}
          onDedupe={() => startDedupe(colMenu.col)}
          onEstimateCost={
            isRunnable(colMenu.col) && colMenu.col.config?.brain
              ? () => estimateColumnCost(colMenu.col)
              : undefined
          }
          onEdit={() => {
            setEditColPopover({ col: colMenu.col, rect: colMenu.rect });
            setColMenu(null);
          }}
          onRename={() => {
            setRenameValue(colMenu.col.label);
            setRenameError(null);
            setRenameCol({ col: colMenu.col, rect: colMenu.rect });
          }}
          onDuplicate={() => duplicateColumn(colMenu.col)}
          onInsertLeft={() => insertColumn(colMenu.col, 'left')}
          onInsertRight={() => insertColumn(colMenu.col, 'right')}
          onDelete={() => deleteColumn(colMenu.col)}
          onClose={() => setColMenu(null)}
        />
      )}

      {/* Column-header hover tooltip — fixed-positioned so it is never clipped
          by the grid's horizontal/vertical scroll overflow. */}
      {thTip && (
        <div
          className="grid-th-tip"
          style={{
            top: thTip.y,
            left: Math.max(8, Math.min(thTip.x, window.innerWidth - 8)),
          }}
        >
          {valueTypeLabel(thTip.col)} · by{' '}
          <span className="grid-th-tip-prov">{columnProvenance(thTip.col)}</span>
        </div>
      )}

      {/* Rename inline popover */}
      {renameCol && (
        <>
          <div className="col-menu-backdrop" onClick={() => setRenameCol(null)} />
          <div
            className="col-popover"
            style={{
              top: Math.min(renameCol.rect.bottom + 4, window.innerHeight - 180),
              left: Math.max(8, Math.min(renameCol.rect.left, window.innerWidth - 340)),
              padding: 14,
            }}
          >
            <div className="field" style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'block', marginBottom: 4 }}>
                Rename column
              </label>
              <input
                ref={renameRef}
                className="input"
                value={renameValue}
                onChange={(e) => { setRenameValue(e.target.value); setRenameError(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') renameColumn(renameCol.col, renameValue);
                  if (e.key === 'Escape') setRenameCol(null);
                }}
                style={{ fontSize: 13 }}
              />
              {renameError && (
                <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{renameError}</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setRenameCol(null)}>Cancel</button>
              <button
                className="btn btn-accent btn-sm"
                disabled={!renameValue.trim()}
                onClick={() => renameColumn(renameCol.col, renameValue)}
              >
                Rename
              </button>
            </div>
          </div>
        </>
      )}

      {/* Edit column popover — pre-populated from existing column */}
      {editColPopover && (
        <AddColumnPopover
          anchorRect={editColPopover.rect}
          tableId={tableId}
          availableColumns={availableColumns.filter((c) => c.key !== editColPopover.col.key)}
          searchAvailability={searchAvail}
          editColumn={editColPopover.col}
          onSubmit={submitNewColumn}
          onEdit={editColumnConfig}
          onClose={() => setEditColPopover(null)}
        />
      )}

      {/* Cell side-peek */}
      {peek && (
        <CellPeek
          lead={peek.lead}
          column={peek.col}
          onRerun={() => runCell(peek.lead, peek.col)}
          onClose={() => setPeek(null)}
        />
      )}

      {/* Import modal */}
      {showImport && (
        <ImportModal
          tableId={tableId}
          columns={columns}
          onClose={() => setShowImport(false)}
          onDone={() => { setShowImport(false); onRefreshLeads(); onRefreshColumns(); }}
        />
      )}

      {/* Dedupe confirm modal (Phase G) */}
      {dedupe && (
        <Modal
          title="Dedupe rows"
          maxWidth={460}
          onClose={() => { if (!dedupeBusy) setDedupe(null); }}
          footer={
            <>
              <button
                className="btn btn-ghost"
                disabled={dedupeBusy}
                onClick={() => setDedupe(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-accent"
                disabled={dedupeBusy}
                onClick={confirmDedupe}
              >
                {dedupeBusy ? 'Deduping…' : 'Dedupe'}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--ink-soft)' }}>
            Found <strong>{dedupe.groups}</strong> duplicate value
            {dedupe.groups !== 1 ? 's' : ''} across the column{' '}
            <strong>‘{dedupe.col.label}’</strong>. Dedupe will merge{' '}
            <strong>{dedupe.rows}</strong> row{dedupe.rows !== 1 ? 's' : ''} into their oldest
            match (existing values are never overwritten). Continue?
          </p>
        </Modal>
      )}

      {/* Ask Bone modal */}
      {showAskDogi && (
        <AskBoneModal
          tableId={tableId}
          onClose={() => setShowAskDogi(false)}
          onDone={({ rowsCreated, columnsCreated, enqueued }) => {
            // Refresh the grid; the modal stays open to show its own result
            // summary and closes itself when the user dismisses it.
            onRefreshColumns();
            onRefreshLeads();
            const parts: string[] = [];
            if (rowsCreated > 0) parts.push(`${rowsCreated} row${rowsCreated !== 1 ? 's' : ''}`);
            if (columnsCreated > 0) parts.push(`${columnsCreated} column${columnsCreated !== 1 ? 's' : ''}`);
            if (enqueued > 0) parts.push(`${enqueued} run${enqueued !== 1 ? 's' : ''} queued`);
            setDogiSuccessMsg(
              parts.length > 0 ? `Bone created ${parts.join(', ')}` : 'Bone finished',
            );
            // Auto-dismiss after 5 s
            setTimeout(() => setDogiSuccessMsg(null), 5000);
          }}
        />
      )}
    </>
  );
}

// ── GridCell ──────────────────────────────────────────────────────────────────

interface CellProps {
  lead: Lead;
  col: Column;
  jobs: CellJob[];
  editing: boolean;
  editValue: string;
  editError: string | null;
  editInputRef: React.RefObject<HTMLInputElement | null>;
  onStartEdit: () => void;
  onEditChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onRun: () => void;
  onPeek: () => void;
}

function GridCell({
  lead, col, jobs,
  editing, editValue, editError, editInputRef,
  onStartEdit, onEditChange, onCommit, onCancel,
  onRun, onPeek,
}: CellProps) {
  const state = cellState(lead, col, jobs);
  const value = getCellValue(lead, col);
  const prov = lead.enrichmentConf?.[col.key];
  const isEdited = lead.editedKeys?.includes(col.key);
  const vt = col.config?.valueType;

  if (editing) {
    return (
      <td style={{ padding: 0 }}>
        <div style={{ position: 'relative' }}>
          <input
            ref={editInputRef}
            className="grid-cell-input"
            style={{ padding: '0 10px' }}
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
              if (e.key === 'Escape') onCancel();
            }}
            onBlur={onCommit}
            type={vt === 'number' ? 'number' : vt === 'date' ? 'date' : vt === 'email' ? 'email' : vt === 'url' ? 'url' : 'text'}
          />
          {editError && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              background: 'var(--red-soft)',
              color: 'var(--red)',
              fontSize: 11,
              padding: '4px 8px',
              borderRadius: '0 0 var(--radius-sm) var(--radius-sm)',
              zIndex: 10,
              whiteSpace: 'nowrap',
              border: '1px solid var(--red)',
              borderTop: 'none',
            }}>
              {editError}
            </div>
          )}
        </div>
      </td>
    );
  }

  // Checkbox render
  if (vt === 'checkbox') {
    return (
      <td onClick={onStartEdit}>
        <div className="grid-cell" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={() => {}}
            onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
            readOnly
          />
        </div>
      </td>
    );
  }

  // State machine rendering
  if (state === 'running') {
    return (
      <td>
        <div className="grid-cell">
          <div className="grid-cell-spinner" />
          <span className="grid-cell-queued">Running…</span>
        </div>
      </td>
    );
  }

  if (state === 'queued') {
    return (
      <td>
        <div className="grid-cell">
          <span className="grid-cell-pulse" aria-hidden />
          <span className="grid-cell-queued">Queued…</span>
        </div>
      </td>
    );
  }

  if (state === 'error') {
    const job = jobs.find((j) => j.leadId === lead.id && j.columnKey === col.key);
    return (
      <td>
        <div className="grid-cell">
          <span className="grid-cell-error">
            ⚠ {job?.error ?? 'Error'}
          </span>
          <button className="grid-cell-run" onClick={(e) => { e.stopPropagation(); onRun(); }} style={{ opacity: 1 }}>
            Retry
          </button>
        </div>
      </td>
    );
  }

  // Failed: the cell ran and found nothing (recorded in enrichmentConf). Show a
  // clear ⚠ marker with the reason on hover (title) or click (side-peek), plus a
  // Re-run. This is distinct from a never-run "empty" cell (which shows ▷ Run).
  if (state === 'failed') {
    const reason = isCellFailed(prov) ? prov.error : 'This cell ran but found nothing.';
    return (
      <td
        onClick={onPeek}
        style={{ cursor: 'pointer' }}
        title={`Failed: ${reason}`}
      >
        <div className="grid-cell">
          <span className="grid-cell-failed">⚠ failed</span>
          <button
            className="grid-cell-run"
            onClick={(e) => { e.stopPropagation(); onRun(); }}
            style={{ opacity: 1 }}
            title="Re-run this cell"
          >
            ↻ Re-run
          </button>
        </div>
      </td>
    );
  }

  if (state === 'filled' || (value !== undefined && value !== null && value !== '')) {
    const displayValue = String(value);
    const isStrong = col.key === 'firstName' || col.key === 'lastName' || col.key === 'company';
    const isMono = col.key === 'email' || vt === 'email' || vt === 'url';
    // A filled cell's conf carries provenance (legacy convention: confidence/
    // source with no `status`). A failed conf never coexists with a value.
    const filledProv = prov && !isCellFailed(prov) ? prov : undefined;

    return (
      <td
        onClick={() => {
          // Single click: peek for computed, or start edit for manual
          if (isRunnable(col)) onPeek();
          else onStartEdit();
        }}
        onDoubleClick={() => {
          // Double-click always opens edit
          onStartEdit();
        }}
        style={{ cursor: isRunnable(col) ? 'pointer' : 'text' }}
      >
        <div className="grid-cell">
          <span
            className={[
              'grid-cell-value',
              isStrong ? 'is-strong' : '',
              isMono ? 'is-mono' : '',
              isEdited ? 'is-edited' : '',
            ].filter(Boolean).join(' ')}
            title={displayValue}
          >
            {displayValue}
          </span>
          {filledProv && (
            <span className="grid-cell-conf">
              {filledProv.source ? (
                <a
                  href={filledProv.source}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={`${Math.round(filledProv.confidence * 100)}% confidence — ${filledProv.source}`}
                >
                  ◔{Math.round(filledProv.confidence * 100)}%
                </a>
              ) : (
                <span title={`${Math.round(filledProv.confidence * 100)}% confidence`}>
                  ◔{Math.round(filledProv.confidence * 100)}%
                </span>
              )}
            </span>
          )}
        </div>
      </td>
    );
  }

  // Empty cell
  if (isRunnable(col)) {
    return (
      <td>
        <div className="grid-cell">
          <button className="grid-cell-run" onClick={(e) => { e.stopPropagation(); onRun(); }}>
            ▷ Run
          </button>
        </div>
      </td>
    );
  }

  // Empty manual cell
  return (
    <td onClick={onStartEdit} style={{ cursor: 'text' }}>
      <div className="grid-cell">
        <span className="grid-cell-value is-muted">—</span>
      </div>
    </td>
  );
}

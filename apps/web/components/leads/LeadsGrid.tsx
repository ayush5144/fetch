'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Column, type Lead, type CellJob } from '@/lib/api';
import { AddColumnPopover } from './AddColumnPopover';
import type { ColumnPayload } from './AddColumnPopover';
import { ColumnMenu } from './ColumnMenu';
import { CellPeek } from './CellPeek';
import { ImportModal } from './ImportModal';

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
  return COLUMN_ICONS[col.config?.valueType ?? ''] ?? COLUMN_ICONS[col.type] ?? 'T';
}

function isRunnable(col: Column): boolean {
  return col.type === 'dogi' || col.type === 'enrichment' || col.type === 'agent';
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
): 'empty' | 'queued' | 'running' | 'filled' | 'error' {
  const job = jobs.find((j) => j.leadId === lead.id && j.columnKey === col.key);
  if (job) {
    if (job.status === 'error') return 'error';
    if (job.status === 'running') return 'running';
    if (job.status === 'queued') return 'queued';
  }
  const v = getCellValue(lead, col);
  if (v !== undefined && v !== null && v !== '') return 'filled';
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

// Default minimum column width in px
const MIN_COL_WIDTH = 100;
const DEFAULT_COL_WIDTH = 180;

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

  // ── Editing
  const [editCell, setEditCell] = useState<{ leadId: string; key: string } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ── Add column popover
  const [addColAnchor, setAddColAnchor] = useState<DOMRect | null>(null);

  // ── Column context menu
  const [colMenu, setColMenu] = useState<{ col: Column; rect: DOMRect } | null>(null);

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

  const availableColumns = columns.map((c) => ({ key: c.key, label: c.label }));

  return (
    <>
      {/* Toolbar */}
      <div className="grid-toolbar">
        {selected.size > 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            {selected.size} selected
          </span>
        )}
        <div className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => setShowImport(true)}>
          Import CSV
        </button>
      </div>

      {/* Scrollable grid */}
      <div className="grid-scroll">
        <table className="grid-tbl">
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
                  <div className="grid-th-inner">
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
            {leads.map((lead, idx) => {
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
                  {/* Row number */}
                  <td>
                    <div className="grid-cell-num" title="Drag to reorder">{idx + 1}</div>
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

            {leads.length === 0 && (
              <tr>
                <td colSpan={columns.length + 3}>
                  <div className="empty">
                    <div className="empty-icon">☰</div>
                    No rows yet. Add a row or import a CSV.
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
          isRunnable={isRunnable(colMenu.col)}
          isProtected={Boolean(colMenu.col.config?.protected)}
          onRun={() => runColumn(colMenu.col)}
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
          <span className="grid-cell-queued">⏳ Queued</span>
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

  if (state === 'filled' || (value !== undefined && value !== null && value !== '')) {
    const displayValue = String(value);
    const isStrong = col.key === 'firstName' || col.key === 'lastName' || col.key === 'company';
    const isMono = col.key === 'email' || vt === 'email' || vt === 'url';

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
          {prov && (
            <span className="grid-cell-conf">
              {prov.source ? (
                <a
                  href={prov.source}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={`${Math.round(prov.confidence * 100)}% confidence — ${prov.source}`}
                >
                  ◔{Math.round(prov.confidence * 100)}%
                </a>
              ) : (
                <span title={`${Math.round(prov.confidence * 100)}% confidence`}>
                  ◔{Math.round(prov.confidence * 100)}%
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

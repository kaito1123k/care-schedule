// CSVの書き出し・読み込み（DOMに依存しない）
import { SWIMSUIT_VALUES, validateItem, validateDay } from './calc.js';

// record_type=item   … 予定 1件1行（id が同じ予定は読み込み時に置き換え）（kind: bath=入浴 / move=移動支援 / other=その他、swimsuit: 1=水着あり）
// record_type=day    … 1日の勤務時間（start=出勤, end=退勤, break_start〜break_end=休憩）
// record_type=client … 利用者（client_name=苗字, swimsuit: need / no / unknown = 入浴介助の水着の初期値）
export const CSV_HEADER = [
  'record_type', 'id', 'date', 'start', 'end', 'break_start', 'break_end',
  'client_name', 'kind', 'swimsuit', 'memo', 'full_name', 'town', 'client_note',
];

function esc(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function line(obj) {
  return CSV_HEADER.map((h) => esc(obj[h])).join(',');
}

/** clientName(item) は予定に紐づく利用者の苗字を返す関数 */
export function toCSV(items, clients, clientName, days = []) {
  const lines = [CSV_HEADER.join(',')];
  for (const c of clients) {
    lines.push(line({
      record_type: 'client', client_name: c.name, full_name: c.fullName, town: c.town, swimsuit: c.swimsuit, client_note: c.note,
    }));
  }
  for (const d of days) {
    lines.push(line({ record_type: 'day', date: d.date, start: d.start, end: d.end, break_start: d.breakStart, break_end: d.breakEnd }));
  }
  for (const i of items) {
    lines.push(line({
      record_type: 'item', id: i.id, date: i.date, start: i.start, end: i.end, client_name: clientName(i),
      kind: i.kind, swimsuit: i.kind === 'bath' ? (i.swimsuit ? 1 : 0) : '', memo: i.memo,
    }));
  }
  // Excelで文字化けしないようBOMを付ける
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** RFC 4180 準拠の簡易パーサ。2次元配列を返す */
export function parseCSV(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * CSVテキストを検証して取り込み用データにする。
 * 1行でも不正があればエラー一覧を返し、呼び出し側は何も保存しない。
 * 予定の利用者は苗字（clientName）で返すので、呼び出し側で利用者に紐づける。
 */
export function importCSV(text) {
  const empty = { items: [], clients: [], days: [], errors: [] };
  const rows = parseCSV(text);
  if (!rows.length) return { ...empty, errors: ['CSVが空です'] };
  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(CSV_HEADER.map((h) => [h, header.indexOf(h)]));
  const errors = [];
  for (const h of ['record_type', 'date', 'start', 'kind']) {
    if (idx[h] < 0) errors.push(`見出し行に「${h}」列がありません（このアプリで書き出したCSVを使ってください）`);
  }
  if (errors.length) return { ...empty, errors };

  const get = (row, h) => (idx[h] >= 0 ? (row[idx[h]] ?? '').trim() : '');
  const getRaw = (row, h) => (idx[h] >= 0 ? (row[idx[h]] ?? '') : '');
  const items = [];
  const clients = [];
  const days = [];
  const seenDays = new Set();

  rows.slice(1).forEach((row, i) => {
    const ln = i + 2;
    const type = get(row, 'record_type');
    if (type === 'item') {
      const item = {
        id: get(row, 'id') || null, date: get(row, 'date'), start: get(row, 'start'), end: get(row, 'end'),
        clientName: get(row, 'client_name'), kind: get(row, 'kind'),
        swimsuit: get(row, 'swimsuit') === '1', memo: getRaw(row, 'memo'),
      };
      const err = validateItem(item);
      if (err) { errors.push(`${ln}行目: ${err}`); return; }
      if (!['', '0', '1'].includes(get(row, 'swimsuit'))) { errors.push(`${ln}行目: 水着は 1（あり）か 0（なし）にしてください`); return; }
      if (item.kind !== 'bath') item.swimsuit = false;
      items.push(item);
    } else if (type === 'day') {
      const day = {
        date: get(row, 'date'), start: get(row, 'start'), end: get(row, 'end'),
        breakStart: get(row, 'break_start'), breakEnd: get(row, 'break_end'),
      };
      const err = validateDay(day);
      if (err) { errors.push(`${ln}行目: ${err}`); return; }
      if (seenDays.has(day.date)) { errors.push(`${ln}行目: ${day.date} の勤務時間が重複しています`); return; }
      seenDays.add(day.date);
      days.push(day);
    } else if (type === 'client') {
      const name = get(row, 'client_name');
      const swimsuit = get(row, 'swimsuit') || 'unknown';
      if (!name) { errors.push(`${ln}行目: 利用者の苗字が空です`); return; }
      if (!SWIMSUIT_VALUES.includes(swimsuit)) { errors.push(`${ln}行目: 水着「${swimsuit}」は need / no / unknown のどれかにしてください`); return; }
      clients.push({ name, fullName: get(row, 'full_name'), town: get(row, 'town'), swimsuit, note: getRaw(row, 'client_note') });
    } else {
      errors.push(`${ln}行目: record_type「${type}」が不正です`);
    }
  });
  return { items, clients, days, errors };
}

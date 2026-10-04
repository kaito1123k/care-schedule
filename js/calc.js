// 予定データの検証・並べ替え・集計（DOMに依存しない純粋関数だけを置く）

export const KINDS = {
  bath: '入浴',
  move: '移動支援',
  other: 'その他',
};
export const KIND_KEYS = Object.keys(KINDS);

// 1日の勤務時間（出勤・休憩・退勤）を新しく入れるときの初期値
export const DEFAULT_DAY = { start: '09:00', breakStart: '12:00', breakEnd: '13:00', end: '18:00' };
// 出発は出勤の何分前か（設定で変更可）
export const DEFAULT_DEPART_MIN = 90;

// 利用者ごとの「入浴介助で水着がいるか」の初期値
export const SWIMSUIT_VALUES = ['need', 'no', 'unknown'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** "HH:MM" → 0時からの分。不正ならnull */
export function toMin(hhmm) {
  if (!isTime(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** 予定1件を検証する。問題がなければnull、あれば理由を返す */
export function validateItem(item) {
  if (!isDate(item.date)) return '日付を入力してください';
  if (!isTime(item.start)) return '開始時刻を入力してください';
  if (item.end) {
    if (!isTime(item.end)) return '終了時刻が正しくありません';
    if (toMin(item.end) <= toMin(item.start)) return '終了は開始より後の時刻にしてください';
  }
  if (!KIND_KEYS.includes(item.kind)) return '内容を選んでください';
  return null;
}

/**
 * 1日の勤務時間を検証する。出勤は必須、退勤は任意。
 * 休憩は「開始・終了の両方」か「両方なし」のどちらか。
 */
export function validateDay(day) {
  if (!isDate(day.date)) return '日付を入力してください';
  const s = toMin(day.start);
  if (s === null) return '出勤時刻を入力してください';
  const e = day.end ? toMin(day.end) : null;
  if (day.end && e === null) return '退勤時刻が正しくありません';
  if (e !== null && e <= s) return '退勤は出勤より後の時刻にしてください';
  if (!!day.breakStart !== !!day.breakEnd) return '休憩は開始と終了の両方を入力してください（休憩なしなら両方空欄）';
  if (day.breakStart) {
    const bs = toMin(day.breakStart);
    const be = toMin(day.breakEnd);
    if (bs === null || be === null) return '休憩の時刻が正しくありません';
    if (be <= bs) return '休憩の終わりは始まりより後の時刻にしてください';
    if (bs < s || (e !== null && be > e)) return '休憩は出勤〜退勤の間に入れてください';
  }
  return null;
}

/** 出勤時刻の offsetMin 分前の出発時刻。日をまたぐときは prevDay=true */
export function departTime(start, offsetMin) {
  const s = toMin(start);
  if (s === null) return null;
  let m = s - offsetMin;
  const prevDay = m < 0;
  if (prevDay) m += 1440;
  return { time: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, prevDay };
}

/**
 * 1日の流れを時間順に並べる：出発 → 出勤 → 予定・休憩 → 退勤
 * 同じ時刻のときは 出発・出勤・休憩・予定・退勤 の順にする
 */
export function buildTimeline(day, items, departMin) {
  const rows = [];
  if (day && isTime(day.start)) {
    const dep = departTime(day.start, departMin);
    rows.push({ type: 'depart', min: -Infinity, time: dep.time, prevDay: dep.prevDay });
    rows.push({ type: 'in', min: toMin(day.start), time: day.start });
    if (day.breakStart) rows.push({ type: 'break', min: toMin(day.breakStart), time: day.breakStart, end: day.breakEnd });
    if (day.end) rows.push({ type: 'out', min: toMin(day.end), time: day.end });
  }
  for (const item of items) rows.push({ type: 'item', min: toMin(item.start), time: item.start, item });
  const order = { depart: 0, in: 1, break: 2, item: 3, out: 4 };
  return rows.sort((a, b) => a.min - b.min || order[a.type] - order[b.type]);
}

/** 予定の長さ（分）。終了時刻がなければnull */
export function durationMin(item) {
  if (!isTime(item.start) || !isTime(item.end)) return null;
  const d = toMin(item.end) - toMin(item.start);
  return d > 0 ? d : null;
}

/** 開始時刻順に並べる */
export function sortItems(items) {
  return [...items].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

/** 同じ日で時間が重なっている予定のidを返す（終了時刻のある予定だけで判定） */
export function overlappingIds(dayItems) {
  const ids = new Set();
  const timed = sortItems(dayItems).filter((i) => durationMin(i) !== null);
  for (let a = 0; a < timed.length; a++) {
    for (let b = a + 1; b < timed.length; b++) {
      if (toMin(timed[b].start) >= toMin(timed[a].end)) break;
      ids.add(timed[a].id);
      ids.add(timed[b].id);
    }
  }
  return ids;
}

/** "YYYY-MM" の月の予定を内容別に数える */
export function summarizeMonth(items, ym) {
  const byKind = Object.fromEntries(KIND_KEYS.map((k) => [k, 0]));
  let total = 0;
  let swimsuit = 0;
  let minutes = 0;
  const days = new Set();
  for (const i of items) {
    if (!i.date.startsWith(ym + '-')) continue;
    total += 1;
    days.add(i.date);
    if (i.kind in byKind) byKind[i.kind] += 1;
    if (i.kind === 'bath' && i.swimsuit) swimsuit += 1;
    minutes += durationMin(i) || 0;
  }
  return { total, days: days.size, byKind, swimsuit, minutes };
}

const pad = (n) => String(n).padStart(2, '0');

export function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return dateStr(new Date(y, m - 1, d + n));
}

/**
 * 利用者を「よく行く順」に並べる。
 * 直近 recentDays 日（未来の予定も含む）に予定へ入れた回数が多い順、同じなら全期間の回数、
 * それも同じなら苗字順。ずっと前に担当が終わった人が上に残り続けないよう直近の回数を優先する。
 */
export function sortClientsByVisits(clients, items, today, recentDays = 90) {
  const since = addDays(today, -recentDays);
  const recent = new Map();
  const total = new Map();
  for (const i of items) {
    if (!i.clientId) continue;
    total.set(i.clientId, (total.get(i.clientId) || 0) + 1);
    if (i.date >= since) recent.set(i.clientId, (recent.get(i.clientId) || 0) + 1);
  }
  const r = (c) => recent.get(c.id) || 0;
  const t = (c) => total.get(c.id) || 0;
  return [...clients].sort((a, b) => r(b) - r(a) || t(b) - t(a) || a.name.localeCompare(b.name, 'ja'));
}

/** 土曜(6)・日曜(0)なら true */
export function isWeekend(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}

/** step 日ずつ進める。skipWeekend なら土日を飛ばして次の平日にする */
export function stepDay(date, step, skipWeekend) {
  let d = addDays(date, step);
  while (skipWeekend && isWeekend(d)) d = addDays(d, step);
  return d;
}

/** 分 → "1:30" 形式 */
export function fmtHM(min) {
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

/** "09:00" → "9:00"（画面表示用に先頭の0を外す） */
export function shortTime(t) {
  return isTime(t) ? t.replace(/^0/, '') : '';
}

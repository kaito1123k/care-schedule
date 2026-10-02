import {
  KINDS, KIND_KEYS, DEFAULT_DAY, DEFAULT_DEPART_MIN, validateItem, validateDay, buildTimeline, departTime,
  durationMin, sortItems, overlappingIds, summarizeMonth, dateStr, addDays, fmtHM, shortTime,
} from './calc.js';
import { toCSV, importCSV } from './csv.js';
import * as db from './db.js';

export const APP_VERSION = '3.1.0';

const $ = (id) => document.getElementById(id);
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const BACKUP_REMIND_DAYS = 30;
const SWIM_LABEL = { need: '水着いる', no: '水着いらない', unknown: '水着未確認' };

const state = {
  items: new Map(),
  days: new Map(), // 日付 → 出勤・休憩・退勤
  clients: new Map(),
  departMin: DEFAULT_DEPART_MIN,
  view: 'day',
  day: dateStr(new Date()),
  month: dateStr(new Date()).slice(0, 7),
  clientFilter: 'all',
  lastBackup: null,
};

/* ---------- 共通ヘルパー ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function today() {
  return dateStr(new Date());
}

function fmtDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}/${d}（${DOW[new Date(y, m - 1, d).getDay()]}）`;
}

function relDay(date) {
  const t = today();
  return { [t]: '今日', [addDays(t, 1)]: '明日', [addDays(t, 2)]: 'あさって', [addDays(t, -1)]: '昨日' }[date] || '';
}

/** 予定に紐づく利用者。削除済みでも予定に残した苗字を返す */
function clientOf(item) {
  return item.clientId ? state.clients.get(item.clientId) || null : null;
}
function clientNameOf(item) {
  return clientOf(item)?.name || item.clientName || '';
}

function sortedClients() {
  return [...state.clients.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

function itemsOn(date) {
  return sortItems([...state.items.values()].filter((i) => i.date === date));
}

async function saveItem(item) {
  await db.putItem(item);
  state.items.set(item.id, item);
}

async function removeItem(id) {
  await db.deleteItem(id);
  state.items.delete(id);
}

/* ---------- トースト ---------- */

let toastTimer = null;
function toast(msg, actions = []) {
  $('toast-msg').textContent = msg;
  const box = $('toast-actions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    b.addEventListener('click', () => { $('toast').hidden = true; a.onClick(); });
    box.appendChild(b);
  }
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, actions.length ? 8000 : 3500);
}

/* ---------- 画面切り替え ---------- */

function setView(view) {
  state.view = view;
  for (const sec of document.querySelectorAll('.view')) sec.hidden = sec.id !== `view-${view}`;
  for (const b of document.querySelectorAll('.tabbar button')) {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('view-title').textContent = $(`view-${view}`).dataset.title;
  render();
  window.scrollTo(0, 0);
}

function render() {
  ({ day: renderDay, calendar: renderCalendar, clients: renderClients, settings: renderSettings })[state.view]();
}

/* ---------- 1日の予定 ---------- */

function renderDay() {
  const d = state.day;
  const [y] = d.split('-');
  $('day-label').textContent = `${y}年${fmtDate(d)}`;
  $('day-rel').textContent = relDay(d);
  $('back-today').hidden = d === today();

  const items = itemsOn(d);
  const overlaps = overlappingIds(items);
  const bath = items.filter((i) => i.kind === 'bath');
  const swim = bath.filter((i) => i.swimsuit).length;
  const parts = KIND_KEYS.map((k) => [KINDS[k], items.filter((i) => i.kind === k).length]).filter(([, n]) => n);
  $('day-summary').innerHTML = items.length
    ? `予定 ${items.length}件（${parts.map(([l, n]) => `${l}${n}`).join('・')}）`
      + (swim ? `　<span class="swim-count">水着あり ${swim}件</span>` : '')
    : '';

  const day = state.days.get(d);
  const timeline = buildTimeline(day, items, state.departMin);
  $('item-list').innerHTML = timeline.length
    ? timeline.map((r) => (r.type === 'item' ? itemCard(r.item, overlaps.has(r.item.id)) : markRow(r))).join('')
    : '<li class="empty-day">この日の予定はありません</li>';
  $('edit-day').textContent = day ? '出勤・休憩・退勤を変更' : '出勤・休憩・退勤を入力';

  const days = state.lastBackup ? Math.floor((Date.now() - new Date(state.lastBackup)) / 86400000) : null;
  const needBackup = state.items.size > 0 && (days === null || days >= BACKUP_REMIND_DAYS);
  $('day-hint').textContent = needBackup
    ? 'しばらくバックアップしていません。設定 → 「CSVで書き出す」で保存しておくと安心です。'
    : '‹ › で前後の日に移動できます。予定をタップすると修正できます。';
}

/** 出発・出勤・休憩・退勤の行 */
function markRow(r) {
  const label = { depart: '出発', in: '出勤', break: '休憩', out: '退勤' }[r.type];
  let time = shortTime(r.time);
  let sub = '';
  if (r.type === 'break') time = `${shortTime(r.time)}〜${shortTime(r.end)}`;
  if (r.type === 'depart') sub = `出勤の${fmtHM(state.departMin)}前${r.prevDay ? '（前日）' : ''}`;
  return `<li><button type="button" class="mark m-${r.type}" data-day-edit>
    <span class="mlabel">${label}</span><span class="mtime">${esc(time)}</span><span class="msub">${esc(sub)}</span>
  </button></li>`;
}

function itemCard(i, overlap) {
  const name = clientNameOf(i);
  const c = clientOf(i);
  const dur = durationMin(i);
  const time = i.end ? `${shortTime(i.start)}〜${shortTime(i.end)}` : `${shortTime(i.start)}〜`;
  return `<li><button type="button" class="item k-${esc(i.kind)}${overlap ? ' overlap' : ''}" data-item="${esc(i.id)}">
    <span class="row"><span class="time">${esc(time)}</span>${dur ? `<span class="dur">${fmtHM(dur)}</span>` : ''}</span>
    <span class="who${name ? '' : ' none'}">${name ? `${esc(name)} さん` : '利用者なし'}${c?.town ? `<span class="town">${esc(c.town)}</span>` : ''}</span>
    <span class="tags"><span class="kind-tag">${esc(KINDS[i.kind])}</span>${i.kind === 'bath' && i.swimsuit ? '<span class="swim-tag">水着あり</span>' : ''}</span>
    ${i.memo ? `<span class="memo">${esc(i.memo)}</span>` : ''}
    ${c?.note ? `<span class="cnote">${esc(c.note)}</span>` : ''}
    ${overlap ? '<span class="warn">ほかの予定と時間が重なっています</span>' : ''}
  </button></li>`;
}

/* ---------- カレンダー ---------- */

function renderCalendar() {
  const [y, m] = state.month.split('-').map(Number);
  $('month-label').textContent = `${y}年${m}月`;
  const first = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const t = today();
  const byDate = new Map();
  for (const i of state.items.values()) {
    if (!i.date.startsWith(state.month + '-')) continue;
    if (!byDate.has(i.date)) byDate.set(i.date, []);
    byDate.get(i.date).push(i);
  }
  let html = DOW.map((d, i) => `<div class="cal-dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}" role="columnheader">${d}</div>`).join('');
  for (let i = 0; i < first; i++) html += '<div class="cal-blank"></div>';
  for (let d = 1; d <= days; d++) {
    const date = `${state.month}-${String(d).padStart(2, '0')}`;
    const list = sortItems(byDate.get(date) || []);
    const cls = ['cal-day'];
    if (date === t) cls.push('today');
    let inner = `<span class="d">${d}</span>`;
    let label = `${m}月${d}日 予定なし`;
    const day = state.days.get(date);
    if (day) {
      cls.push('has');
      inner += `<span class="in">${esc(shortTime(day.start))}</span>`;
      label = `${m}月${d}日 ${shortTime(day.start)}出勤`;
    }
    if (list.length) {
      cls.push('has');
      inner += `<span class="dots">${list.slice(0, 6).map((i) => `<span class="dot k-${esc(i.kind)}"></span>`).join('')}</span>`;
      if (list.some((i) => i.kind === 'bath' && i.swimsuit)) inner += '<span class="swim-mark">水</span>';
      else if (!day) inner += `<span class="cnt">${list.length}件</span>`;
      label += ` 予定${list.length}件`;
    }
    html += `<button type="button" class="${cls.join(' ')}" data-date="${date}" aria-label="${esc(label)}">${inner}</button>`;
  }
  $('calendar').innerHTML = html;

  const s = summarizeMonth([...state.items.values()], state.month);
  const rows = [
    ['予定のある日', `${s.days}日`],
    ['予定の合計', `${s.total}件`],
    ...KIND_KEYS.map((k) => [`<span class="dot k-${k}"></span>${KINDS[k]}`, `${s.byKind[k]}件`]),
    ['<span class="swim-mark">水</span>水着あり', `${s.swimsuit}件`],
  ];
  $('month-summary').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

/* ---------- 予定の追加・編集 ---------- */

let editing = null; // { isNew, item }

function openItem(item, isNew) {
  editing = { isNew, item: { ...item } };
  $('item-title').textContent = isNew ? '予定の追加' : '予定の修正';
  $('i-date').value = item.date;
  $('i-start').value = item.start || '';
  $('i-end').value = item.end || '';
  $('i-memo').value = item.memo || '';
  $('i-error').hidden = true;
  $('i-sub').hidden = isNew;
  renderClientSelect();
  renderItemKind();
  $('item-dialog').showModal();
  $('item-dialog').scrollTop = 0;
}

function newItem(date) {
  return { id: null, date, start: '', end: '', clientId: null, clientName: '', kind: 'bath', swimsuit: false, memo: '' };
}

function renderClientSelect() {
  const it = editing.item;
  const opts = ['<option value="">（選ばない）</option>'];
  for (const c of sortedClients()) {
    opts.push(`<option value="${esc(c.id)}"${c.id === it.clientId ? ' selected' : ''}>${esc(c.name)} さん</option>`);
  }
  // 削除済みの利用者でも、予定に残った苗字は選択肢に出して消えないようにする
  if (it.clientName && !clientOf(it)) {
    opts.push(`<option value="__keep__" selected>${esc(it.clientName)} さん（登録なし）</option>`);
  }
  opts.push('<option value="__new__">＋ 新しい利用者を登録…</option>');
  $('i-client').innerHTML = opts.join('');
  const c = clientOf(it);
  $('i-client-info').hidden = !c;
  if (c) {
    const rows = [
      ['フルネーム', c.fullName], ['町', c.town], ['入浴の水着', SWIM_LABEL[c.swimsuit]], ['内容', c.note],
    ].filter(([, v]) => v);
    $('i-client-detail').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  }
}

function renderItemKind() {
  const it = editing.item;
  for (const b of $('i-kind').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.kind === it.kind));
  $('i-swim-field').hidden = it.kind !== 'bath';
  for (const b of $('i-swim').querySelectorAll('button')) b.setAttribute('aria-checked', String((b.dataset.swim === '1') === !!it.swimsuit));
  const c = clientOf(it);
  $('i-swim-hint').textContent = c
    ? `${c.name} さんは「${SWIM_LABEL[c.swimsuit]}」で登録されています`
    : '';
}

/** 利用者の登録内容から「水着あり／なし」の初期値を決める */
function applyClientSwimDefault() {
  const c = clientOf(editing.item);
  if (c && c.swimsuit !== 'unknown') editing.item.swimsuit = c.swimsuit === 'need';
}

/** 予定ダイアログから、選んでいる利用者の情報を変更する */
function editClientFromItem() {
  const c = clientOf(editing.item);
  if (!c) return;
  openClient(c.id, (saved) => {
    editing.item.clientName = saved.name;
    renderClientSelect();
    renderItemKind();
  });
}

function onClientChange() {
  const v = $('i-client').value;
  if (v === '__new__') {
    openClient(null, (created) => {
      editing.item.clientId = created.id;
      editing.item.clientName = created.name;
      applyClientSwimDefault();
      renderClientSelect();
      renderItemKind();
    });
    renderClientSelect(); // 登録をやめたときに元の選択へ戻す
    return;
  }
  if (v === '__keep__') return;
  const c = state.clients.get(v);
  editing.item.clientId = c ? c.id : null;
  editing.item.clientName = c ? c.name : '';
  applyClientSwimDefault();
  renderClientSelect();
  renderItemKind();
}

async function submitItem(e) {
  e.preventDefault();
  const it = {
    ...editing.item,
    date: $('i-date').value,
    start: $('i-start').value,
    end: $('i-end').value,
    memo: $('i-memo').value.trim(),
  };
  if (it.kind !== 'bath') it.swimsuit = false;
  const err = validateItem(it);
  if (err) {
    $('i-error').textContent = err;
    $('i-error').hidden = false;
    $('i-error').scrollIntoView({ block: 'center' });
    return;
  }
  const before = editing.isNew ? null : state.items.get(it.id);
  it.id = it.id || db.newId();
  it.clientName = clientNameOf(it);
  await saveItem(it);
  $('item-dialog').close();
  state.day = it.date;
  render();
  toast(`${fmtDate(it.date)}の予定を保存しました`, [{
    label: '取り消す',
    onClick: async () => {
      if (before) await saveItem(before);
      else await removeItem(it.id);
      render();
    },
  }]);
}

async function deleteCurrentItem() {
  const prev = state.items.get(editing.item.id);
  if (!prev || !confirm('この予定を削除しますか？')) return;
  await removeItem(prev.id);
  $('item-dialog').close();
  render();
  toast('削除しました', [{ label: '取り消す', onClick: async () => { await saveItem(prev); render(); } }]);
}

function copyCurrentItem() {
  const src = editing.item;
  $('item-dialog').close();
  openItem({ ...src, id: null, date: addDays(src.date, 7) }, true);
  $('item-title').textContent = '予定のコピー（日付を確認してください）';
}

/* ---------- 出勤・休憩・退勤 ---------- */

/** 新しい日は、直前に入力した日の時刻を初期値にする（なければ DEFAULT_DAY） */
function dayDefaults(date) {
  const prev = [...state.days.values()].filter((d) => d.date < date).sort((a, b) => b.date.localeCompare(a.date))[0];
  const src = prev || DEFAULT_DAY;
  return { date, start: src.start, breakStart: src.breakStart, breakEnd: src.breakEnd, end: src.end };
}

function openDay() {
  const date = state.day;
  const existing = state.days.get(date);
  const d = existing || dayDefaults(date);
  $('day-title').textContent = `${fmtDate(date)}の出勤・休憩・退勤`;
  $('d-start').value = d.start || '';
  $('d-break-start').value = d.breakStart || '';
  $('d-break-end').value = d.breakEnd || '';
  $('d-end').value = d.end || '';
  $('d-error').hidden = true;
  $('d-delete').hidden = !existing;
  updateDepartPreview();
  $('day-dialog').showModal();
  $('day-dialog').scrollTop = 0;
}

function updateDepartPreview() {
  const dep = departTime($('d-start').value, state.departMin);
  $('d-depart').textContent = dep
    ? `出発 ${shortTime(dep.time)}${dep.prevDay ? '（前日）' : ''}（出勤の${fmtHM(state.departMin)}前）`
    : '出勤時刻を入れると出発時刻を表示します';
}

async function submitDay(e) {
  e.preventDefault();
  const day = {
    date: state.day, start: $('d-start').value, end: $('d-end').value,
    breakStart: $('d-break-start').value, breakEnd: $('d-break-end').value,
  };
  const err = validateDay(day);
  if (err) {
    $('d-error').textContent = err;
    $('d-error').hidden = false;
    return;
  }
  const before = state.days.get(day.date);
  await db.putDay(day);
  state.days.set(day.date, day);
  $('day-dialog').close();
  render();
  toast(`${fmtDate(day.date)}の出勤・退勤を保存しました`, [{
    label: '取り消す',
    onClick: async () => {
      if (before) { await db.putDay(before); state.days.set(before.date, before); } else { await db.deleteDay(day.date); state.days.delete(day.date); }
      render();
    },
  }]);
}

async function deleteDay() {
  const prev = state.days.get(state.day);
  if (!prev || !confirm(`${fmtDate(prev.date)}の出勤・休憩・退勤を消しますか？（予定は残ります）`)) return;
  await db.deleteDay(prev.date);
  state.days.delete(prev.date);
  $('day-dialog').close();
  render();
  toast('消しました', [{ label: '取り消す', onClick: async () => { await db.putDay(prev); state.days.set(prev.date, prev); render(); } }]);
}

/* ---------- 利用者 ---------- */

function renderClients() {
  for (const b of $('client-filter').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.filter === state.clientFilter));
  }
  const q = $('client-search').value.trim();
  const list = sortedClients()
    .filter((c) => state.clientFilter === 'all' || c.swimsuit === state.clientFilter)
    .filter((c) => !q || [c.name, c.fullName, c.town].some((v) => v && v.includes(q)));
  $('client-list').innerHTML = list.length
    ? list.map((c) => `<li><button type="button" class="client-item" data-client="${esc(c.id)}">
        <span class="top"><span class="name">${esc(c.name)} さん</span><span class="badge badge-${esc(c.swimsuit)}">${SWIM_LABEL[c.swimsuit]}</span></span>
        ${c.fullName || c.town ? `<span class="sub2">${esc([c.fullName, c.town].filter(Boolean).join('・'))}</span>` : ''}
        ${c.note ? `<span class="note">${esc(c.note)}</span>` : ''}
      </button></li>`).join('')
    : `<li class="empty">${state.clients.size ? '該当する利用者はいません' : 'まだ登録されていません。「＋ 追加」から登録できます。'}</li>`;
}

let editingClient = null; // { client, onSaved }

function openClient(id, onSaved = null) {
  const existing = id ? state.clients.get(id) : null;
  editingClient = {
    client: existing ? { ...existing } : { id: null, name: '', fullName: '', town: '', swimsuit: 'unknown', note: '' },
    onSaved,
  };
  $('client-title').textContent = existing ? `${existing.name} さん` : '利用者の追加';
  $('c-name').value = editingClient.client.name;
  $('c-fullname').value = editingClient.client.fullName || '';
  $('c-town').value = editingClient.client.town || '';
  $('c-note').value = editingClient.client.note;
  $('c-error').hidden = true;
  $('c-delete').hidden = !existing;
  renderSwimPicker();
  $('client-dialog').showModal();
  $('client-dialog').scrollTop = 0;
}

function renderSwimPicker() {
  for (const b of $('c-swim').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.swim === editingClient.client.swimsuit));
  }
}

async function submitClient(e) {
  e.preventDefault();
  const name = $('c-name').value.trim();
  const showErr = (msg) => { $('c-error').textContent = msg; $('c-error').hidden = false; };
  if (!name) { showErr('苗字を入力してください'); return; }
  if (/\s/.test(name)) { showErr('「苗字」の欄にスペースが入っています。フルネームは下の欄に入れてください'); return; }
  const cur = editingClient.client;
  const dup = [...state.clients.values()].find((c) => c.name === name && c.id !== cur.id);
  if (dup && !confirm(`「${name}」さんはすでに登録されています。別の方として追加しますか？`)) return;
  const client = {
    ...cur, name, fullName: $('c-fullname').value.trim(), town: $('c-town').value.trim(),
    note: $('c-note').value.trim(), id: cur.id || db.newId(),
  };
  await db.putClient(client);
  state.clients.set(client.id, client);
  $('client-dialog').close();
  if (editingClient.onSaved) editingClient.onSaved(client);
  render();
  toast(`${name} さんを保存しました`);
}

async function deleteCurrentClient() {
  const c = state.clients.get(editingClient.client.id);
  if (!c) return;
  const used = [...state.items.values()].filter((i) => i.clientId === c.id).length;
  const msg = used
    ? `${c.name} さんを削除しますか？\n（${used}件の予定には苗字だけが残ります）`
    : `${c.name} さんを削除しますか？`;
  if (!confirm(msg)) return;
  await db.deleteClient(c.id);
  state.clients.delete(c.id);
  $('client-dialog').close();
  render();
  toast('削除しました', [{
    label: '取り消す',
    onClick: async () => { await db.putClient(c); state.clients.set(c.id, c); render(); },
  }]);
}

/* ---------- 設定 ---------- */

function renderSettings() {
  $('depart-min').value = state.departMin;
  $('theme-select').value = document.documentElement.dataset.theme || 'auto';
  $('backup-info').textContent = state.lastBackup
    ? `最後に書き出した日：${new Date(state.lastBackup).toLocaleDateString('ja-JP')}`
    : 'まだ書き出していません。iPhoneの故障や機種変更に備えて、月に1回は書き出してください。';
  $('app-version').textContent = `バージョン ${APP_VERSION} ・ データはこのiPhone内（IndexedDB）にだけ保存されます`;
}

async function saveDepart(e) {
  e.preventDefault();
  const v = $('depart-min').value;
  if (!/^\d+$/.test(v) || Number(v) > 600) { alert('0〜600の数字（分）で入力してください'); return; }
  state.departMin = Number(v);
  await db.setSetting('departMin', state.departMin);
  render();
  toast(`出発を出勤の${fmtHM(state.departMin)}前にしました`);
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

async function exportCSV() {
  const items = sortItems([...state.items.values()]);
  const days = [...state.days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const csv = toCSV(items, sortedClients(), clientNameOf, days);
  const name = `care-schedule-${today()}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  try {
    // iPhoneでは共有シートから「ファイルに保存」できる
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // 共有シートを閉じた
    alert(`書き出しに失敗しました：${err.message}`);
    return;
  }
  state.lastBackup = new Date().toISOString();
  await db.setSetting('lastBackup', state.lastBackup);
  render();
  toast(`予定${state.items.size}件・利用者${state.clients.size}人を書き出しました`);
}

async function importFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let parsed;
  try {
    parsed = importCSV(await file.text());
  } catch (err) {
    alert(`CSVを読めませんでした：${err.message}`);
    return;
  }
  if (parsed.errors.length) {
    const more = parsed.errors.length > 8 ? `\n…ほか${parsed.errors.length - 8}件` : '';
    alert(`CSVに問題があるため読み込みを中止しました（何も変更していません）。\n\n${parsed.errors.slice(0, 8).join('\n')}${more}`);
    return;
  }
  if (!confirm(`予定${parsed.items.length}件・出勤退勤${parsed.days.length}日分・利用者${parsed.clients.length}人を読み込みます。\n同じ予定・同じ日・同じ苗字の利用者は置き換わります。\nよろしいですか？`)) return;
  await db.importAll(parsed.items, parsed.clients, parsed.days, [...state.clients.values()]);
  await loadData();
  render();
  toast('読み込みました');
}

async function clearAll() {
  if (!confirm('全ての予定・利用者・設定を削除します。\n先にCSVで書き出しておくことをおすすめします。\n削除しますか？')) return;
  if (!confirm('本当に削除しますか？この操作は元に戻せません。')) return;
  await db.clearAll();
  await loadData();
  render();
  toast('全データを削除しました');
}

/* ---------- 起動 ---------- */

async function loadData() {
  const [items, days, clients, departMin, theme, lastBackup] = await Promise.all([
    db.getAllItems(),
    db.getAllDays(),
    db.getAllClients(),
    db.getSetting('departMin', DEFAULT_DEPART_MIN),
    db.getSetting('theme', 'auto'),
    db.getSetting('lastBackup', null),
  ]);
  state.items = new Map(items.map((i) => [i.id, i]));
  state.days = new Map(days.map((d) => [d.date, d]));
  state.clients = new Map(clients.map((c) => [c.id, c]));
  state.departMin = departMin;
  state.lastBackup = lastBackup;
  applyTheme(theme);
}

function bindEvents() {
  for (const b of document.querySelectorAll('.tabbar button')) b.addEventListener('click', () => setView(b.dataset.view));

  for (const b of document.querySelectorAll('[data-day-step]')) {
    b.addEventListener('click', () => { state.day = addDays(state.day, Number(b.dataset.dayStep)); renderDay(); });
  }
  $('back-today').addEventListener('click', () => { state.day = today(); renderDay(); });
  $('add-item').addEventListener('click', () => openItem(newItem(state.day), true));
  $('edit-day').addEventListener('click', openDay);
  $('day-form').addEventListener('submit', submitDay);
  $('d-cancel').addEventListener('click', () => $('day-dialog').close());
  $('d-delete').addEventListener('click', deleteDay);
  $('d-start').addEventListener('input', updateDepartPreview);
  $('d-no-break').addEventListener('click', () => { $('d-break-start').value = ''; $('d-break-end').value = ''; });

  for (const b of document.querySelectorAll('[data-month-step]')) {
    b.addEventListener('click', () => {
      const [y, m] = state.month.split('-').map(Number);
      state.month = dateStr(new Date(y, m - 1 + Number(b.dataset.monthStep), 1)).slice(0, 7);
      renderCalendar();
    });
  }

  // 予定・日付・利用者のタップ
  document.querySelector('main').addEventListener('click', (e) => {
    if (e.target.closest('[data-day-edit]')) { openDay(); return; }
    const it = e.target.closest('[data-item]');
    if (it) { openItem(state.items.get(it.dataset.item), false); return; }
    const d = e.target.closest('[data-date]');
    if (d) { state.day = d.dataset.date; setView('day'); return; }
    const c = e.target.closest('[data-client]');
    if (c) openClient(c.dataset.client);
  });

  // 予定ダイアログ
  $('item-form').addEventListener('submit', submitItem);
  $('i-cancel').addEventListener('click', () => $('item-dialog').close());
  $('i-delete').addEventListener('click', deleteCurrentItem);
  $('i-copy').addEventListener('click', copyCurrentItem);
  $('i-client').addEventListener('change', onClientChange);
  $('i-client-edit').addEventListener('click', editClientFromItem);
  $('i-kind').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    const wasBath = editing.item.kind === 'bath';
    editing.item.kind = b.dataset.kind;
    if (!wasBath && editing.item.kind === 'bath') applyClientSwimDefault();
    renderItemKind();
  });
  $('i-swim').addEventListener('click', (e) => {
    const b = e.target.closest('[data-swim]');
    if (!b) return;
    editing.item.swimsuit = b.dataset.swim === '1';
    renderItemKind();
  });

  // 利用者
  $('add-client').addEventListener('click', () => openClient(null));
  $('client-search').addEventListener('input', renderClients);
  $('client-filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    state.clientFilter = b.dataset.filter;
    renderClients();
  });
  $('client-form').addEventListener('submit', submitClient);
  $('c-cancel').addEventListener('click', () => $('client-dialog').close());
  $('c-delete').addEventListener('click', deleteCurrentClient);
  $('c-swim').addEventListener('click', (e) => {
    const b = e.target.closest('[data-swim]');
    if (!b) return;
    editingClient.client.swimsuit = b.dataset.swim;
    renderSwimPicker();
  });

  // 設定
  $('depart-form').addEventListener('submit', saveDepart);
  $('theme-select').addEventListener('change', async (e) => {
    applyTheme(e.target.value);
    await db.setSetting('theme', e.target.value);
  });
  $('export-csv').addEventListener('click', exportCSV);
  $('import-csv').addEventListener('change', importFile);
  $('clear-all').addEventListener('click', clearAll);

  // アプリに戻ってきたときに「今日」「明日」などの表示を更新
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('アプリを更新しました', [{ label: '再読み込み', onClick: () => location.reload() }]);
  });
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('service worker', err));
}

async function init() {
  bindEvents();
  try {
    await loadData();
  } catch (err) {
    $('item-list').textContent = `データを読み込めませんでした：${err.message}`;
    return;
  }
  // 「ホーム画面に追加」したアプリのデータが勝手に消されないよう永続化を依頼する
  navigator.storage?.persist?.().catch(() => {});
  setView('day');
  registerSW();
}

init();

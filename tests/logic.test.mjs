// 実行: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateItem, validateDay, departTime, buildTimeline, isWeekend, stepDay, sortClientsByVisits, durationMin, sortItems, overlappingIds, summarizeMonth, isDate, addDays, fmtHM, shortTime } from '../js/calc.js';
import { toCSV, parseCSV, importCSV } from '../js/csv.js';

const item = (o) => ({ id: 'x', date: '2026-10-02', start: '09:00', end: '10:30', kind: 'bath', swimsuit: false, memo: '', ...o });

test('予定の検証', () => {
  assert.equal(validateItem(item({})), null);
  assert.equal(validateItem(item({ end: '' })), null); // 終了なしもOK
  assert.match(validateItem(item({ start: '' })), /開始/);
  assert.match(validateItem(item({ end: '08:00' })), /終了は開始より後/);
  assert.match(validateItem(item({ kind: 'xx' })), /内容/);
  assert.match(validateItem(item({ date: '2026-02-30' })), /日付/);
});

test('長さ・並び順・重なり', () => {
  assert.equal(durationMin(item({})), 90);
  assert.equal(durationMin(item({ end: '' })), null);
  const list = [
    item({ id: 'c', start: '13:00', end: '15:00' }),
    item({ id: 'a', start: '09:00', end: '10:30' }),
    item({ id: 'b', start: '10:00', end: '11:00' }),
    item({ id: 'd', start: '15:00', end: '' }),
  ];
  assert.deepEqual(sortItems(list).map((i) => i.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...overlappingIds(list)].sort(), ['a', 'b']);
});

test('月の集計（内容別・水着あり）', () => {
  const list = [
    item({ id: '1', kind: 'bath', swimsuit: true }),
    item({ id: '2', kind: 'bath', start: '11:00', end: '12:00' }),
    item({ id: '3', kind: 'move', date: '2026-10-05', start: '13:00', end: '16:00' }),
    item({ id: '4', kind: 'other', date: '2026-10-05', end: '' }),
    item({ id: '5', kind: 'move', date: '2026-11-01' }),
  ];
  const s = summarizeMonth(list, '2026-10');
  assert.deepEqual(s.byKind, { bath: 2, move: 1, other: 1 });
  assert.equal(s.total, 4);
  assert.equal(s.days, 2);
  assert.equal(s.swimsuit, 1);
  assert.equal(s.minutes, 90 + 60 + 180);
});

test('日付・表示ユーティリティ', () => {
  assert.equal(isDate('2028-02-29'), true);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(fmtHM(90), '1:30');
  assert.equal(shortTime('09:05'), '9:05');
});

test('CSV 書き出し→読み込みで予定と利用者が戻る', () => {
  const clients = [{ name: '山田', fullName: '', town: '', swimsuit: 'need', note: '右側から介助\n声かけ"ゆっくり"' }, { name: '佐藤', fullName: '佐藤 一郎', town: '△△町', swimsuit: 'unknown', note: '' }];
  const items = [
    item({ id: 'i1', clientName: '山田', swimsuit: true, memo: '午前, 2階' }),
    item({ id: 'i2', kind: 'move', start: '13:00', end: '', clientName: '佐藤', swimsuit: false }),
    item({ id: 'i3', kind: 'other', start: '17:00', end: '17:30', clientName: '' }),
  ];
  const back = importCSV(toCSV(items, clients, (i) => i.clientName));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.clients, clients);
  assert.deepEqual(back.items, items.map(({ ...i }) => i));
});

test('入浴以外は水着ありにならない', () => {
  const csv = 'record_type,id,date,start,end,client_name,kind,swimsuit\nitem,a,2026-10-02,09:00,,,move,1\n';
  assert.equal(importCSV(csv).items[0].swimsuit, false);
});

test('不正なCSVは1件も取り込まずエラーを返す', () => {
  const bad = [
    'record_type,id,date,start,end,client_name,kind,swimsuit',
    'item,a,2026-13-01,09:00,,,bath,',
    'item,b,2026-10-02,10:00,09:00,,bath,',
    'item,c,2026-10-02,10:00,,,walk,',
    'client,,,,,,,maybe',
  ].join('\n');
  assert.equal(importCSV(bad).errors.length, 4);
  assert.equal(importCSV('a,b\n1,2').errors.length > 0, true);
  assert.deepEqual(parseCSV('a,"b,c"\r\n"x""y",z'), [['a', 'b,c'], ['x"y', 'z']]);
});

test('出勤・休憩・退勤の検証', () => {
  const d = { date: '2026-10-02', start: '09:00', breakStart: '12:00', breakEnd: '13:00', end: '18:00' };
  assert.equal(validateDay(d), null);
  assert.equal(validateDay({ ...d, end: '' }), null); // 退勤なしもOK
  assert.equal(validateDay({ ...d, breakStart: '', breakEnd: '' }), null);
  assert.match(validateDay({ ...d, start: '' }), /出勤/);
  assert.match(validateDay({ ...d, end: '08:00' }), /退勤は出勤より後/);
  assert.match(validateDay({ ...d, breakEnd: '' }), /両方/);
  assert.match(validateDay({ ...d, breakStart: '08:00' }), /出勤〜退勤の間/);
});

test('出発は出勤の1時間30分前', () => {
  assert.deepEqual(departTime('09:00', 90), { time: '07:30', prevDay: false });
  assert.deepEqual(departTime('01:00', 90), { time: '23:30', prevDay: true });
  assert.equal(departTime('', 90), null);
});

test('1日の流れは 出発→出勤→予定・休憩→退勤 の順', () => {
  const day = { date: '2026-10-02', start: '09:00', breakStart: '12:00', breakEnd: '13:00', end: '18:00' };
  const items = [
    item({ id: 'p', start: '14:00', end: '15:00' }),
    item({ id: 'a', start: '09:00', end: '10:00' }),
    item({ id: 'b', start: '12:00', end: '' }),
  ];
  const t = buildTimeline(day, items, 90).map((r) => (r.type === 'item' ? r.item.id : r.type));
  assert.deepEqual(t, ['depart', 'in', 'a', 'break', 'b', 'p', 'out']);
  assert.deepEqual(buildTimeline(null, items, 90).map((r) => r.item.id), ['a', 'b', 'p']);
});

test('CSV：出勤・退勤と利用者のフルネーム・町も戻る', () => {
  const days = [{ date: '2026-10-02', start: '09:00', breakStart: '12:00', breakEnd: '13:00', end: '' }];
  const clients = [{ name: '山田', fullName: '山田 花子', town: '〇〇町', swimsuit: 'need', note: '' }];
  const back = importCSV(toCSV([], clients, () => '', days));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.days, days);
  assert.deepEqual(back.clients, clients);
});

test('土日の判定と、土日を飛ばす日付移動', () => {
  assert.equal(isWeekend('2026-10-03'), true); // 土
  assert.equal(isWeekend('2026-10-04'), true); // 日
  assert.equal(isWeekend('2026-10-05'), false); // 月
  assert.equal(stepDay('2026-10-02', 1, true), '2026-10-05'); // 金→月
  assert.equal(stepDay('2026-10-05', -1, true), '2026-10-02'); // 月→金
  assert.equal(stepDay('2026-10-04', 1, true), '2026-10-05'); // 日→月
  assert.equal(stepDay('2026-10-02', 1, false), '2026-10-03');
});

test('利用者はよく行く順（直近90日の回数→全期間→苗字）', () => {
  const clients = [{ id: 'a', name: '青木' }, { id: 'b', name: '井上' }, { id: 'c', name: '上田' }, { id: 'd', name: '江藤' }];
  const items = [
    item({ id: '1', clientId: 'b', date: '2026-10-01' }),
    item({ id: '2', clientId: 'b', date: '2026-10-08' }), // 未来の予定も数える
    item({ id: '3', clientId: 'c', date: '2026-09-20' }),
    item({ id: '4', clientId: 'a', date: '2026-01-10' }), // 90日より前
    item({ id: '5', clientId: 'a', date: '2026-01-17' }),
    item({ id: '6', clientId: 'a', date: '2026-01-24' }),
  ];
  assert.deepEqual(sortClientsByVisits(clients, items, '2026-10-05').map((c) => c.id), ['b', 'c', 'a', 'd']);
});

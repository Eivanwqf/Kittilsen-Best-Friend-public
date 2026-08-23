// M0 spike ①：sqlite-vec 在 WSL2 + better-sqlite3 下可用性验证
// 结论（2026-08-01）：
//  - linux-x64 预编译扩展经 load(db) 直接加载成功
//  - BUG: 参数化绑定的 rowid 报 "Only integers are allows for primary key values"
//         → 绕开：rowid 用字面量拼 SQL（rowid 为系统管理 id，无注入风险），向量参数化绑定
//  - KNN 查询参数化 match 正常
import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';

const db = new Database(':memory:');
load(db);
console.log('vec extension version:', db.prepare('select vec_version() v').get().v);

// 建 1024 维 vec0 表（与生产 schema 同维度）
db.exec('create virtual table vec_spike using vec0(v float[1024])');

function randVec(seed) {
  const arr = new Float32Array(1024);
  let s = seed;
  for (let i = 0; i < 1024; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; arr[i] = (s % 2000) / 1000 - 1; }
  return arr;
}
const v1 = randVec(1), v2 = randVec(2), v3 = randVec(1); // v3 与 v1 同种子 → 高相似

// rowid 字面量 + 向量参数化绑定（绕开 0.1.9 rowid 绑定 bug）
db.prepare('insert into vec_spike(rowid, v) values (1, ?)').run(Buffer.from(v1.buffer));
db.prepare('insert into vec_spike(rowid, v) values (2, ?)').run(Buffer.from(v2.buffer));
db.prepare('insert into vec_spike(rowid, v) values (3, ?)').run(Buffer.from(v3.buffer));

const rows = db.prepare('select rowid, distance from vec_spike where v match ? order by distance limit 2')
  .all(Buffer.from(v1.buffer));
console.log('KNN results:', JSON.stringify(rows));

// v1/v3 同种子 → 两条 distance 0（顺序不保证），v2 不同种子不在 top2
const ids = rows.map(r => r.rowid).sort();
const ok = ids[0] === 1 && ids[1] === 3 && rows.every(r => r.distance === 0);
console.log(ok ? 'SPIKE PASS' : 'SPIKE FAIL');
process.exit(ok ? 0 : 1);

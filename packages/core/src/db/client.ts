// SQLite 客户端：打开数据库 + 加载 sqlite-vec + 幂等迁移
import Database from 'better-sqlite3';
import { load } from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

export type KbfDb = Database.Database;

export function openDatabase(path: string): KbfDb {
  // 全新环境 data/ 目录不存在时自动创建（否则 better-sqlite3 打开失败）
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  load(db); // sqlite-vec 扩展（linux-x64 预编译，WSL2 已验证）
  migrate(db);
  return db;
}

export function migrate(db: KbfDb): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('begin');
    try {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
      db.exec('commit');
    } catch (err) {
      db.exec('rollback');
      throw new Error(`migration v${v + 1} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

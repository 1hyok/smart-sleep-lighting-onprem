// SQLite 어댑터.
// - Bun 런타임: bun:sqlite (네이티브, 빌드 불필요)
// - Node.js (RPi 배포): better-sqlite3
//
// 두 드라이버의 API 차이를 이 모듈에서 흡수 → 호출부는 동일한 인터페이스 사용.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const IS_BUN = typeof Bun !== 'undefined';

let _db = null;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Bun sqlite wrapper ────────────────────────────────────────────────────────
// bun:sqlite API: db.prepare(sql).run(...) / .get(...) / db.exec(sql)
// better-sqlite3 API: 동일 (의도적으로 호환 설계됨)
// 따라서 실제 래핑은 최소화.

function openBun() {
  const { Database } = require('bun:sqlite');
  ensureDir(config.db.path);
  const db = new Database(config.db.path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  // bun:sqlite는 PRAGMA를 포함한 multi-statement exec 지원
  db.exec(schema);
  return db;
}

function openNode() {
  const Database = require('better-sqlite3');
  ensureDir(config.db.path);
  const db = new Database(config.db.path);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  return db;
}

function getDb() {
  if (_db) return _db;

  if (IS_BUN) {
    _db = openBun();
  } else {
    _db = openNode();
  }

  console.log(`[DB] SQLite 초기화 완료 (${IS_BUN ? 'bun:sqlite' : 'better-sqlite3'}): ${config.db.path}`);
  return _db;
}

module.exports = { getDb };

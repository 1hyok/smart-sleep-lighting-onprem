// SQLite 어댑터.
// 우선순위: bun:sqlite (Bun) > better-sqlite3 (Node.js RPi) > sql.js (Node.js Windows dev)
// 모든 드라이버의 API는 동기.
// sql.js는 WASM 초기화가 필요하므로 openSqlJs()만 async.
// sql.js는 .get()/.all() 미지원 → wrapSqlJs()로 호환 레이어를 씌운다.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const IS_BUN = typeof Bun !== 'undefined';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let _db = null;
let _driver = null;
let _initPromise = null;

// ── sql.js 호환 레이어 ──────────────────────────────────────────────────────────
// sql.js Statement는 .get()/.all() 없음 → step()+getAsObject()로 흉내 낸다.
function wrapSqlJs(sqlJsDb) {
  return {
    _raw: sqlJsDb,
    prepare(sql) {
      const stmt = sqlJsDb.prepare(sql);
      return {
        bind(...args) { stmt.bind(args); return this; },
        step() { return stmt.step(); },
        getAsObject() { return stmt.getAsObject(); },
        get(...args) {
          if (args.length) stmt.bind(args);
          stmt.step();
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        },
        all(...args) {
          if (args.length) stmt.bind(args);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
          return rows;
        },
        run(...args) {
          if (args.length) stmt.bind(args);
          stmt.step();
          stmt.free();
          const changes = sqlJsDb.getRowsModified();
          let lastInsertRowid = 0;
          try {
            const rid = sqlJsDb.exec('SELECT last_insert_rowid() AS id');
            if (rid?.[0]?.values?.[0]?.[0] != null) {
              lastInsertRowid = rid[0].values[0][0];
            }
          } catch {
            /* noop */
          }
          return { lastInsertRowid, changes };
        },
        exec() { sqlJsDb.exec(sql); },
      };
    },
    exec(sql) { sqlJsDb.exec(sql); },
    transaction(fn) {
      return () => {
        sqlJsDb.run('BEGIN');
        try {
          fn();
          sqlJsDb.run('COMMIT');
        } catch (e) {
          sqlJsDb.run('ROLLBACK');
          throw e;
        }
      };
    },
    prepareRaw(sql) { return sqlJsDb.prepare(sql); },
  };
}

// ── Bun ─────────────────────────────────────────────────────────────────────────
function openBun() {
  const { Database } = require('bun:sqlite');
  ensureDir(config.db.path);
  const db = new Database(config.db.path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
  migrateSchedulesTriggers(db);
  return db;
}

// ── better-sqlite3 (Node.js RPi) ────────────────────────────────────────────────
function openBetterSqlite3() {
  const Database = require('better-sqlite3');
  ensureDir(config.db.path);
  const db = new Database(config.db.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
  migrateSchedulesTriggers(db);
  return db;
}

// ── sql.js (Node.js Windows fallback) ──────────────────────────────────────────
async function openSqlJs() {
  const initSqlJs = require('sql.js');
  ensureDir(config.db.path);
  const SQL = await initSqlJs();
  let db;
  if (fs.existsSync(config.db.path)) {
    db = new SQL.Database(fs.readFileSync(config.db.path));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
  const wrapped = wrapSqlJs(db);
  migrateSchedulesTriggers(wrapped);
  return wrapped;
}

// ── Driver detection ────────────────────────────────────────────────────────────
// 바이너리 누락(better-sqlite3 on Windows Node.js)을 감지하려면
// require()ではなく new Database(':memory:') まで試す。
function detectDriver() {
  if (IS_BUN) return 'bun';
  try {
    const Database = require('better-sqlite3');
    const test = new Database(':memory:');
    test.close();
    return 'better-sqlite3';
  } catch {
    return 'sql.js';
  }
}

// ── MVP 기본 사용자 시딩 ─────────────────────────────────────────────────────────
function seedDefaultUser(db) {
  const row = db.prepare('SELECT id FROM users WHERE id = 1').get();
  if (!row) {
    db.prepare(
      "INSERT INTO users (id, fitbit_user_id, display_name) VALUES (1, 'local-user', 'RPi Owner')",
    ).run();
    console.log('[DB] 기본 사용자 생성: id=1 (local-user)');
  }
}

// 기존 DB(schedules.last_triggered 단일 컬럼) → 분리 컬럼 마이그레이션
function migrateSchedulesTriggers(db) {
  let cols;
  try {
    cols = db.prepare('PRAGMA table_info(schedules)').all();
  } catch {
    return;
  }
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('last_sleep_triggered')) {
    db.exec('ALTER TABLE schedules ADD COLUMN last_sleep_triggered TEXT');
  }
  if (!names.has('last_wake_triggered')) {
    db.exec('ALTER TABLE schedules ADD COLUMN last_wake_triggered TEXT');
  }
  if (names.has('last_triggered')) {
    db.prepare(`
      UPDATE schedules SET
        last_sleep_triggered = COALESCE(last_sleep_triggered, last_triggered),
        last_wake_triggered = COALESCE(last_wake_triggered, last_triggered)
      WHERE last_sleep_triggered IS NULL OR last_wake_triggered IS NULL
    `).run();
  }
}

// ── Sync getter (bun / better-sqlite3 only) ─────────────────────────────────────
function getDb() {
  if (_db) return _db;
  const driver = detectDriver();
  if (driver === 'bun') {
    _db = openBun();
    _driver = 'bun';
  } else if (driver === 'better-sqlite3') {
    _db = openBetterSqlite3();
    _driver = 'better-sqlite3';
  } else {
    throw new Error(
      'sql.js는 비동기 초기화가 필요합니다. await getDbAsync()를 사용하세요.',
    );
  }
  console.log(`[DB] SQLite 초기화 완료 (${_driver}): ${config.db.path}`);
  seedDefaultUser(_db);
  migrateSchedulesTriggers(_db);
  return _db;
}

// ── Async getter (모든 드라이버 호환) ────────────────────────────────────────────
async function getDbAsync() {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const driver = detectDriver();
    if (driver === 'bun') {
      _db = openBun();
      _driver = 'bun';
    } else if (driver === 'better-sqlite3') {
      _db = openBetterSqlite3();
      _driver = 'better-sqlite3';
    } else {
      _db = await openSqlJs();
      _driver = 'sql.js';
    }
    console.log(`[DB] SQLite 초기화 완료 (${_driver}): ${config.db.path}`);
    seedDefaultUser(_db);
    migrateSchedulesTriggers(_db);
    return _db;
  })();

  return _initPromise;
}

// sql.js: 변경사항을 파일에 저장 (better-sqlite3/bun은 자동 저장)
function persist() {
  if (_driver === 'sql.js' && _db) {
    try {
      fs.writeFileSync(config.db.path, Buffer.from(_db._raw.export()));
    } catch (err) {
      console.error('[DB] sql.js 저장 실패:', err.message);
    }
  }
}

module.exports = { getDb, getDbAsync, persist };

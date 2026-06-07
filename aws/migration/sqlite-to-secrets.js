#!/usr/bin/env node
/**
 * SQLite fitbit_tokens → AWS Secrets Manager 일회성 마이그레이션
 * 담당: 임형택 (Processing Layer)
 *
 * 전제:
 *   - smartsleep-storage 스택 + fitbit-tokens-meta 테이블 존재
 *   - FitbitAppSecret(smartsleep/<env>/fitbit/app) 배포됨
 *
 * 사용:
 *   node sqlite-to-secrets.js --db ../../backend/data/sleep.db \
 *        --project smartsleep --env dev --region ap-northeast-2 [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DescribeSecretCommand,
} = require('@aws-sdk/client-secrets-manager');

function parseArgs(argv) {
  const args = {
    db: path.join(__dirname, '..', '..', 'backend', 'data', 'sleep.db'),
    project: 'smartsleep',
    env: 'dev',
    region: process.env.AWS_REGION || 'ap-northeast-2',
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--env') args.env = argv[++i];
    else if (a === '--region') args.region = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('사용: node sqlite-to-secrets.js --db <sleep.db> [--project smartsleep] [--env dev] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

const ARGS = parseArgs(process.argv);
const T = (name) => `${ARGS.project}-${ARGS.env}-${name}`;
const secretPrefix = `${ARGS.project}/${ARGS.env}/fitbit`;

async function openSqlite(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite 파일 없음: ${dbPath}`);
  }
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  return new SQL.Database(fs.readFileSync(dbPath));
}

function query(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

async function secretExists(sm, name) {
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: name }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function upsertSecret(sm, name, payload) {
  const body = JSON.stringify(payload);
  if (ARGS.dryRun) {
    console.log(`  [DRY-RUN] secret ${name}`);
    return name;
  }

  if (await secretExists(sm, name)) {
    await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: body }));
  } else {
    await sm.send(new CreateSecretCommand({ Name: name, SecretString: body }));
  }
  return name;
}

async function main() {
  console.log('─'.repeat(70));
  console.log(`SQLite fitbit_tokens → Secrets Manager ${ARGS.dryRun ? '(DRY-RUN)' : ''}`);
  console.log(`  db=${ARGS.db}  prefix=${secretPrefix}`);
  console.log('─'.repeat(70));

  const db = await openSqlite(ARGS.db);
  const users = query(db, 'SELECT * FROM users');
  const userMap = {};
  for (const u of users) {
    userMap[u.id] = `usr-${u.fitbit_user_id}`;
  }

  const tokens = query(db, 'SELECT * FROM fitbit_tokens');
  if (!tokens.length) {
    console.log('fitbit_tokens 행 없음 — 종료');
    return;
  }

  const sm = new SecretsManagerClient({ region: ARGS.region });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: ARGS.region }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  for (const t of tokens) {
    const userId = userMap[t.user_id] || `usr-legacy-${t.user_id}`;
    const secretName = `${secretPrefix}/${userId}`;
    const payload = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: t.expires_at,
      scope: t.scope,
    };

    const arn = await upsertSecret(sm, secretName, payload);
    console.log(`  user=${userId} → ${secretName}`);

    if (!ARGS.dryRun) {
      await ddb.send(new PutCommand({
        TableName: T('fitbit-tokens-meta'),
        Item: {
          user_id: userId,
          secret_arn: secretName,
          expires_at: t.expires_at,
          scope: t.scope,
          updated_at: new Date().toISOString(),
        },
      }));
    }
  }

  console.log('─'.repeat(70));
  console.log(`완료. ${tokens.length}건 처리`);
}

main().catch((err) => {
  console.error('마이그레이션 실패:', err);
  process.exit(1);
});

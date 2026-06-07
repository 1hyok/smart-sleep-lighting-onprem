'use strict';

const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
} = require('@aws-sdk/client-secrets-manager');

const sm = new SecretsManagerClient({});

async function getSecretJson(secretArnOrName) {
  const out = await sm.send(new GetSecretValueCommand({ SecretId: secretArnOrName }));
  if (!out.SecretString) throw new Error(`Secret ${secretArnOrName} has no string value`);
  return JSON.parse(out.SecretString);
}

async function putSecretJson(secretArnOrName, payload) {
  await sm.send(new PutSecretValueCommand({
    SecretId: secretArnOrName,
    SecretString: JSON.stringify(payload),
  }));
}

async function ensureUserTokenSecret(secretName, initialPayload) {
  try {
    return await getSecretJson(secretName);
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
    await sm.send(new CreateSecretCommand({
      Name: secretName,
      SecretString: JSON.stringify(initialPayload),
    }));
    return initialPayload;
  }
}

module.exports = { getSecretJson, putSecretJson, ensureUserTokenSecret };

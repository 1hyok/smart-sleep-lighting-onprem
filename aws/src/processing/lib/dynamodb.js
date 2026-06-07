'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

let docClient = null;

function getDocClient() {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return docClient;
}

async function getItem(table, key) {
  const out = await getDocClient().send(new GetCommand({ TableName: table, Key: key }));
  return out.Item ?? null;
}

async function putItem(table, item) {
  await getDocClient().send(new PutCommand({ TableName: table, Item: item }));
}

async function deleteItem(table, key) {
  const out = await getDocClient().send(new DeleteCommand({ TableName: table, Key: key }));
  return out.Attributes ?? null;
}

async function query(table, params) {
  const out = await getDocClient().send(new QueryCommand({ TableName: table, ...params }));
  return out.Items ?? [];
}

async function scan(table, params = {}) {
  const items = [];
  let lastKey;
  do {
    const out = await getDocClient().send(new ScanCommand({
      TableName: table,
      ...params,
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(out.Items ?? []));
    lastKey = out.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function updateItem(table, key, updateExpression, names, values) {
  await getDocClient().send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

module.exports = {
  getDocClient,
  getItem,
  putItem,
  deleteItem,
  query,
  scan,
  updateItem,
};

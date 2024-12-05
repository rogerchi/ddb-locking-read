import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

async function waitForTable(tableName: string): Promise<void> {
  console.log('Waiting for table to become active...');

  while (true) {
    try {
      const { Table } = await client.send(
        new DescribeTableCommand({ TableName: tableName }),
      );

      if (Table?.TableStatus === 'ACTIVE') {
        console.log('Table is now active');
        break;
      }

      console.log('Table status:', Table?.TableStatus);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        console.log('Table not found yet, waiting...');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      throw error;
    }
  }
}

async function createInitialItem() {
  const command = new PutCommand({
    TableName: 'Inventory',
    Item: {
      id: 'HASH-CHAIN-1',
      currentHash:
        '0000000000000000000000000000000000000000000000000000000000000000',
      lastUpdated: Math.floor(Date.now() / 1000),
    },
  });

  await docClient.send(command);
  console.log('Initial hash chain created');
}

async function createTable() {
  const command = new CreateTableCommand({
    TableName: 'Inventory',
    AttributeDefinitions: [
      {
        AttributeName: 'id',
        AttributeType: 'S',
      },
    ],
    KeySchema: [
      {
        AttributeName: 'id',
        KeyType: 'HASH',
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });

  try {
    await client.send(command);
    console.log('Table created successfully');
    await waitForTable('Inventory');
    await createInitialItem();
  } catch (error) {
    console.error('Error creating table:', error);
    throw error;
  }
}

// Run setup
createTable();

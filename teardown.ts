import {
  DynamoDBClient,
  DeleteTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({});

async function waitForTableDeletion(tableName: string): Promise<void> {
  console.log('Waiting for table to be deleted...');

  while (true) {
    try {
      await client.send(new DescribeTableCommand({ TableName: tableName }));
      console.log('Table still exists, waiting...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        console.log('Table deletion confirmed');
        break;
      }
      throw error;
    }
  }
}

async function deleteTable() {
  const command = new DeleteTableCommand({
    TableName: 'Inventory',
  });

  try {
    await client.send(command);
    console.log('Table deleted successfully');
    await waitForTableDeletion('Inventory');
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      console.log('Table does not exist');
      return;
    }
    console.error('Error deleting table:', error);
    throw error;
  }
}

// Run teardown
deleteTable();

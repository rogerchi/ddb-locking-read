import {
  DynamoDBClient,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { setTimeout } from 'timers/promises';
import { ulid } from 'ulidx';
import { createHash } from 'crypto';
import { sequenceLogger } from './logger';
import { unmarshall } from '@aws-sdk/util-dynamodb';

// Initialize the DynamoDB document client
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

interface HashChainItem {
  id: string;
  currentHash: string;
  lastUpdated: number;
  lockTime?: number;
  lockedBy?: string;
}

class LockError extends Error {
  constructor(message: string, public readonly currentState?: HashChainItem) {
    super(message);
    this.name = 'LockError';
  }
}

async function acquireLockAndRead<T>(
  itemId: string,
  processId: string,
  lockDuration: number = 30,
): Promise<T> {
  const now = Math.floor(Date.now() / 1000);
  const lockExpiration = now + lockDuration;
  const startTime = Date.now();

  const command = new UpdateCommand({
    TableName: 'Inventory',
    Key: { id: itemId },
    UpdateExpression: 'SET lockTime = :lockTime, lockedBy = :processId',
    ConditionExpression: 'attribute_not_exists(lockTime) OR lockTime < :now',
    ExpressionAttributeValues: {
      ':lockTime': lockExpiration,
      ':processId': processId,
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
    ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
  });

  try {
    const result = await docClient.send(command);
    sequenceLogger.log(
      processId,
      `Lock request took ${Date.now() - startTime}ms`,
    );
    return result.Attributes as T;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      sequenceLogger.log(
        processId,
        `Lock failure response took ${Date.now() - startTime}ms`,
      );
      const currentState = error.Item
        ? (unmarshall(error.Item) as HashChainItem)
        : undefined;
      const lockInfo = currentState?.lockedBy
        ? `locked by process ${currentState.lockedBy} until ${new Date(
            currentState.lockTime! * 1000,
          ).toISOString()}`
        : 'lock information not found';

      throw new LockError(
        `Failed to acquire lock for item ${itemId} - ${lockInfo}`,
        currentState,
      );
    }
    throw error;
  }
}

async function updateAndReleaseLock(
  itemId: string,
  processId: string,
  updateData: HashChainItem,
): Promise<HashChainItem> {
  const now = Math.floor(Date.now() / 1000);

  const command = new UpdateCommand({
    TableName: 'Inventory',
    Key: { id: itemId },
    UpdateExpression: `
      SET currentHash = :currentHash,
          lastUpdated = :lastUpdated
      REMOVE lockTime, 
             lockedBy
    `,
    ConditionExpression: 'lockedBy = :processId AND lockTime > :now',
    ExpressionAttributeValues: {
      ':currentHash': updateData.currentHash,
      ':lastUpdated': Math.floor(Date.now() / 1000),
      ':processId': processId,
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
    ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
  });

  try {
    const result = await docClient.send(command);
    return result.Attributes as HashChainItem;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      const currentState = error.Item
        ? (unmarshall(error.Item) as HashChainItem)
        : undefined;
      const lockInfo = currentState?.lockedBy
        ? `locked by process ${currentState.lockedBy} until ${new Date(
            currentState.lockTime! * 1000,
          ).toISOString()}`
        : 'lock information not found';

      throw new LockError(
        `Failed to update item ${itemId} - ${lockInfo}`,
        currentState,
      );
    }
    throw error;
  }
}

// Helper function to generate next hash with extra work
function generateNextHash(
  currentHash: string,
  workFactor: number = 50000,
): string {
  let hash = currentHash;
  // Do multiple rounds of hashing to simulate work
  for (let i = 0; i < workFactor; i++) {
    hash = createHash('sha256').update(hash).digest('hex');
  }
  return hash;
}

async function extendHashChain(
  itemId: string,
  iterations: number,
  maxRetries: number = 10,
): Promise<void> {
  const processId = ulid();
  sequenceLogger.log(processId, 'Started', iterations);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Acquire lock and read current hash
      sequenceLogger.log(processId, 'Acquiring lock');
      const item = await acquireLockAndRead<HashChainItem>(itemId, processId);
      sequenceLogger.log(processId, 'Lock acquired', undefined, true);

      // Generate next hash in the chain with actual work
      sequenceLogger.log(processId, 'Generating hashes');
      let nextHash = item.currentHash;
      for (let i = 0; i < iterations; i++) {
        const startTime = Date.now();
        nextHash = generateNextHash(nextHash);
        const endTime = Date.now();
        sequenceLogger.log(
          processId,
          `Generated hash ${i + 1}/${iterations} (took ${
            endTime - startTime
          }ms)`,
        );
      }

      // Update the hash chain and release lock
      const updatedItem: HashChainItem = {
        ...item,
        currentHash: nextHash,
        lastUpdated: Math.floor(Date.now() / 1000),
      };

      await updateAndReleaseLock(itemId, processId, updatedItem);
      sequenceLogger.log(processId, 'Chain extended', iterations, true);
      return;
    } catch (error) {
      if (error instanceof LockError) {
        sequenceLogger.log(processId, 'Lock failed', undefined, false);
        if (attempt < maxRetries) {
          const backoff = Math.floor(Math.random() * 100);
          sequenceLogger.log(processId, `Retrying in ${backoff}ms`);
          await setTimeout(backoff);
        } else {
          sequenceLogger.log(
            processId,
            'Max retries reached',
            undefined,
            false,
          );
          throw error;
        }
      } else {
        throw error;
      }
    }
  }
}

// Modify main function
async function main() {
  try {
    const itemId = 'HASH-CHAIN-1';
    const updates = [
      extendHashChain(itemId, 3), // Add 3 hashes to the chain
      extendHashChain(itemId, 4), // Add 4 hashes to the chain
      extendHashChain(itemId, 5), // Add 5 hashes to the chain
    ];

    await Promise.all(updates);
    console.log('All updates completed successfully');
    sequenceLogger.printSequence();
  } catch (error) {
    console.error('Error in main:', error);
    sequenceLogger.printSequence();
  }
}

// Run the example
main();

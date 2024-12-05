Amazon's [DynamoDB](https://aws.amazon.com/dynamodb/) is promoted as a zero-maintenance, virtually unlimited throughput and scale[\*](https://docs.aws.amazon.com/whitepapers/latest/comparing-dynamodb-and-hbase-for-nosql/amazon-dynamodb-overview.html) NoSQL database. Because of its' very low administrative overhead and serverless billing model, it has long been my data store of choice when developing cloud applications and services.

## The Challenge of Concurrent Access

Event-driven architectures commonly built on AWS services like Lambda, EventBridge, and Step Functions frequently use DynamoDB as their primary data store. In these systems, multiple serverless functions or processes can be triggered simultaneously by events, and they could be attempting to access and modify the same DynamoDB items. This creates unique concurrency challenges.

Consider these common scenarios:

- Multiple Lambda functions responding to an SQS queue of orders, all trying to update the same inventory record
- EventBridge rules triggering parallel processes that need to modify shared configuration data
- Step Functions running concurrent workflows that interact with the same customer record
- API Gateway endpoints receiving near-simultaneous requests to update a user's status

Traditional applications might handle these scenarios through application-layer coordination or database transaction isolation levels. However, serverless event-driven systems require different approaches due to their distributed nature.

There are three broad approaches to handling concurrency in these situations:

- No locking: Ideal if you don't need to read an item's contents before updating it. You might only use an update condition ensuring the last updated time is less than the event time to prevent out-of-order processing.
- Optimistic locking: you read the item and only update it if the last updated timestamp or version remains the same as when you read it initially. This is useful for cases where conflicts may be rare, or the cost of retrying is low.
- Pessimistic locking (the focus of this article): you acquire an exclusive lock on the item prior to any processing, preventing any other concurrent processes from beginning their work. You release the lock after performing your work and as you update the item.

Generally, any time you need strict consistency when reading before writing in a distributed system, you must use some form of concurrency control mechanism.

## Understanding Lock Management Through Condition Expressions

DynamoDB's condition expressions provide a powerful way to implement self-managing pessimistic locks. Let's explore how this works by examining our lock attributes:

```javascript
{
    id: "item-123",          // Primary key
    data: { ... },           // Your actual item data
    lockTime: 1635789600,    // Unix timestamp when lock expires
    lockedBy: "process-456"  // Identifier of the locking process
}
```

The magic of this implementation lies in how we use DynamoDB's condition expressions to manage lock acquisition and expiration automatically. Let's look at how this works in practice:

### Decision Flow Diagram

![DDB Pessimistic Locking Decision Flow Diagram](https://dev-to-uploads.s3.amazonaws.com/uploads/articles/eimaivp0t6eim0hw2t35.png)

## DynamoDB's Serial Write Guarantee

One of DynamoDB's key characteristics that makes this locking pattern reliable is its guarantee of serial writes at the item level. When multiple processes attempt to write to the same item simultaneously, DynamoDB processes these writes one at a time in the order they are received. This is different from traditional relational databases where multiple writes might interleave at the transaction level.

Let's understand this through an example. Imagine three processes attempting to acquire a lock on the same item at almost the same time:

```javascript
// All three processes execute this nearly simultaneously
const params = {
  TableName: 'MyTable',
  Key: { id: 'item-123' },
  UpdateExpression: 'SET lockTime = :lockTime, lockedBy = :processId',
  ConditionExpression: 'attribute_not_exists(lockTime) OR lockTime < :now',
  ExpressionAttributeValues: {
    ':lockTime': lockExpiration,
    ':processId': processId,
    ':now': now,
  },
};
```

DynamoDB will handle these requests serially, meaning:

1. The first request to reach DynamoDB will be evaluated completely
2. If it succeeds, it will acquire the lock and update the item
3. Only then will DynamoDB evaluate the second request
4. The second request will fail because the lock now exists and isn't expired
5. The third request will similarly fail for the same reason

This serial processing means we don't need additional synchronization mechanisms beyond DynamoDB's condition expressions. There's no possibility of a "race condition" where two processes think they've acquired the lock simultaneously, because DynamoDB's serial write guarantee prevents this scenario.

This behavior complements our locking pattern in several ways:

- Lock acquisition is guaranteed to be exclusive because of serial write processing
- We don't need distributed coordination or consensus protocols
- The system naturally handles contention through DynamoDB's built-in request queuing
- Failed condition checks happen quickly, allowing processes to retry or move on

When combined with condition expressions and atomic updates, this serial write behavior creates a foundation for building reliable distributed primitives like our locking system. It's worth noting that while writes are serial, reads can happen concurrently - which is why our pattern always uses write operations (UpdateItem) even when reading data, to ensure we're part of the serial write queue.

### Atomic Lock Acquisition

```javascript
async function acquireLockAndRead(itemId, processId) {
  const lockDuration = 30; // seconds
  const now = Math.floor(Date.now() / 1000);
  const lockExpiration = now + lockDuration;

  // Create the update command object for lock acquisition
  const command = new UpdateItemCommand({
    TableName: 'MyTable',
    Key: { id: { S: itemId } }, // Note: v3 SDK requires explicit AttributeValue types
    UpdateExpression: 'SET lockTime = :lockTime, lockedBy = :processId',
    ConditionExpression: 'attribute_not_exists(lockTime) OR lockTime < :now',
    ExpressionAttributeValues: {
      ':lockTime': { N: lockExpiration.toString() }, // Numbers must be strings in v3
      ':processId': { S: processId },
      ':now': { N: now.toString() },
    },
    ReturnValues: 'ALL_NEW',
  });

  try {
    // Send the command using the DynamoDB client
    const result = await client.send(command);
    return result.Attributes;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw new Error(
        'Failed to acquire lock - item is locked by another process',
      );
    }
    throw error;
  }
}
```

The condition expression makes this function powerful and elegant. It allows us to acquire a lock in two scenarios:

1. When no lock exists (`attribute_not_exists(lockTime)`)
2. When an existing lock has expired (`lockTime < :now`)

By using `ReturnValues: 'ALL_NEW'`, we get both the lock and the item data in a single atomic operation. This eliminates the need for an additional read after acquiring the lock. This saves on costs (additional RCUs), complexity (you would want a consistent read if not returning the values, and an additional read means this whole process is three API operations instead of two, a 50% increase), and total processing time (the throughput of this system is highly dependent on the total time it takes between the initial lock and the releasing update).

### Protected Updates with Lock Verification

When updating data under a lock, we verify that we still hold a valid lock:

```javascript
async function updateAndReleaseLock(itemId, processId, updateData) {
  const now = Math.floor(Date.now() / 1000);

  // Create the update command object for the protected update
  const command = new UpdateItemCommand({
    TableName: 'MyTable',
    Key: { id: { S: itemId } },
    UpdateExpression: 'SET #data = :newData REMOVE lockTime, lockedBy',
    ConditionExpression: 'lockedBy = :processId AND lockTime > :now',
    ExpressionAttributeNames: {
      '#data': 'data',
    },
    ExpressionAttributeValues: {
      ':newData': marshall(updateData), // Use marshall utility for complex objects
      ':processId': { S: processId },
      ':now': { N: now.toString() },
    },
    ReturnValues: 'ALL_NEW',
  });

  const result = await client.send(command);
}
```

Notice how we REMOVE the lock attributes rather than setting them to null. This reduces the item size when no lock is held, which is a small but meaningful optimization for items that are frequently locked and unlocked.

## Lock Lifecycle Example

To understand how this system manages itself, let's walk through a concrete example:

```javascript
// Time: 1000
// Process A acquires lock with 30-second duration
lockTime = 1030;
lockedBy = 'Process-A';

// Time: 1015
// Process B attempts to acquire lock
// ConditionExpression fails because 1030 > 1015
// Process B is denied access

// Time: 1031
// Process C attempts to acquire lock
// ConditionExpression succeeds because 1030 < 1031
// Process C automatically takes control
```

The beauty of this system is that locks expire automatically through our condition expressions. No explicit cleanup is needed - expired locks are simply ignored and overwritten when the next process attempts to acquire them.

## Our Mental Model for DynamoDB Locks

Similar to how DynamoDB partitions have [well-defined limits](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html) for read and write capacity, we need to understand the operational boundaries of our locking system. The key considerations are:

1. Lock Duration: Choose the shortest duration that allows operations to complete normally
2. Contention Patterns: Consider how frequently items are locked and the likelihood of lock conflicts
3. Operation Time: Ensure operations can reliably complete within the lock duration
4. Recovery Time: Account for how quickly the system can recover when processes fail while holding locks

## Conclusion

By leveraging DynamoDB's condition expressions, we can create an elegant, self-managing locking system that requires no external cleanup or maintenance. This pattern showcases how DynamoDB's features can be composed to create robust distributed systems primitives.

If you liked this article, consider following me on Bluesky: [@rogerchi.com](https://bsky.app/profile/rogerchi.com)

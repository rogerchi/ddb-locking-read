interface SequenceEvent {
  time: number;
  processId: string;
  action: string;
  quantity?: number;
  success?: boolean;
}

export class SequenceLogger {
  private startTime: number;
  private events: SequenceEvent[] = [];

  constructor() {
    this.startTime = Date.now();
  }

  log(processId: string, action: string, quantity?: number, success?: boolean) {
    this.events.push({
      time: Date.now() - this.startTime,
      processId,
      action,
      quantity,
      success,
    });
  }

  private printProcessEvents(processId: string, events: SequenceEvent[]) {
    const pid = processId.slice(-4);
    console.log(`\nProcess-${pid} sequence:`);
    console.log('Time(ms) | Action');
    console.log('---------+------------------');

    events.forEach(({ time, action, quantity, success }) => {
      const message = quantity ? `${action} (qty: ${quantity})` : action;
      const status = success !== undefined ? (success ? '✓' : '✗') : '';
      console.log(`${time.toString().padStart(8)} | ${message} ${status}`);
    });
  }

  printSequence() {
    // Print full sequence first
    console.log('\nFull sequence of events:');
    console.log('Time(ms) | Process      | Action');
    console.log('---------+-------------+------------------');

    this.events.forEach(({ time, processId, action, quantity, success }) => {
      const pid = processId.slice(-4);
      const message = quantity ? `${action} (qty: ${quantity})` : action;
      const status = success !== undefined ? (success ? '✓' : '✗') : '';
      console.log(
        `${time
          .toString()
          .padStart(8)} | Process-${pid} | ${message} ${status}`,
      );
    });

    // Print per-process summary
    console.log('\nPer-process summary:');
    console.log('-------------+------------------');

    // Group events by process
    const processSummaries = new Map<string, SequenceEvent[]>();
    this.events.forEach((event) => {
      const events = processSummaries.get(event.processId) || [];
      events.push(event);
      processSummaries.set(event.processId, events);
    });

    // Print summary for each process
    for (const [processId, events] of processSummaries) {
      const pid = processId.slice(-4);

      // Print sequence diagram for this process
      this.printProcessEvents(processId, events);

      // Print process summary
      console.log(`\nProcess-${pid} summary:`);

      // Find initial quantity
      const quantity = events.find((e) => e.quantity !== undefined)?.quantity;
      console.log(`Attempted to extend: ${quantity}`);

      // Count retries
      const retries = events.filter((e) =>
        e.action.includes('Retrying'),
      ).length;
      if (retries > 0) {
        console.log(`Retries: ${retries}`);
      }

      // Calculate total processing time
      const startTime = events[0].time;
      const endTime = events[events.length - 1].time;
      console.log(`Total time: ${endTime - startTime}ms`);

      // Show final outcome
      const succeeded = events.some((e) => e.action === 'Chain extended');
      console.log(`Outcome: ${succeeded ? 'Succeeded ✓' : 'Failed ✗'}`);

      console.log('-------------+------------------');
    }
  }
}

// Create and export a singleton instance
export const sequenceLogger = new SequenceLogger();

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AsyncMutex, ReloadCoordinator } from '../../src/mutex.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AsyncMutex & ReloadCoordinator concurrency invariants', () => {
  it('serializes overlapping tasks in strict FIFO order without interleaving', async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    const first = mutex.runExclusive(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      events.push('start-1');
      await delay(25);
      events.push('end-1');
      inFlight -= 1;
      return 1;
    });

    const second = mutex.runExclusive(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      events.push('start-2');
      await delay(10);
      events.push('end-2');
      inFlight -= 1;
      return 2;
    });

    const third = mutex.runExclusive(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      events.push('start-3');
      events.push('end-3');
      inFlight -= 1;
      return 3;
    });

    assert.equal(mutex.pendingCount, 3);
    assert.equal(mutex.isBusy, true);

    const results = await Promise.all([first, second, third]);
    assert.deepEqual(results, [1, 2, 3]);
    assert.equal(maxConcurrent, 1);
    assert.deepEqual(events, [
      'start-1',
      'end-1',
      'start-2',
      'end-2',
      'start-3',
      'end-3',
    ]);
    assert.equal(mutex.isBusy, false);
    assert.equal(mutex.pendingCount, 0);
  });

  it('releases the lock cleanly even when a task throws synchronously or asynchronously', async () => {
    const mutex = new AsyncMutex();

    await assert.rejects(
      () =>
        mutex.runExclusive(async () => {
          throw new Error('boom');
        }),
      /boom/,
    );

    const nextValue = await mutex.runExclusive(async () => 'recovered');
    assert.equal(nextValue, 'recovered');
    assert.equal(mutex.isBusy, false);
  });

  it('coalesces rapid debounced reload bursts into a single trailing execution', async () => {
    const coordinator = new ReloadCoordinator(25);
    const executedLabels: string[] = [];

    const p1 = coordinator.scheduleDebounced(async () => {
      executedLabels.push('burst-1');
      await delay(10);
    });
    const p2 = coordinator.scheduleDebounced(async () => {
      executedLabels.push('burst-2');
      await delay(10);
    });
    const p3 = coordinator.scheduleDebounced(async () => {
      executedLabels.push('burst-3');
      await delay(10);
    });

    assert.equal(coordinator.isBusy, true);
    await Promise.all([p1, p2, p3, coordinator.waitForIdle()]);
    assert.deepEqual(executedLabels, ['burst-3']);
    assert.equal(coordinator.isBusy, false);
  });

  it('executes interleaved debounced bursts, immediate restarts, and dispose sequentially with zero overlap', async () => {
    const coordinator = new ReloadCoordinator(20);
    const trace: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    const recordSpan = async (name: string, waitMs: number): Promise<string> => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      assert.equal(inFlight, 1, `Concurrent overlap detected during ${name}`);
      trace.push(`enter:${name}`);
      await delay(waitMs);
      trace.push(`exit:${name}`);
      inFlight -= 1;
      return name;
    };

    // 1. Schedule debounced reload burst, then immediately preempt with manual restart
    const supersededDebounce = coordinator.scheduleDebounced(async () => {
      await recordSpan('superseded-debounce', 10);
    });
    void coordinator.scheduleDebounced(async () => {
      await recordSpan('superseded-debounce-2', 10);
    });

    const immediateRestart1 = coordinator.runImmediate(() =>
      recordSpan('immediate-restart-1', 35),
    );
    // Superseded debounce promise must still settle cleanly without hanging callers
    await supersededDebounce;

    // 2. While immediateRestart1 is actively executing, fire a rapid burst of debounced reloads
    await delay(5);
    for (let i = 1; i <= 5; i++) {
      const idx = i;
      void coordinator.scheduleDebounced(async () => {
        await recordSpan(`trailing-debounce-${idx}`, 20);
      });
    }

    // Allow the trailing debounce timer to fire and enqueue behind immediateRestart1
    await delay(25);

    // 3. Enqueue another immediate restart and wait for all pending + queued work
    const immediateRestart2 = coordinator.runImmediate(() =>
      recordSpan('immediate-restart-2', 15),
    );

    const [r1, r2] = await Promise.all([
      immediateRestart1,
      immediateRestart2,
      coordinator.waitForIdle(),
    ]);
    assert.equal(r1, 'immediate-restart-1');
    assert.equal(r2, 'immediate-restart-2');

    // 4. Schedule another debounce, then immediately dispose -> pending timer cancelled, cleanup serialized
    const cancelledByDispose = coordinator.scheduleDebounced(async () => {
      await recordSpan('after-dispose-debounce', 10);
    });
    await coordinator.dispose(async () => {
      await recordSpan('dispose-cleanup', 10);
    });
    await cancelledByDispose;

    // 5. Subsequent scheduleDebounced after dispose is a safe no-op
    await coordinator.scheduleDebounced(async () => {
      await recordSpan('post-dispose-noop', 10);
    });

    assert.equal(coordinator.isDisposed, true);
    assert.equal(coordinator.isBusy, false);
    assert.equal(maxConcurrent, 1);
    assert.deepEqual(trace, [
      'enter:immediate-restart-1',
      'exit:immediate-restart-1',
      'enter:trailing-debounce-5',
      'exit:trailing-debounce-5',
      'enter:immediate-restart-2',
      'exit:immediate-restart-2',
      'enter:dispose-cleanup',
      'exit:dispose-cleanup',
    ]);
  });

  it('does not hang waitForIdle when a debounced task rejects internally', async () => {
    const coordinator = new ReloadCoordinator(10);
    void coordinator.scheduleDebounced(async () => {
      throw new Error('simulated reconcile failure');
    });

    await coordinator.waitForIdle();
    assert.equal(coordinator.isBusy, false);
  });
});

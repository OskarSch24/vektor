import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GraphWriteQueue,
  type GraphWriteResult,
  type GraphWriteSnapshot,
} from '../src/services/GraphWriteQueue.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function snapshot(
  path: string,
  revision: number | null,
  contents = `${path}:${revision ?? 'clean'}`,
  generation = 1
): GraphWriteSnapshot {
  return { path, revision, contents, generation };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('runs writes in global FIFO order', async () => {
  const starts: string[] = [];
  const gates: Array<Deferred<GraphWriteResult>> = [];
  const queue = new GraphWriteQueue((path, contents) => {
    starts.push(contents);
    const gate = deferred<GraphWriteResult>();
    gates.push(gate);
    return gate.promise;
  });

  const first = queue.enqueue(snapshot('/a.graph', 1, 'a:1'));
  const second = queue.enqueue(snapshot('/b.graph', 1, 'b:1'));
  const third = queue.enqueue(snapshot('/a.graph', 2, 'a:2'));

  assert.deepEqual(starts, ['a:1']);
  gates[0].resolve({ path: '/a.graph' });
  await first;
  await nextTurn();
  assert.deepEqual(starts, ['a:1', 'b:1']);

  gates[1].resolve({ path: '/b.graph' });
  await second;
  await nextTurn();
  assert.deepEqual(starts, ['a:1', 'b:1', 'a:2']);

  gates[2].resolve({ path: '/a.graph' });
  await third;
});

test('deduplicates an identical document revision', async () => {
  const gate = deferred<GraphWriteResult>();
  let calls = 0;
  const queue = new GraphWriteQueue(() => {
    calls += 1;
    return gate.promise;
  });
  const version = snapshot('/same.graph', 7, 'same revision', 3);

  const first = queue.enqueue(version);
  const duplicate = queue.enqueue({ ...version });

  assert.strictEqual(duplicate, first);
  assert.equal(calls, 1);
  gate.resolve({ path: '/same.graph' });
  assert.deepEqual(await duplicate, { path: '/same.graph' });
});

test('waitForPath includes matching jobs added while an older write settles', async () => {
  const starts: string[] = [];
  const gates = new Map<string, Deferred<GraphWriteResult>>();
  const queue = new GraphWriteQueue((path, contents) => {
    starts.push(contents);
    const gate = deferred<GraphWriteResult>();
    gates.set(contents, gate);
    return gate.promise;
  });

  const first = queue.enqueue(snapshot('/a.graph', 1, 'a:1'));
  const other = queue.enqueue(snapshot('/b.graph', 1, 'b:1'));
  let idle = false;
  const pathIdle = queue.waitForPath('/a.graph').then(() => {
    idle = true;
  });
  const trailing = queue.enqueue(snapshot('/a.graph', 2, 'a:2'));

  gates.get('a:1')?.resolve({ path: '/a.graph' });
  await first;
  await nextTurn();
  assert.equal(idle, false);
  assert.deepEqual(starts, ['a:1', 'b:1']);

  gates.get('b:1')?.resolve({ path: '/b.graph' });
  await other;
  await nextTurn();
  assert.equal(idle, false);
  assert.deepEqual(starts, ['a:1', 'b:1', 'a:2']);

  gates.get('a:2')?.resolve({ path: '/a.graph' });
  await trailing;
  await pathIdle;
  assert.equal(idle, true);
});

test('continues with the next job after a write failure', async () => {
  const starts: string[] = [];
  const queue = new GraphWriteQueue((path, contents) => {
    starts.push(contents);
    return contents === 'broken'
      ? Promise.reject(new Error('disk full'))
      : Promise.resolve({ path });
  });

  const failed = queue.enqueue(snapshot('/a.graph', 1, 'broken'));
  const recovered = queue.enqueue(snapshot('/b.graph', 1, 'recovered'));

  await assert.rejects(failed, /disk full/);
  assert.deepEqual(await recovered, { path: '/b.graph' });
  assert.deepEqual(starts, ['broken', 'recovered']);
});

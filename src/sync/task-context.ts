import { AsyncLocalStorage } from 'node:async_hooks';

export interface SyncTaskContext {
  taskKey: string;
  taskType: string;
}

const storage = new AsyncLocalStorage<SyncTaskContext>();

export function runWithTaskContext<T>(
  context: SyncTaskContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

export function getTaskContext(): SyncTaskContext | undefined {
  return storage.getStore();
}

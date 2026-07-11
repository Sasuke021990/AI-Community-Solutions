import type { IpcResult } from '../../../shared/ipc.js';

/** Unwraps an IpcResult, throwing a plain Error with the server-side message on failure. */
export async function call<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
}

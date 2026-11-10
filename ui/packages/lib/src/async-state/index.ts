import { toError } from "../errors/index.js";

export { toError } from "../errors/index.js";

/**
 * Discriminated union type for representing async operation state.
 *
 * Replaces scattered `isLoading`/`error`/`data` flags with a single
 * type-safe value. The `status` field acts as the discriminant, enabling
 * TypeScript narrowing in `if`/`switch` branches.
 *
 * Four states:
 * - `Waiting`  — operation hasn't started
 * - `Loading`  — operation in progress
 * - `Success<T>` — completed with a value
 * - `Failure<E>` — failed with an error
 *
 * @example Basic usage with Svelte 5 runes
 * ```ts
 * import { type AsyncState, loading, success, failure, isSuccess } from "@camber/lib/async-state";
 *
 * let state: AsyncState<User[], string> = $state(loading);
 *
 * async function load() {
 *   state = loading;
 *   try {
 *     state = success(await api.fetchUsers());
 *   } catch (e) {
 *     state = failure(toError(e));
 *   }
 * }
 * ```
 *
 * @example Using fromPromise to eliminate boilerplate
 * ```ts
 * import { fromPromise } from "@camber/lib/async-state";
 *
 * async function load() {
 *   await fromPromise(() => api.fetchUsers(), (s) => state = s);
 * }
 * ```
 */

export type AsyncState<T, E = Error> = Waiting | Loading | Success<T> | Failure<E>;

export type Waiting = { readonly status: "waiting" };
export type Loading = { readonly status: "loading" };
export type Success<T> = { readonly status: "success"; readonly value: T };
export type Failure<E = Error> = { readonly status: "failure"; readonly error: E };

export const waiting: Waiting = { status: "waiting" };
export const loading: Loading = { status: "loading" };

export function success<T>(value: T): Success<T> {
  return { status: "success", value };
}

export function failure<E = Error>(error: E): Failure<E> {
  return { status: "failure", error };
}

export function isWaiting<T, E>(state: AsyncState<T, E>): state is Waiting {
  return state.status === "waiting";
}

export function isLoading<T, E>(state: AsyncState<T, E>): state is Loading {
  return state.status === "loading";
}

export function isSuccess<T, E>(state: AsyncState<T, E>): state is Success<T> {
  return state.status === "success";
}

export function isFailure<T, E>(state: AsyncState<T, E>): state is Failure<E> {
  return state.status === "failure";
}

/**
 * Run an async function and push state transitions (loading → success | failure)
 * via a callback. Non-Error thrown values are wrapped automatically.
 * Returns the final state for callers that need to inspect it.
 *
 * The onState callback is never called synchronously — the initial
 * loading transition is deferred to the next microtick.
 *
 * @example
 * ```ts
 * await fromPromise(() => api.fetchUsers(), (s) => this.#state = s);
 * ```
 */
export async function fromPromise<T, E = Error>(
  fn: () => Promise<T>,
  onState: (state: AsyncState<T, E>) => void,
  options: { mapError?: (error: unknown) => E } = {},
): Promise<AsyncState<T, E>> {
  await Promise.resolve();
  onState(loading);
  try {
    const state = success<T>(await fn());
    onState(state);
    return state;
  } catch (e) {
    const state = failure(options.mapError ? options.mapError(e) : (toError(e) as E));
    onState(state);
    return state;
  }
}

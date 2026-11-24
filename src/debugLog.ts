// ============================================================================
// Internal debug logger — surfaces unexpected exceptions from `} catch (e)`
// blocks that would otherwise silently swallow errors.
//
// Plain language: the checker must never crash the editor, so many places
// catch errors and carry on.  During development you still want to SEE those
// errors — this tiny helper prints them, but only when explicitly enabled.
//
// In production / language-server mode the logger is a no-op, so users
// never see internal stack traces.  Set the environment variable
// `HM_DEBUG=1` to log to stderr; tests can swap in a custom sink via
// `setDebugSink(fn)` to assert that an unexpected error path was hit.
// ============================================================================

export type DebugSink = (origin: string, error: unknown) => void;

let sink: DebugSink | null = null;

if (typeof process !== 'undefined' && process.env && process.env.HM_DEBUG) {
  sink = (origin, error) => {
    const msg = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
    // eslint-disable-next-line no-console
    console.error(`[hinmil debug] ${origin}: ${msg}`);
  };
}

/**
 * Replace the active debug sink.  Pass `null` to disable.  Returns the
 * previously-installed sink so callers (typically tests) can restore it.
 */
export function setDebugSink(next: DebugSink | null): DebugSink | null {
  const prev = sink;
  sink = next;
  return prev;
}

/**
 * Log an unexpected error caught in a `try/catch` block whose primary
 * purpose is to keep the inference engine running.  Use a short, unique
 * `origin` (e.g. `'modules.classFieldInit'`) so log output is greppable.
 */
export function debugLog(origin: string, error: unknown): void {
  if (sink) sink(origin, error);
}

// ============================================================================
// Sidecar pipeline performance counters
//
// Lightweight module-scope accumulators timing the expensive stages of the
// `.hm` sidecar pipeline (parse, alias extraction, method registration,
// wrap/read).  Used by `scripts/benchmark.ts` and available at runtime for
// HM_DEBUG diagnostics.  Kept in its own module so both `files.ts` and
// `importContext.ts` can record without import cycles.
// ============================================================================

export interface SidecarPerfCounters {
  /** `parseHmSource` — full scheme parse of a sidecar (cache misses only). */
  parseMs: number;
  parseCount: number;
  /** `parseHmTypeAliases` — alias/constructor extraction runs. */
  aliasMs: number;
  aliasCount: number;
  /** `registerAnnotationsFromSource` — method/constraint registration passes. */
  registerMs: number;
  registerCount: number;
  /** Type-directive resolver: file read + `wrapHmSource` passes. */
  directiveMs: number;
  directiveCount: number;
}

const zero = (): SidecarPerfCounters => ({
  parseMs: 0, parseCount: 0,
  aliasMs: 0, aliasCount: 0,
  registerMs: 0, registerCount: 0,
  directiveMs: 0, directiveCount: 0,
});

let counters = zero();

export function resetSidecarPerf(): void {
  counters = zero();
}

export function getSidecarPerf(): SidecarPerfCounters {
  return { ...counters };
}

function now(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** Time `fn`, attributing the elapsed ms to the given stage. */
export function timeSidecarStage<T>(
  stage: 'parse' | 'alias' | 'register' | 'directive',
  fn: () => T,
): T {
  const t0 = now();
  try {
    return fn();
  } finally {
    const dt = now() - t0;
    switch (stage) {
      case 'parse': counters.parseMs += dt; counters.parseCount++; break;
      case 'alias': counters.aliasMs += dt; counters.aliasCount++; break;
      case 'register': counters.registerMs += dt; counters.registerCount++; break;
      case 'directive': counters.directiveMs += dt; counters.directiveCount++; break;
    }
  }
}

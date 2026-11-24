// src/debugLog.ts — the internal debug sink used by catch-blocks that keep
// the engine alive.  Covers the sink-swap API and the HM_DEBUG bootstrap.

import { debugLog, setDebugSink, DebugSink } from '../../src/debugLog';

describe('setDebugSink / debugLog', () => {
  afterEach(() => setDebugSink(null));

  test('by default (no HM_DEBUG, no sink) debugLog is a no-op', () => {
    expect(() => debugLog('test.origin', new Error('boom'))).not.toThrow();
  });

  test('a custom sink receives origin and error', () => {
    const calls: Array<{ origin: string; error: unknown }> = [];
    setDebugSink((origin, error) => calls.push({ origin, error }));
    const err = new Error('boom');
    debugLog('modules.classFieldInit', err);
    expect(calls).toEqual([{ origin: 'modules.classFieldInit', error: err }]);
  });

  test('setDebugSink returns the previously installed sink', () => {
    const first: DebugSink = () => {};
    expect(setDebugSink(first)).toBeNull();
    const second: DebugSink = () => {};
    expect(setDebugSink(second)).toBe(first);
    expect(setDebugSink(null)).toBe(second);
  });

  test('passing null disables logging again', () => {
    const calls: unknown[] = [];
    setDebugSink((_o, e) => calls.push(e));
    setDebugSink(null);
    debugLog('x', 'err');
    expect(calls).toEqual([]);
  });
});

describe('HM_DEBUG bootstrap', () => {
  const ORIG = process.env.HM_DEBUG;

  afterEach(() => {
    if (ORIG === undefined) delete process.env.HM_DEBUG;
    else process.env.HM_DEBUG = ORIG;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('with HM_DEBUG set, an Error is logged to console.error with stack', () => {
    process.env.HM_DEBUG = '1';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fresh = require('../../src/debugLog') as typeof import('../../src/debugLog');
      fresh.debugLog('boot.origin', new Error('kaboom'));
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = spy.mock.calls[0][0] as string;
    expect(msg).toContain('[hinmil debug] boot.origin');
    expect(msg).toContain('Error: kaboom');
  });

  test('with HM_DEBUG set, a non-Error value is stringified', () => {
    process.env.HM_DEBUG = '1';
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fresh = require('../../src/debugLog') as typeof import('../../src/debugLog');
      fresh.debugLog('boot.origin', 'plain string failure');
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('plain string failure');
  });
});

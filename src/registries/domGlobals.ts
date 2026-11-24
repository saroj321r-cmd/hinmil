// ============================================================================
// DOM & Fetch globals — nominal builtin types with method tables
//
// Plain language: this module makes `document`, `window`, `localStorage` &
// friends *typed* instead of `Any`, so members complete, hover and get their
// arguments checked — while anything NOT in the catalogue silently resolves
// to `Any` (see `hasAnyFallback` in methodRegistry / expr-member.ts).  The
// DOM surface is enormous; this catalogue is deliberately COMPACT and
// projects extend it per-type via `::global Element#member :: …` in their
// globals.hm, or replace a binding entirely (`document :: { … }`).
//
// Two knobs (see `hinmil.dom.*` settings, threaded via `applyDomSettings` in
// methodRegistry.ts):
//   • `globalTypes` (default true) — typed globals + Document/Element/… as
//     annotation type names.  Off reverts document/window/… to plain `Any`
//     (e.g. when a project defines its own `Element` type).
//   • `strictNulls` (default false) — lookups that can miss (getElementById,
//     querySelector, getAttribute, Storage#getItem, …) return `T | Null`.
//
// The Fetch API (`fetch`, `Response`) is independent of `globalTypes` and is
// always available — every kind of project (browser, node, workers) has it.
// ============================================================================

import {
  Type, tVar, tFun, tCon, tNumber, tString, tBool, tNull, tUndefined, tVoid,
  tTuple, tArray, tRecord, T_UNION,
} from '../hm/types';
import type { MethodEntry } from './methodRegistry';

// ---------------------------------------------------------------------------
// Settings state (module-level; the LSP server owns one process per project)
// ---------------------------------------------------------------------------

export interface DomSettings {
  /** Typed DOM globals + Document/Element/… annotation type names. */
  globalTypes: boolean;
  /** DOM lookups that can miss return `T | Null`. */
  strictNulls: boolean;
}

const state: DomSettings = { globalTypes: true, strictNulls: false };

/** Internal: update the module state (use `applyDomSettings` from
 *  methodRegistry.ts, which also refreshes the tables + env cache). */
export function setDomSettingsState(next: Partial<DomSettings>): void {
  if (next.globalTypes !== undefined) state.globalTypes = next.globalTypes;
  if (next.strictNulls !== undefined) state.strictNulls = next.strictNulls;
}

/** True when typed DOM globals (and their annotation type names) are on. */
export function isDomGlobalTypesEnabled(): boolean {
  return state.globalTypes;
}

/** Current strict-null mode (informational; tables are rebuilt on change). */
export function isDomStrictNulls(): boolean {
  return state.strictNulls;
}

// ---------------------------------------------------------------------------
// Type-name catalogues (annotation availability + registry keys)
// ---------------------------------------------------------------------------

/** Nominal DOM types — gated behind `dom.globalTypes`. */
export const DOM_TYPE_NAMES = [
  'Document', 'Element', 'Window', 'Storage', 'Event', 'Navigator',
] as const;

/** Fetch API types — always available, independent of `dom.globalTypes`. */
export const FETCH_TYPE_NAMES = ['Response', 'AbortSignal', 'AbortController', 'URLSearchParams', 'URL'] as const;

/**
 * Type names currently valid in annotations (`el :: Element`,
 * `handle :: Event -> Void`, `r :: Response`).  Consulted by the two
 * annotation-validation sites that seed their known-type sets from
 * `BUILTIN_TYPE_NAMES`.
 */
export function activeDomAnnotationTypeNames(): readonly string[] {
  return state.globalTypes ? [...DOM_TYPE_NAMES, ...FETCH_TYPE_NAMES] : FETCH_TYPE_NAMES;
}

/**
 * Types whose UNKNOWN members resolve to `Any` without a diagnostic instead
 * of "Property does not exist".  The catalogue is compact by design; the
 * fallback keeps the rest of the (huge) DOM/Fetch surface usable.
 */
const ANY_FALLBACK_TYPES = new Set<string>([...DOM_TYPE_NAMES, ...FETCH_TYPE_NAMES]);

/** True when unknown members on `typeName` should silently be `Any`. */
export function domHasAnyFallback(typeName: string): boolean {
  if (!ANY_FALLBACK_TYPES.has(typeName)) return false;
  // DOM types only act open-world while the typed-globals mode is on —
  // a project that disabled it (own `Element` type) gets strict behaviour.
  if ((FETCH_TYPE_NAMES as readonly string[]).includes(typeName)) return true;
  return state.globalTypes;
}

// ---------------------------------------------------------------------------
// Table builders
// ---------------------------------------------------------------------------

function un(...types: Type[]): Type { return tCon(T_UNION, types); }
function opt(t: Type): Type { return un(t, tUndefined); }

/** Constant property (monomorphic — safe to share the Type instance). */
function prop(type: Type, signature: string): MethodEntry {
  return { signature, factory: () => type };
}

/** Method whose type contains NO type variables (safe to share). */
function method(type: Type, signature: string): MethodEntry {
  return { signature, factory: () => type };
}

/** Method with fresh type variables per use. */
function polyMethod(make: () => Type, signature: string): MethodEntry {
  return { signature, factory: make };
}

const element = () => tCon('Element');
const event = () => tCon('Event');

/**
 * Build all DOM/Fetch method tables for the given null-strictness.
 * Signature strings are rendered to match, so hover stays truthful.
 */
export function buildDomMethodTables(strictNulls: boolean): Record<string, Record<string, MethodEntry>> {
  /** A lookup result that can miss: `T | Null` in strict mode, `T` otherwise. */
  const miss = (t: Type): Type => (strictNulls ? un(t, tNull) : t);
  const missSig = (s: string): string => (strictNulls ? `(${s} | Null)` : s);

  const elOrNull = () => miss(element());
  const elOrNullSig = missSig('Element');

  // (String, (Event -> a)) -> Void — fresh `a` per use.
  const listener = (): MethodEntry => polyMethod(
    () => tFun(tTuple([tString, tFun(event(), tVar('a'))]), tVoid),
    '(String, (Event -> a)) -> Void',
  );

  const eventTargetMethods: Record<string, MethodEntry> = {
    addEventListener: listener(),
    removeEventListener: listener(),
    dispatchEvent: method(tFun(event(), tBool), 'Event -> Boolean'),
  };

  const documentMethods: Record<string, MethodEntry> = {
    ...eventTargetMethods,
    getElementById: method(tFun(tString, elOrNull()), `String -> ${elOrNullSig}`),
    querySelector: method(tFun(tString, elOrNull()), `String -> ${elOrNullSig}`),
    querySelectorAll: method(tFun(tString, tArray(element())), 'String -> [Element]'),
    getElementsByClassName: method(tFun(tString, tArray(element())), 'String -> [Element]'),
    getElementsByTagName: method(tFun(tString, tArray(element())), 'String -> [Element]'),
    createElement: method(tFun(tString, element()), 'String -> Element'),
    body: prop(element(), 'Element'),
    head: prop(element(), 'Element'),
    documentElement: prop(element(), 'Element'),
    activeElement: prop(miss(element()), elOrNullSig),
    title: prop(tString, 'String'),
    cookie: prop(tString, 'String'),
    readyState: prop(tString, 'String'),
  };

  const rect = tRecord({
    top: tNumber, left: tNumber, right: tNumber, bottom: tNumber,
    width: tNumber, height: tNumber, x: tNumber, y: tNumber,
  });

  const elementMethods: Record<string, MethodEntry> = {
    ...eventTargetMethods,
    querySelector: method(tFun(tString, elOrNull()), `String -> ${elOrNullSig}`),
    querySelectorAll: method(tFun(tString, tArray(element())), 'String -> [Element]'),
    closest: method(tFun(tString, elOrNull()), `String -> ${elOrNullSig}`),
    matches: method(tFun(tString, tBool), 'String -> Boolean'),
    contains: method(tFun(element(), tBool), 'Element -> Boolean'),
    appendChild: method(tFun(element(), element()), 'Element -> Element'),
    removeChild: method(tFun(element(), element()), 'Element -> Element'),
    remove: method(tFun(tVoid, tVoid), '() -> Void'),
    setAttribute: method(tFun(tTuple([tString, tString]), tVoid), '(String, String) -> Void'),
    getAttribute: method(tFun(tString, miss(tString)), `String -> ${missSig('String')}`),
    removeAttribute: method(tFun(tString, tVoid), 'String -> Void'),
    hasAttribute: method(tFun(tString, tBool), 'String -> Boolean'),
    insertAdjacentHTML: method(tFun(tTuple([tString, tString]), tVoid), '(String, String) -> Void'),
    getBoundingClientRect: method(tFun(tVoid, rect),
      '() -> { top :: Number, left :: Number, right :: Number, bottom :: Number, width :: Number, height :: Number, x :: Number, y :: Number }'),
    focus: method(tFun(tVoid, tVoid), '() -> Void'),
    blur: method(tFun(tVoid, tVoid), '() -> Void'),
    click: method(tFun(tVoid, tVoid), '() -> Void'),
    scrollIntoView: polyMethod(() => tFun(opt(tVar('a')), tVoid), '(a | Undefined) -> Void'),
    // Common data props.  `style`/`dataset`/`classList` stay `Any`-ish via
    // the fallback — cataloguing CSSStyleDeclaration/DOMTokenList precisely
    // is out of scope for the compact set.
    textContent: prop(tString, 'String'),
    innerHTML: prop(tString, 'String'),
    outerHTML: prop(tString, 'String'),
    id: prop(tString, 'String'),
    className: prop(tString, 'String'),
    tagName: prop(tString, 'String'),
    value: prop(tString, 'String'),
    checked: prop(tBool, 'Boolean'),
    disabled: prop(tBool, 'Boolean'),
    hidden: prop(tBool, 'Boolean'),
    children: prop(tArray(element()), '[Element]'),
    parentElement: prop(miss(element()), elOrNullSig),
    firstElementChild: prop(miss(element()), elOrNullSig),
    lastElementChild: prop(miss(element()), elOrNullSig),
    nextElementSibling: prop(miss(element()), elOrNullSig),
    previousElementSibling: prop(miss(element()), elOrNullSig),
    clientWidth: prop(tNumber, 'Number'),
    clientHeight: prop(tNumber, 'Number'),
    scrollTop: prop(tNumber, 'Number'),
    scrollLeft: prop(tNumber, 'Number'),
  };

  const windowMethods: Record<string, MethodEntry> = {
    ...eventTargetMethods,
    document: prop(tCon('Document'), 'Document'),
    navigator: prop(tCon('Navigator'), 'Navigator'),
    localStorage: prop(tCon('Storage'), 'Storage'),
    sessionStorage: prop(tCon('Storage'), 'Storage'),
    innerWidth: prop(tNumber, 'Number'),
    innerHeight: prop(tNumber, 'Number'),
    scrollX: prop(tNumber, 'Number'),
    scrollY: prop(tNumber, 'Number'),
    devicePixelRatio: prop(tNumber, 'Number'),
    alert: polyMethod(() => tFun(tVar('a'), tVoid), 'a -> Void'),
    confirm: method(tFun(tString, tBool), 'String -> Boolean'),
    prompt: method(tFun(tTuple([tString, opt(tString)]), miss(tString)),
      `(String, (String | Undefined)) -> ${missSig('String')}`),
    scrollTo: method(tFun(tTuple([tNumber, tNumber]), tVoid), '(Number, Number) -> Void'),
    requestAnimationFrame: polyMethod(
      () => tFun(tFun(tNumber, tVar('a')), tNumber), '(Number -> a) -> Number'),
    cancelAnimationFrame: method(tFun(tNumber, tVoid), 'Number -> Void'),
    setTimeout: polyMethod(
      () => tFun(tTuple([tFun(tVoid, tVar('a')), opt(tNumber)]), tNumber),
      '((() -> a), (Number | Undefined)) -> Number'),
    setInterval: polyMethod(
      () => tFun(tTuple([tFun(tVoid, tVar('a')), opt(tNumber)]), tNumber),
      '((() -> a), (Number | Undefined)) -> Number'),
    clearTimeout: method(tFun(tNumber, tVoid), 'Number -> Void'),
    clearInterval: method(tFun(tNumber, tVoid), 'Number -> Void'),
  };

  const storageMethods: Record<string, MethodEntry> = {
    getItem: method(tFun(tString, miss(tString)), `String -> ${missSig('String')}`),
    setItem: method(tFun(tTuple([tString, tString]), tVoid), '(String, String) -> Void'),
    removeItem: method(tFun(tString, tVoid), 'String -> Void'),
    clear: method(tFun(tVoid, tVoid), '() -> Void'),
    key: method(tFun(tNumber, miss(tString)), `Number -> ${missSig('String')}`),
    length: prop(tNumber, 'Number'),
  };

  const eventMethods: Record<string, MethodEntry> = {
    // `target :: Element` is pragmatic (not spec-precise EventTarget): it is
    // what 95% of handlers reach for — `e.target.value`, `e.target.checked`.
    target: prop(element(), 'Element'),
    currentTarget: prop(element(), 'Element'),
    type: prop(tString, 'String'),
    key: prop(tString, 'String'),
    code: prop(tString, 'String'),
    clientX: prop(tNumber, 'Number'),
    clientY: prop(tNumber, 'Number'),
    pageX: prop(tNumber, 'Number'),
    pageY: prop(tNumber, 'Number'),
    shiftKey: prop(tBool, 'Boolean'),
    ctrlKey: prop(tBool, 'Boolean'),
    altKey: prop(tBool, 'Boolean'),
    metaKey: prop(tBool, 'Boolean'),
    preventDefault: method(tFun(tVoid, tVoid), '() -> Void'),
    stopPropagation: method(tFun(tVoid, tVoid), '() -> Void'),
  };

  const navigatorMethods: Record<string, MethodEntry> = {
    onLine: prop(tBool, 'Boolean'),
    language: prop(tString, 'String'),
    userAgent: prop(tString, 'String'),
    platform: prop(tString, 'String'),
    // clipboard / geolocation / permissions … — Any via the fallback.
  };

  const responseMethods: Record<string, MethodEntry> = {
    ok: prop(tBool, 'Boolean'),
    status: prop(tNumber, 'Number'),
    statusText: prop(tString, 'String'),
    url: prop(tString, 'String'),
    redirected: prop(tBool, 'Boolean'),
    json: polyMethod(
      () => tFun(tVoid, tCon('Promise', [tVar('e'), tVar('a')])),
      '() -> Promise e a'),
    text: polyMethod(
      () => tFun(tVoid, tCon('Promise', [tVar('e'), tString])),
      '() -> Promise e String'),
    blob: polyMethod(
      () => tFun(tVoid, tCon('Promise', [tVar('e'), tVar('a')])),
      '() -> Promise e a'),
    arrayBuffer: polyMethod(
      () => tFun(tVoid, tCon('Promise', [tVar('e'), tCon('ArrayBuffer')])),
      '() -> Promise e ArrayBuffer'),
    clone: method(tFun(tVoid, tCon('Response')), '() -> Response'),
  };

  const abortSignalMethods: Record<string, MethodEntry> = {
    aborted: prop(tBool, 'Boolean'),
    throwIfAborted: method(tFun(tVoid, tVoid), '() -> Void'),
  };

  // `new AbortController ()`: cancels a `fetch` through its signal.
  const abortControllerMethods: Record<string, MethodEntry> = {
    signal: prop(tCon('AbortSignal'), 'AbortSignal'),
    abort: polyMethod(() => tFun(opt(tVar('a')), tVoid), '(a | Undefined) -> Void'),
  };

  const urlSearchParamsMethods: Record<string, MethodEntry> = {
    toString: method(tFun(tVoid, tString), '() -> String'),
    get: method(tFun(tString, un(tString, tNull)), 'String -> String | Null'),
    getAll: method(tFun(tString, tArray(tString)), 'String -> [String]'),
    has: method(tFun(tString, tBool), 'String -> Boolean'),
    set: method(tFun(tTuple([tString, tString]), tVoid), '(String, String) -> Void'),
    append: method(tFun(tTuple([tString, tString]), tVoid), '(String, String) -> Void'),
    delete: method(tFun(tString, tVoid), 'String -> Void'),
    size: prop(tNumber, 'Number'),
  };

  // A parsed URL (WHATWG URL): its string parts and the query.
  const urlMethods: Record<string, MethodEntry> = {
    href: prop(tString, 'String'),
    origin: prop(tString, 'String'),
    protocol: prop(tString, 'String'),
    username: prop(tString, 'String'),
    password: prop(tString, 'String'),
    host: prop(tString, 'String'),
    hostname: prop(tString, 'String'),
    port: prop(tString, 'String'),
    pathname: prop(tString, 'String'),
    search: prop(tString, 'String'),
    hash: prop(tString, 'String'),
    searchParams: prop(tCon('URLSearchParams'), 'URLSearchParams'),
    toString: method(tFun(tVoid, tString), '() -> String'),
    toJSON: method(tFun(tVoid, tString), '() -> String'),
  };

  // The global `AbortSignal` value: its static factories (WHATWG DOM).
  const abortSignalStatics: Record<string, MethodEntry> = {
    timeout: method(tFun(tNumber, tCon('AbortSignal')), 'Number -> AbortSignal'),
    abort: polyMethod(() => tFun(opt(tVar('a')), tCon('AbortSignal')), '(a | Undefined) -> AbortSignal'),
    any: method(tFun(tArray(tCon('AbortSignal')), tCon('AbortSignal')), '[AbortSignal] -> AbortSignal'),
  };

  return {
    Document: documentMethods,
    Element: elementMethods,
    Window: windowMethods,
    Storage: storageMethods,
    Event: eventMethods,
    Navigator: navigatorMethods,
    Response: responseMethods,
    AbortSignal: abortSignalMethods,
    AbortController: abortControllerMethods,
    URLSearchParams: urlSearchParamsMethods,
    URL: urlMethods,
    AbortSignalStatics: abortSignalStatics,
  };
}

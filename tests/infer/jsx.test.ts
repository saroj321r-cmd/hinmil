// ============================================================================
// JSX inference tests
//
// JSX elements desugar to calls of the component with a props record (plus
// `children`), evaluate to the nominal `ReactElement` type, and reuse the
// engine's normal call diagnostics. Lowercase intrinsic tags check known
// attributes against the builtin DOM catalogue (src/infer/jsx-dom.ts);
// unknown names (data-*, aria-*, exotics) stay unchecked.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { TempProject } from '../helpers/project';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('JSX element types', () => {
  test('intrinsic element evaluates to ReactElement', () => {
    const r = engine.infer(`const el = <div className="x">hoi</div>;`);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('ReactElement');
  });

  test('fragment evaluates to ReactElement', () => {
    const r = engine.infer(`const el = <><p>a</p><p>b</p></>;`);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('ReactElement');
  });

  test('ReactElement is usable in annotations without ::types', () => {
    const r = engine.infer(`
      // App :: { name :: String } -> ReactElement
      const App = ({ name }) => <p>{name}</p>;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('{ name :: String } -> ReactElement');
  });
});

describe('Component props checking', () => {
  const greeting = `
    // Greeting :: { name :: String } -> ReactElement
    const Greeting = ({ name }) => <p>{name}</p>;
  `;

  test('correct props pass', () => {
    const r = engine.infer(`${greeting}const el = <Greeting name="Ada" />;`);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('wrong prop type is a diagnostic on the call', () => {
    const r = engine.infer(`${greeting}const el = <Greeting name={42} />;`);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/Number.*String|String.*Number/);
  });

  test('missing required prop is a diagnostic', () => {
    const r = engine.infer(`${greeting}const el = <Greeting />;`);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/name/);
  });

  test('extra props are allowed (open record semantics)', () => {
    const r = engine.infer(`${greeting}const el = <Greeting name="Ada" extra={1} />;`);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('children are passed as the children prop', () => {
    const r = engine.infer(`
      // Card :: { title :: String, children :: a } -> ReactElement
      const Card = ({ title, children }) => <section>{children}</section>;
      const el = <Card title="hoi"><p>inhoud</p></Card>;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('spread props type-check like object spreads', () => {
    const r = engine.infer(`
      ${greeting}
      const defaults = { name: 42 };
      const el = <Greeting {...defaults} />;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('unbound component reports unbound variable', () => {
    const r = engine.infer(`const el = <Mystery />;`);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/Unbound.*Mystery/);
  });

  test('member-expression component resolves through the object', () => {
    const r = engine.infer(`
      // Button :: { label :: String } -> ReactElement
      const Button = ({ label }) => <button>{label}</button>;
      const UI = { Button };
      const el = <UI.Button label="ok" />;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('ReactElement');
  });

  test('class components are instantiated with new behind the scenes', () => {
    const r = engine.infer(`
      class Timer {
        constructor(props) { this.props = props; }
      }
      const el = <Timer />;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('ReactElement');
  });
});

describe('Optional props', () => {
  test('`| Undefined` props may be omitted', () => {
    const r = engine.infer(`
      // Tooltip :: { text :: String, delay :: (Number | Undefined) } -> ReactElement
      const Tooltip = ({ text, delay = 300 }) => <span data-delay={delay}>{text}</span>;
      const el = <Tooltip text="Opslaan" />;
      const el2 = <Tooltip text="Opslaan" delay={1000} />;
    `);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('`| Undefined` props still type-check when present', () => {
    const r = engine.infer(`
      // Tooltip :: { text :: String, delay :: (Number | Undefined) } -> ReactElement
      const Tooltip = ({ text, delay = 300 }) => <span data-delay={delay}>{text}</span>;
      const el = <Tooltip text="Opslaan" delay="lang" />;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/Number \| Undefined.*String|String.*Number \| Undefined/);
  });

  const maybeDefs = `
    // Maybe :: Just a | Nothing
    function Maybe() { throw TypeError('nope'); }
    // Just :: a -> Maybe a
    class Just {
      constructor(value) {
        // Maybe#value :: Maybe a ~> a
        this.value = value;
      }
      // Maybe#getOrElse :: Maybe a ~> a -> a
      getOrElse(d) { return this.value; }
    }
    // Nothing :: () -> Maybe a
    class Nothing {
      // Maybe#getOrElse :: Maybe a ~> a -> a
      getOrElse(d) { return d; }
    }
    // Badge :: { label :: Maybe String } -> ReactElement
    const Badge = ({ label }) => <span>{label.getOrElse('anoniem')}</span>;
  `;

  test('Maybe props accept Just and Nothing', () => {
    const r = engine.infer(`${maybeDefs}
      const a = <Badge label={new Just('Raf')} />;
      const b = <Badge label={new Nothing()} />;
    `);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('Maybe props reject a bare value', () => {
    const r = engine.infer(`${maybeDefs}const el = <Badge label="Raf" />;`);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/Maybe String/);
  });

  test('Maybe props reject wrong element type and missing prop', () => {
    const wrong = engine.infer(`${maybeDefs}const el = <Badge label={new Just(42)} />;`);
    expect(wrong.diagnostics.length).toBeGreaterThan(0);

    resetTypeVarCounter();
    const missing = new InferenceEngine().infer(`${maybeDefs}const el = <Badge />;`);
    expect(missing.diagnostics.length).toBeGreaterThan(0);
    expect(missing.diagnostics[0].message).toMatch(/label/);
  });
});

describe('Hover coverage (nodeTypes)', () => {
  // The LSP hover picks the innermost nodeTypes entry containing the offset.
  // JSX desugaring registers the tag name as the callee and each attribute as
  // a property whose span covers the attr name, so hovering tag/prop names
  // shows the component signature / field type.
  test('tag names and attribute names carry types', () => {
    const src = `
      // Badge :: { label :: String, count :: Number } -> ReactElement
      const Badge = ({ label, count }) => <span>{label}</span>;
      const el = <Badge label="x" count={3} />;
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);

    const typeAt = (offset: number) => {
      let best: string | null = null; let bestStart = -1;
      for (const [start, { type, end }] of r.nodeTypes) {
        if (start <= offset && offset < end && start > bestStart) {
          best = typeToString(r.substitution.apply(type));
          bestStart = start;
        }
      }
      return best;
    };

    expect(typeAt(src.indexOf('<Badge') + 2)).toBe('{ label :: String, count :: Number } -> ReactElement');
    expect(typeAt(src.indexOf('label="x"'))).toBe('String');
    expect(typeAt(src.indexOf('count={3}'))).toBe('Number');
  });
});

describe('Intrinsic attribute catalogue', () => {
  test('known attributes are checked against their declared types', () => {
    const bad = [
      [`const el = <div className={3}>x</div>;`, /Number.*String|String.*Number/],
      [`const el = <div style="color:red">x</div>;`, /String/],
      [`const el = <button onClick="handler">x</button>;`, /String.*->|->.*String/],
      [`const el = <input checked="ja" />;`, /String.*Boolean|Boolean.*String/],
      [`const el = <td colSpan="2">x</td>;`, /String.*Number|Number.*String/],
      [`const el = <div dangerouslySetInnerHTML="<b>x</b>" />;`, /__html/],
    ] as const;
    for (const [src, re] of bad) {
      resetTypeVarCounter();
      const r = new InferenceEngine().infer(src);
      expect({ src, diags: r.diagnostics.length > 0 }).toEqual({ src, diags: true });
      expect(r.diagnostics[0].message).toMatch(re);
    }
  });

  test('correct attribute values pass', () => {
    const r = engine.infer(`
      const els = [
        <div className="x" id="a" style={{ color: 'red', margin: 4 }} hidden>x</div>,
        <button onClick={() => 1} disabled>x</button>,
        <input type="text" placeholder="naam" onChange={(e) => e} maxLength={10} />,
        <label htmlFor="naam">Naam</label>,
        <img src="a.png" alt="" width={170} height="179" />,
        <svg viewBox="0 0 24 24" fill="none"><path d="M0 0" /></svg>,
        <div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} />,
      ];
    `);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('unknown attribute names stay unchecked (data-*, aria-*, exotics)', () => {
    const r = engine.infer(`
      const el = <div data-test="a" aria-label={42} blorp={{}}>x</div>;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('checked attribute names carry a hover type (nodeTypes)', () => {
    const src = `const el = <div className="x">x</div>;`;
    const r = engine.infer(src);
    const at = src.indexOf('className');
    let best: string | null = null; let bestStart = -1;
    for (const [start, { type, end }] of r.nodeTypes) {
      if (start <= at && at < end && start > bestStart) {
        best = typeToString(r.substitution.apply(type));
        bestStart = start;
      }
    }
    expect(best).toBe('String');
  });
});

describe('React-special attributes (key, ref)', () => {
  test('key accepts String and Number, rejects objects', () => {
    const ok = engine.infer(`
      const els = ['a', 'b'].map((s, i) => <li key={i}>{s}</li>);
      const el = <div key="vast">x</div>;
    `);
    expect(ok.diagnostics).toHaveLength(0);

    resetTypeVarCounter();
    const bad = new InferenceEngine().infer(`const el = <div key={{}}>x</div>;`);
    expect(bad.diagnostics.length).toBeGreaterThan(0);
  });

  test('key/ref are stripped from component props (no phantom fields)', () => {
    const r = engine.infer(`
      // Badge :: { label :: String } -> ReactElement
      const Badge = ({ label }) => <span>{label}</span>;
      const els = ['a', 'b'].map((s, i) => <Badge key={i} label={s} />);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('ref accepts a ref object and a callback ref, rejects strings', () => {
    const ok = engine.infer(`
      const r = { current: null };
      const els = [<input ref={r} />, <input ref={(node) => { node; }} />];
    `);
    expect(ok.diagnostics).toHaveLength(0);

    resetTypeVarCounter();
    const bad = new InferenceEngine().infer(`const el = <input ref="legacy" />;`);
    expect(bad.diagnostics.length).toBeGreaterThan(0);
    expect(bad.diagnostics[0].message).toMatch(/current|String/);
  });
});

describe('Intrinsic tags and expression containers', () => {
  test('intrinsic attribute expressions are still checked', () => {
    const r = engine.infer(`
      const xs = [1, 2, 3];
      const el = <ul>{xs.mapp((x) => x)}</ul>;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/mapp/);
  });

  test('empty expression container is fine', () => {
    const r = engine.infer(`const el = <div>{/* alleen commentaar */}</div>;`);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('conditional and mapped children infer normally', () => {
    const r = engine.infer(`
      // Row :: { n :: Number } -> ReactElement
      const Row = ({ n }) => <li>{n}</li>;
      // List :: { items :: [Number] } -> ReactElement
      const List = ({ items }) =>
        items.length === 0 ? <p>leeg</p> : <ul>{items.map((n) => <Row n={n} />)}</ul>;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  // Regression: the array-literal cross-tag-widening rollback used to discard
  // ALL diagnostics from the first pass — including genuine call diagnostics
  // from element inference.  A component with a missing prop nested among
  // sibling children (children become an ArrayExpression) lost its error.
  test('missing prop survives among sibling children', () => {
    const r = engine.infer(`
      // Badge :: { label :: String } -> ReactElement
      const Badge = ({ label }) => <span>{label}</span>;
      // Avatar :: { url :: String } -> ReactElement
      const Avatar = ({ url }) => <img src={url} />;
      // Card :: { title :: String, children :: a } -> ReactElement
      const Card = ({ title, children }) => <section>{children}</section>;
      const el = <Card title="x"><Avatar url="y" /><Badge /></Card>;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/label/);
  });

  test('call diagnostics inside plain array literals survive widening', () => {
    const r = engine.infer(`
      // mk :: { label :: String } -> Number
      const mk = ({ label }) => label.length;
      const xs = ['een', mk({})];
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/label/);
  });
});

describe('React signatures via react.hm override', () => {
  const reactHm = fs.readFileSync(path.join(__dirname, '../../sample/react.hm'), 'utf8');
  let project: TempProject;

  beforeAll(() => {
    project = new TempProject('jsx-react-hm', { overrides: { react: './react.hm' } });
    project.setup();
    project.write('react.hm', reactHm);
  });

  afterAll(() => project.cleanup());

  test('useState value and setter types flow', () => {
    const r = project.inferSource('App.jsx', `
      import { useState } from 'react';
      // Counter :: {} -> ReactElement
      const Counter = () => {
        const [count, setCount] = useState(0);
        const bad = count.toUpperCase();
        return <button onClick={() => setCount((c) => c + 1)}>{count}</button>;
      };
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/toUpperCase/);
  });

  test('hooks example is diagnostic-free', () => {
    const r = project.inferSource('App.jsx', `
      import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
      // App :: { label :: String } -> ReactElement
      const App = ({ label }) => {
        const [n, setN] = useState(0);
        const last = useRef(0);
        useEffect(() => { last.current = n; }, [n]);
        const pretty = useMemo(() => label + n, [label, n]);
        const reset = useCallback(() => setN(0), []);
        return <p onDoubleClick={reset}>{pretty}</p>;
      };
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('context Provider checks the value type', () => {
    const r = project.inferSource('App.jsx', `
      import { createContext } from 'react';
      const Theme = createContext('licht');
      const el = <Theme.Provider value={42}><p>x</p></Theme.Provider>;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('useContext yields the context value type', () => {
    const r = project.inferSource('App.jsx', `
      import { createContext, useContext } from 'react';
      const Theme = createContext('licht');
      // Button :: {} -> ReactElement
      const Button = () => {
        const theme = useContext(Theme);
        return <button className={'btn-' + theme}>ok</button>;
      };
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('useRef(null) DOM-ref idiom is diagnostic-free', () => {
    const r = project.inferSource('App.jsx', `
      import { useRef, useEffect } from 'react';
      // App :: {} -> ReactElement
      const App = () => {
        const inputRef = useRef(null);
        useEffect(() => { inputRef.current.focus(); }, []);
        return <input ref={inputRef} placeholder="naam" />;
      };
    `);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('forwardRef yields an ordinary component whose props are checked', () => {
    const ok = project.inferSource('App.jsx', `
      import { forwardRef } from 'react';
      // FancyInput :: { label :: String } -> ReactElement
      const FancyInput = forwardRef((props, ref) => (
        <label>{props.label}<input ref={ref} /></label>
      ));
      const el = <FancyInput label="Naam" ref={{ current: null }} />;
    `);
    expect(ok.diagnostics.map(d => d.message)).toEqual([]);

    const bad = project.inferSource('App.jsx', `
      import { forwardRef } from 'react';
      // FancyInput :: { label :: String } -> ReactElement
      const FancyInput = forwardRef((props, ref) => <input ref={ref} />);
      const el = <FancyInput label={42} />;
    `);
    expect(bad.diagnostics.length).toBeGreaterThan(0);
    expect(bad.diagnostics[0].message).toMatch(/Number|String/);
  });

  test('useReducer, useImperativeHandle, memo, Suspense and friends type-check', () => {
    const r = project.inferSource('App.jsx', `
      import { useReducer, useImperativeHandle, createRef, memo, Suspense, StrictMode, useTransition, useId, useDeferredValue } from 'react';
      // Row :: { naam :: String } -> ReactElement
      const Row = memo(({ naam }) => <li>{naam}</li>);
      // App :: {} -> ReactElement
      const App = () => {
        const [count, dispatch] = useReducer((s, a) => s + 1, 0);
        const id = useId();
        const [pending, start] = useTransition();
        const v = useDeferredValue(id);
        return (
          <StrictMode>
            <Suspense fallback={<p>laden</p>}>
              <ul id={v}><Row naam="a" /><button onClick={() => dispatch('inc')}>{count}</button></ul>
            </Suspense>
          </StrictMode>
        );
      };
      const r = createRef();
      const setup = (ref) => useImperativeHandle(ref, () => ({ focus: () => 1 }));
    `);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('JSX in plain .js files works (content-based dispatch)', () => {
    project.write('Badge.js', `
      // Badge :: { label :: String } -> ReactElement
      export const Badge = ({ label }) => <span>{label}</span>;
    `);
    const ok = project.inferSource('App.js', `
      import { useState } from 'react';
      import { Badge } from './Badge';
      // App :: {} -> ReactElement
      const App = () => {
        const [n, setN] = useState(0);
        return <div onClick={() => setN(n + 1)}><Badge label={'n=' + n} /></div>;
      };
    `);
    expect(ok.diagnostics.map(d => d.message)).toEqual([]);

    const bad = project.inferSource('App.js', `
      import { Badge } from './Badge';
      const el = <Badge label={42} />;
    `);
    expect(bad.diagnostics.length).toBeGreaterThan(0);
    expect(bad.diagnostics[0].message).toMatch(/Number.*String|String.*Number/);
  });

  test('sample jsx files are diagnostic-free', () => {
    project.write('Maybe.js', fs.readFileSync(path.join(__dirname, '../../sample/Maybe.js'), 'utf8'));
    // Sample files import each other (Page.js → ./components) — write them
    // all into the project first so cross-file imports resolve.
    const sampleDir = path.join(__dirname, '../../sample/jsx');
    const files = fs.readdirSync(sampleDir).filter(f => /\.(js|jsx)$/.test(f));
    for (const f of files) {
      project.write(f, fs.readFileSync(path.join(sampleDir, f), 'utf8')
        .replace("'../Maybe.js'", "'./Maybe.js'"));
    }
    for (const f of files) {
      const r = project.inferFile(f);
      expect({ file: f, diags: r.diagnostics.map(d => d.message) }).toEqual({ file: f, diags: [] });
    }
  });

  test('readme jsx example is diagnostic-free', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../sample/readme/jsx.jsx'), 'utf8');
    const r = project.inferSource('jsx.jsx', src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });
});

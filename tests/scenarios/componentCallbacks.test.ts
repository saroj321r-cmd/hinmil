// Components and callbacks as React code writes them:
//
//  - a component without parameters (`const App = () => …`) is used as
//    `<App />`.  React passes a props object that the component ignores, so
//    this is not an arity error;
//  - a callback inside an object literal (a JSX child function, a `render`
//    or `onSelect` field) may ignore trailing parameters, exactly like an
//    inline callback argument (`xs.map(() => 0)`).
//
// Both positive and negative cases: a zero-parameter component still types
// its attribute values, and a callback in a field still has to return what
// the field asks for.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

function errors(src: string): string[] {
  return new InferenceEngine().infer(src).diagnostics
    .filter(d => d.severity !== 3)
    .map(d => d.message);
}

const LAYOUT = `
// Page :: { title :: String, subtitle :: String | Undefined, children :: Any } -> ReactElement
const Page = ({ title, subtitle, children }) => (
  <section>
    <h2>{title}</h2>
    {subtitle ? <small>{subtitle}</small> : null}
    {children}
  </section>
);

// Loaded :: { response :: { kind :: String, data :: [String] }, children :: [String] -> ReactElement } -> ReactElement
const Loaded = ({ response, children }) => (response.kind === "ok" ? children(response.data) : <p>Laden…</p>);
`;

describe('components without parameters', () => {
  test('<App /> with App :: () -> ReactElement', () => {
    expect(errors(`
// Settings :: () -> ReactElement
const Settings = () => <form><button type="submit">Opslaan</button></form>;

// App :: () -> ReactElement
const App = () => (
  <main>
    <Settings />
  </main>
);
`)).toEqual([]);
  });

  test('an unannotated component without parameters', () => {
    expect(errors(`
const Footer = () => <footer>Paper trading: geen echt geld.</footer>;

// Shell :: { title :: String } -> ReactElement
const Shell = ({ title }) => <div><h1>{title}</h1><Footer /></div>;
`)).toEqual([]);
  });

  test('attribute values on a component without parameters are still typed', () => {
    const errs = errors(`
// Footer :: () -> ReactElement
const Footer = () => <footer>Wedstrijdcentrum</footer>;

// pageTitle :: Number -> String
const pageTitle = n => "Pagina " + String(n);

// Shell :: () -> ReactElement
const Shell = () => <Footer title={pageTitle("een")} />;
`);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\\n')).toMatch(/String|Number/);
  });

  test('a component that takes props still requires them', () => {
    const errs = errors(`${LAYOUT}
// Screen :: () -> ReactElement
const Screen = () => <Page subtitle="Alleen de lijst" />;
`);
    expect(errs.join('\\n')).toMatch(/title/);
  });
});

describe('callbacks in object literals ignore trailing parameters', () => {
  test('a JSX child function that ignores the loaded data', () => {
    expect(errors(`${LAYOUT}
// Settings :: () -> ReactElement
const Settings = () => <form />;

// AlertsScreen :: { response :: { kind :: String, data :: [String] } } -> ReactElement
const AlertsScreen = ({ response }) => (
  <Page title="Alerts">
    <Loaded response={response}>{() => <Settings />}</Loaded>
  </Page>
);
`)).toEqual([]);
  });

  test('a JSX child function that uses the loaded data', () => {
    expect(errors(`${LAYOUT}
// TeamList :: { response :: { kind :: String, data :: [String] } } -> ReactElement
const TeamList = ({ response }) => (
  <Loaded response={response}>{teams => <ul>{teams.map(t => <li key={t}>{t}</li>)}</ul>}</Loaded>
);
`)).toEqual([]);
  });

  test('a handler field in a plain call', () => {
    expect(errors(`
// withMenu :: { label :: String, onSelect :: (String, Number) -> String } -> String
const withMenu = ({ label, onSelect }) => label + onSelect("matching", 2);

// openMatching :: () -> String
const openMatching = () => withMenu({ label: "Matching", onSelect: () => "/matching" });

// openByIndex :: () -> String
const openByIndex = () => withMenu({ label: "Jobs", onSelect: key => "/" + key });
`)).toEqual([]);
  });

  test('an optional handler field (| Undefined)', () => {
    expect(errors(`
// Row :: { id :: Number, onClick :: (Number -> String) | Undefined } -> String
const Row = ({ id, onClick }) => (onClick ? onClick(id) : String(id));

// clickable :: () -> String
const clickable = () => Row({ id: 7, onClick: () => "/fixtures" });
`)).toEqual([]);
  });

  test('the result of a callback in a field is still checked', () => {
    const errs = errors(`
// withMenu :: { label :: String, onSelect :: (String, Number) -> String } -> String
const withMenu = ({ label, onSelect }) => label + onSelect("matching", 2);

// broken :: () -> String
const broken = () => withMenu({ label: "Matching", onSelect: () => 42 });
`);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\\n')).toMatch(/Number|String/);
  });

  test('a parameter the callback does take still gets the field type', () => {
    const errs = errors(`
// withMenu :: { label :: String, onSelect :: (String, Number) -> String } -> String
const withMenu = ({ label, onSelect }) => label + onSelect("matching", 2);

// broken :: () -> String
const broken = () => withMenu({ label: "Jobs", onSelect: key => key * 2 });
`);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('passing props through a generic wrapper', () => {
  test('<Comp {...componentProps} /> with componentProps :: p', () => {
    expect(errors(`
// InfiniteList :: { component :: p -> ReactElement, componentProps :: p, hasMore :: Boolean } -> ReactElement
const InfiniteList = ({ component, componentProps, hasMore }) => {
  const Comp = component;
  return <div><Comp {...componentProps} />{hasMore ? <span>Meer laden…</span> : null}</div>;
};

// Table :: { rows :: [String] } -> ReactElement
const Table = ({ rows }) => <ul>{rows.map(r => <li key={r}>{r}</li>)}</ul>;

// Screen :: () -> ReactElement
const Screen = () => <InfiniteList component={Table} componentProps={{ rows: ["a", "b"] }} hasMore={false} />;
`)).toEqual([]);
  });

  test('the wrapped component still checks its props', () => {
    const errs = errors(`
// InfiniteList :: { component :: p -> ReactElement, componentProps :: p, hasMore :: Boolean } -> ReactElement
const InfiniteList = ({ component, componentProps, hasMore }) => {
  const Comp = component;
  return <div><Comp {...componentProps} />{hasMore ? <span>Meer laden…</span> : null}</div>;
};

// Table :: { rows :: [String] } -> ReactElement
const Table = ({ rows }) => <ul>{rows.map(r => <li key={r}>{r}</li>)}</ul>;

// Screen :: () -> ReactElement
const Screen = () => <InfiniteList component={Table} componentProps={{ rows: [1, 2] }} hasMore={false} />;
`);
    expect(errs.length).toBeGreaterThan(0);
  });
});

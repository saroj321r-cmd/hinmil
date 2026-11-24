// Browser globals — document, window, navigator, localStorage and
// sessionStorage are TYPED out of the box (`Document`, `Window`, `Navigator`,
// `Storage`).  Members from the compact DOM catalogue complete, hover and
// get return-type checking; anything outside the catalogue silently resolves
// to `Any`, so the huge DOM surface never false-positives.
// Settings: `hinmil.dom.globalTypes` (kill switch, default on) and
// `hinmil.dom.strictNulls` (lookups that can miss return `T | Null`).

const el = document.getElementById('app');   // el is an Element
el.textContent = 'Hello from hinmil';         // checked: String property
document.querySelector('.button').addEventListener('click', (e) => {
  e.preventDefault();                        // e is an Event
  console.log(e.clientX, e.clientY);         // Numbers
});

window.addEventListener('resize', () => {
  console.log(window.innerWidth, window.innerHeight);  // Numbers
});

localStorage.setItem('theme', 'dark');
const theme = localStorage.getItem('theme'); // String (or String | Null with strictNulls)
sessionStorage.removeItem('draft');

export const online = navigator.onLine;      // Boolean

// Uncatalogued members fall back to Any — no diagnostics:
el.style.color = 'rebeccapurple';
el.classList.add('active');

// The fetch API is typed for EVERY project (also without DOM globals),
// as `(u, o?) -> Promise e Response`:
export const loadUsers = async () => {
  const r = await fetch('/api/users');       // r is a Response
  if (!r.ok) return '';
  return r.text();                           // Promise e String
};

// DOM types are usable in annotations too:
// highlight :: Element -> Void
export const highlight = (node) => node.setAttribute('data-active', 'true');

// Local bindings still shadow the globals with full strict checking:
// this `document` is an ordinary record, so unknown members would error.
export const describe = () => {
  const document = { title: 'my doc', pages: 3 };
  return document.title + ' (' + String(document.pages) + ')';
};

export const currentTheme = theme;

// Want different globals?  Declare them in globals.hm — a user declaration
// always wins over the built-in types:
//
//   localStorage :: { getItem :: String -> (String | Null), setItem :: (String, String) -> Void }
//
// Or extend the catalogue per type:
//
//   ::global Element#animate :: Element ~> ([a], { duration :: Number }) -> Any

// Vite/CRA-style entry point.  Both 'react' and 'react-dom/client' resolve
// through the typings bundled with the extension (hm-types-builtin/) — this
// file needs zero configuration.  `document` is a built-in browser global.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Page from './Page';

const root = createRoot(document.getElementById('root'));

root.render(
  <StrictMode>
    <Page />
  </StrictMode>,
);

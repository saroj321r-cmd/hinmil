// Context API: createContext / useContext / <Ctx.Provider>.
import { createContext, useContext } from 'react';

// The context value's type is remembered: `createContext('licht')` makes a
// `Context String`, so `useContext(ThemeContext)` is a `String`.
const ThemeContext = createContext('licht');

// ThemedButton :: { label :: String } -> ReactElement
const ThemedButton = ({ label }) => {
  const theme = useContext(ThemeContext);
  return <button className={'btn-' + theme}>{label}</button>;
};

// The Provider checks its `value` prop against the context's type:
// `value={42}` here would be a type error (Number vs String).
// App :: { children :: a } -> ReactElement
const App = ({ children }) => (
  <ThemeContext.Provider value="donker">
    <main>
      {children}
      <ThemedButton label="opslaan" />
    </main>
  </ThemeContext.Provider>
);

export { ThemeContext, ThemedButton, App };

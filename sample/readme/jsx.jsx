// ============================================
// JSX & React — the README's larger example
// (see README.md § "JSX & React")
// ============================================

import { useState, useMemo, createContext, useContext } from 'react';

const ThemeContext = createContext('licht'); // Context String

// Badge :: { label :: String } -> ReactElement
const Badge = ({ label }) => <span className="badge">{label}</span>;

// Children arrive as the `children` prop, like in React itself.
// Card :: { title :: String, children :: a } -> ReactElement
const Card = ({ title, children }) => {
  const theme = useContext(ThemeContext); // theme :: String
  return (
    <section className={'card-' + theme}>
      <h2>{title}</h2>
      {children}
    </section>
  );
};

// Todo :: { id :: Number, text :: String, done :: Boolean } -> ReactElement
const Todo = ({ id, text, done }) => (
  <li key={id} className={done ? 'done' : 'open'}>{text}</li>
);

// TodoApp :: { items :: [{ id :: Number, text :: String, done :: Boolean }] } -> ReactElement
const TodoApp = ({ items }) => {
  const [filter, setFilter] = useState('alle'); // filter :: String
  const open = useMemo(() => items.filter((it) => !it.done), [items]);

  return (
    <ThemeContext.Provider value="donker">
      <Card title="Taken">
        <Badge label={filter} />
        {open.length === 0 ? (
          <p>Niets te doen!</p>
        ) : (
          <ul>{open.map((it) => <Todo id={it.id} text={it.text} done={it.done} />)}</ul>
        )}
        <button onClick={() => setFilter('open')}>alleen open</button>
      </Card>
    </ThemeContext.Provider>
  );
};

export default TodoApp;

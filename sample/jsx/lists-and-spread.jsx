// Lists, conditional rendering, fragments and spread props.
import { Fragment } from 'react';

// Todo :: { id :: Number, text :: String, done :: Boolean } -> ReactElement
const Todo = ({ id, text, done }) => (
  <li key={id} className={done ? 'done' : 'open'}>
    {text}
  </li>
);

// Mapping over data produces `[ReactElement]`; the callback's element type
// is checked against Todo's props.
// TodoList :: { items :: [{ id :: Number, text :: String, done :: Boolean }] } -> ReactElement
const TodoList = ({ items }) =>
  items.length === 0 ? (
    <p>Niets te doen!</p>
  ) : (
    <ul>
      {items.map((it) => (
        <Todo id={it.id} text={it.text} done={it.done} />
      ))}
    </ul>
  );

// Spread props type-check like an object spread: `{...defaults}` must carry
// the fields Todo demands (or they must arrive via other attributes).
const defaults = { id: 0, text: 'nieuw item', done: false };
const blankTodo = <Todo {...defaults} />;

// Fragments group children without a wrapper element; `<>…</>` works too.
// Overview :: { items :: [{ id :: Number, text :: String, done :: Boolean }] } -> ReactElement
const Overview = ({ items }) => (
  <Fragment>
    <h1>Takenlijst</h1>
    <TodoList items={items} />
    <>
      <hr />
      <small>{items.length} items</small>
    </>
  </Fragment>
);

export { Todo, TodoList, Overview, blankTodo };

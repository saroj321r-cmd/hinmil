// Classic Redux, typed by ../hm-types/redux.hm — a conventional stub:
// `hm-types/<package>.hm` is picked up automatically, no config needed.
import { createStore, combineReducers } from 'redux';

// The store's state type flows out of the reducer: `state :: Number` here,
// so `store.getState() + 1` type-checks and `dispatch` expects the
// reducer's action shape.
// counter :: (Number, { type :: String }) -> Number
const counter = (state, action) =>
  action.type === 'INCREMENT' ? state + 1
    : action.type === 'DECREMENT' ? state - 1
      : state;

export const store = createStore(counter, 0);

store.subscribe(() => {
  console.log('count is now', store.getState());
});

store.dispatch({ type: 'INCREMENT' });
store.dispatch({ type: 'DECREMENT' });

// `combineReducers` keeps the root state polymorphic (HM cannot map record
// fields to slice state types), but the store record itself stays typed.
// todos :: ([String], { type :: String, text :: String }) -> [String]
const todos = (state, action) =>
  action.type === 'ADD_TODO' ? state.concat([action.text]) : state;

const rootReducer = combineReducers({ counter, todos });
export const appStore = createStore(rootReducer);

// `subscribe` returns the unsubscribe thunk.
// unsubscribe :: () -> Void
const unsubscribe = appStore.subscribe(() => {});
unsubscribe();

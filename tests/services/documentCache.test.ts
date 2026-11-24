// The edit-tracking helpers behind the language server's word-boundary gate:
// where did the latest edit leave the caret, and is the caret inside a word?

import { computeCaretOffset, isIdentChar } from '../../src/services/documentCache';

describe('computeCaretOffset', () => {
  test('typing at the end of a name puts the caret after the inserted text', () => {
    const before = 'const total = subtot';
    const after = 'const total = subtotal';
    expect(computeCaretOffset(before, after)).toBe(after.length);
  });

  test('typing inside a name puts the caret inside it', () => {
    const before = 'const vat = amount * rate;';
    const after = 'const vat = amount * vatRate;';
    // "rate" → "vatRate": the edit inserts "vatR" and drops "r"; the caret
    // ends right after the changed part, before the untouched "ate;".
    expect(computeCaretOffset(before, after)).toBe(after.indexOf('ate;'));
  });

  test('deleting text puts the caret where the text was', () => {
    const before = 'formatAmount (cents, "EUR")';
    const after = 'formatAmount (cents)';
    expect(computeCaretOffset(before, after)).toBe(after.indexOf(')'));
  });

  test('an unchanged text puts the caret at the end', () => {
    expect(computeCaretOffset('const x = 1;', 'const x = 1;')).toBe('const x = 1;'.length);
  });
});

describe('isIdentChar', () => {
  test.each(['a', 'Z', '0', '9', '_', '$'])('%s is part of an identifier', (c) => {
    expect(isIdentChar(c)).toBe(true);
  });

  test.each([' ', '.', '(', '\n', '-', undefined])('%p is a word boundary', (c) => {
    expect(isIdentChar(c)).toBe(false);
  });
});

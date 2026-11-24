/**
 * Pure helper for the language server's source-identity short-circuit.
 *
 * Extracted from `server.ts` (which opens a connection when it is loaded; the
 * in-process LSP tests start it on a socket) so the globals-change
 * invalidation invariant can be unit-tested in isolation.
 */

/**
 * Decide whether `validateTextDocument` may reuse the previously published
 * diagnostics instead of re-inferring.  Reuse is safe only when:
 *  - the document text is byte-identical to the last validated text, AND
 *  - a cached inference result exists for the document, AND
 *  - the globals generation under which the document was last validated still
 *    matches the current generation.
 *
 * The generation guard is what makes a globals reload (which bumps the
 * generation) force a fresh inference for dependent documents whose OWN text
 * is unchanged.
 */
export function canShortCircuit(args: {
  prevSource: string | undefined;
  source: string;
  hasCached: boolean;
  prevGeneration: number | undefined;
  currentGeneration: number;
}): boolean {
  return (
    args.prevSource === args.source &&
    args.hasCached &&
    args.prevGeneration === args.currentGeneration
  );
}

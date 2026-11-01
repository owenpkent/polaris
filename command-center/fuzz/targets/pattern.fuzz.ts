import { compilePattern } from '../../src/automation/pattern.ts';
import { isPatternError, rethrowUnless } from './expected.ts';

// The bounded regular expression engine behind the 'matches' rule condition: a pattern written by
// the owner or an agent, run against titles written by third parties. The input splits at the
// first NUL into the pattern and the text. A pattern is compiled or refused with PatternError;
// matching must finish (the per-input timeout is the bound) and, where JavaScript's RegExp also
// accepts the pattern, agree with it. The oracle runs only on short text, because RegExp itself
// backtracks and a hang there would be its bug, not ours.
export function fuzz(data: Buffer): void {
  const nul = data.indexOf(0);
  const source = (nul < 0 ? data : data.subarray(0, nul)).toString('utf8');
  const text = (nul < 0 ? Buffer.alloc(0) : data.subarray(nul + 1)).toString('utf8');
  let compiled;
  try {
    compiled = compilePattern(source);
  } catch (err) {
    rethrowUnless(err, isPatternError);
    return;
  }
  const ours = compiled.test(text);
  if (source.length > 40 || text.length > 24) return;
  let theirs: boolean;
  try {
    theirs = new RegExp(source).test(text);
  } catch {
    return; // RegExp refuses a pattern we accept: the module promises agreement only where both accept.
  }
  if (ours !== theirs) throw new Error(`pattern ${JSON.stringify(source)} on ${JSON.stringify(text)}: ours ${ours}, RegExp ${theirs}`);
}

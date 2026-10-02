// A regular expression matcher whose running time is bounded by the size of the pattern times
// the size of the input, for the 'matches' rule condition.
//
// A rule's pattern is written by the owner or by an agent, and it is run against titles written by
// third parties. JavaScript's own RegExp is a backtracking engine: a pattern such as ^(a|aa)+$
// against eighty "a"s and a "!" takes longer than the daemon lives, and since matching is
// synchronous nothing else in the process runs while it does. Heuristics that reject "the
// dangerous shapes" cannot be complete. This engine compiles the pattern to a Thompson NFA and
// simulates it with one set of states per input position, so every pattern it accepts runs in
// O(pattern * input) time and no pattern can be slow. Like RegExp without the u flag, it works
// on UTF-16 code units.
//
// The language is the everyday subset of JavaScript syntax: literals and escapes, `.`, character
// classes, `\d \w \s` and their negations, `\b \B ^ $`, groups (capturing or not), alternation,
// and the quantifiers `* + ? {n} {n,} {n,m}` with an optional lazy suffix. Backreferences,
// lookaround, and flags are not supported, and a pattern that uses them is refused at validation
// with a message that says so. The result is a boolean, so greedy and lazy match the same way.
// Where a pattern is accepted, `test` agrees with `new RegExp(pattern).test(input)`.

export class PatternError extends Error {}

type CharTest = (cp: number) => boolean;

type Node =
  | { kind: 'char'; test: CharTest }
  | { kind: 'assert'; which: Assertion }
  | { kind: 'seq'; items: Node[] }
  | { kind: 'alt'; branches: Node[] }
  | { kind: 'repeat'; child: Node; min: number; max: number | null };

type Assertion = 'start' | 'end' | 'word' | 'nonword';

type State =
  | { op: 'char'; test: CharTest; out: number }
  | { op: 'split'; out: number; out1: number }
  | { op: 'assert'; which: Assertion; out: number }
  | { op: 'match' };

/** A `{n,m}` above this is refused: each repetition is a copy of the group in the NFA. */
const MAX_REPEAT = 100;
/** Pattern length is capped by the rule schema; this bounds what nested repeats can expand to. */
const MAX_STATES = 5000;

const CP = {
  tab: 0x09, lf: 0x0a, vt: 0x0b, ff: 0x0c, cr: 0x0d, space: 0x20, nbsp: 0xa0,
  ls: 0x2028, ps: 0x2029, bom: 0xfeff,
};

function isDigit(cp: number): boolean { return cp >= 0x30 && cp <= 0x39; }
function isWordChar(cp: number): boolean {
  return isDigit(cp) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f;
}
/** JavaScript's \s: the WhiteSpace and LineTerminator productions. */
function isSpace(cp: number): boolean {
  return cp === CP.tab || cp === CP.lf || cp === CP.vt || cp === CP.ff || cp === CP.cr || cp === CP.space
    || cp === CP.nbsp || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === CP.ls || cp === CP.ps
    || cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === CP.bom;
}
function isLineTerminator(cp: number): boolean {
  return cp === CP.lf || cp === CP.cr || cp === CP.ls || cp === CP.ps;
}

const SIMPLE_ESCAPES: Record<string, number> = { n: CP.lf, r: CP.cr, t: CP.tab, f: CP.ff, v: CP.vt, 0: 0 };
const CLASS_ESCAPES: Record<string, CharTest> = {
  d: isDigit, D: (cp) => !isDigit(cp),
  w: isWordChar, W: (cp) => !isWordChar(cp),
  s: isSpace, S: (cp) => !isSpace(cp),
};

// ------------------------------------------------------------------------------------ parsing

class Parser {
  readonly #cps: number[];
  #pos = 0;

  constructor(source: string) {
    this.#cps = Array.from({ length: source.length }, (_, i) => source.charCodeAt(i));
  }

  parse(): Node {
    const node = this.#alternation();
    if (this.#pos < this.#cps.length) throw new PatternError("unmatched ')'");
    return node;
  }

  #peek(): string | undefined {
    const cp = this.#cps[this.#pos];
    return cp === undefined ? undefined : String.fromCharCode(cp);
  }

  #next(): string {
    const c = this.#peek();
    if (c === undefined) throw new PatternError('pattern ends unexpectedly');
    this.#pos += 1;
    return c;
  }

  #eat(c: string): boolean {
    if (this.#peek() !== c) return false;
    this.#pos += 1;
    return true;
  }

  #alternation(): Node {
    const branches = [this.#sequence()];
    while (this.#eat('|')) branches.push(this.#sequence());
    return branches.length === 1 ? branches[0] : { kind: 'alt', branches };
  }

  #sequence(): Node {
    const items: Node[] = [];
    for (;;) {
      const c = this.#peek();
      if (c === undefined || c === '|' || c === ')') break;
      const atom = this.#atom();
      items.push(this.#quantified(atom));
    }
    return items.length === 1 ? items[0] : { kind: 'seq', items };
  }

  #quantified(atom: Node): Node {
    const bounds = this.#quantifier();
    if (!bounds) return atom;
    if (atom.kind === 'assert') throw new PatternError('a quantifier cannot follow ^, $, \\b, or \\B');
    const node: Node = { kind: 'repeat', child: atom, ...bounds };
    if (this.#quantifier()) throw new PatternError('nothing to repeat: two quantifiers in a row');
    return node;
  }

  /** The quantifier at the cursor, if there is one; a `{` that does not form one is a literal. */
  #quantifier(): { min: number; max: number | null } | undefined {
    const c = this.#peek();
    let bounds: { min: number; max: number | null } | undefined;
    if (c === '*') bounds = { min: 0, max: null };
    else if (c === '+') bounds = { min: 1, max: null };
    else if (c === '?') bounds = { min: 0, max: 1 };
    else if (c === '{') {
      const braces = this.#braces();
      if (!braces) return undefined;
      bounds = braces;
    }
    if (!bounds) return undefined;
    if (c !== '{') this.#pos += 1;
    this.#eat('?'); // lazy: the same answer for a yes/no match
    return bounds;
  }

  #braces(): { min: number; max: number | null } | undefined {
    const rest = this.#cps.slice(this.#pos, this.#pos + 12).map((cp) => String.fromCharCode(cp)).join('');
    const m = /^\{(\d{1,3})(?:(,)(\d{0,3}))?\}/.exec(rest);
    if (!m) return undefined;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === '' ? null : Number(m[3]);
    if (min > MAX_REPEAT || (max !== null && max > MAX_REPEAT)) throw new PatternError(`a repeat count above ${MAX_REPEAT} is not supported`);
    if (max !== null && max < min) throw new PatternError('numbers out of order in {} quantifier');
    this.#pos += m[0].length;
    return { min, max };
  }

  #atom(): Node {
    const c = this.#next();
    switch (c) {
      case '(': return this.#group();
      case '[': return this.#charClass();
      case '.': return { kind: 'char', test: (cp) => !isLineTerminator(cp) };
      case '^': return { kind: 'assert', which: 'start' };
      case '$': return { kind: 'assert', which: 'end' };
      case '\\': return this.#escape();
      case '*': case '+': case '?': throw new PatternError(`nothing to repeat before '${c}'`);
      case '{': {
        this.#pos -= 1;
        if (this.#braces()) throw new PatternError("nothing to repeat before '{'");
        this.#pos += 1;
        return literal(c);
      }
      default: return literal(c);
    }
  }

  #group(): Node {
    if (this.#eat('?')) {
      if (this.#eat(':')) { /* non-capturing: the same as capturing here */ }
      else if (this.#eat('<')) {
        const c = this.#peek();
        if (c === '=' || c === '!') throw new PatternError('lookbehind (?<= and (?<! are not supported');
        while (!this.#eat('>')) this.#next();
      } else if (this.#peek() === '=' || this.#peek() === '!') {
        throw new PatternError('lookahead (?= and (?! are not supported');
      } else {
        throw new PatternError(`unsupported group '(?${this.#peek() ?? ''}'`);
      }
    }
    const inner = this.#alternation();
    if (!this.#eat(')')) throw new PatternError("missing ')'");
    return inner;
  }

  /** An escape outside a class. */
  #escape(): Node {
    const c = this.#next();
    if (c === 'b') return { kind: 'assert', which: 'word' };
    if (c === 'B') return { kind: 'assert', which: 'nonword' };
    const set = CLASS_ESCAPES[c];
    if (set) return { kind: 'char', test: set };
    return literalCp(this.#escapedCodePoint(c));
  }

  /** The code point an escape stands for, `c` being the character after the backslash. */
  #escapedCodePoint(c: string): number {
    if (c in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[c];
    if (c === 'x') return this.#hex(2);
    if (c === 'u') return this.#hex(4);
    if (/^[0-9A-Za-z]$/.test(c)) throw new PatternError(`unsupported escape '\\${c}' (backreferences and \\p are not supported)`);
    return c.charCodeAt(0);
  }

  #hex(digits: number): number {
    const text = this.#cps.slice(this.#pos, this.#pos + digits).map((cp) => String.fromCharCode(cp)).join('');
    if (text.length !== digits || !/^[0-9a-fA-F]+$/.test(text)) throw new PatternError(`'\\${digits === 2 ? 'x' : 'u'}' needs ${digits} hex digits`);
    this.#pos += digits;
    return parseInt(text, 16);
  }

  #charClass(): Node {
    const negate = this.#eat('^');
    const tests: CharTest[] = [];
    let pendingRange: number | undefined; // the low end of "a-" seen so far
    let previous: number | undefined; // the last single code point, a candidate low end
    for (;;) {
      const c = this.#next();
      if (c === ']') break;
      let single: number | undefined;
      let set: CharTest | undefined;
      if (c === '\\') {
        const e = this.#next();
        if (e in CLASS_ESCAPES) set = CLASS_ESCAPES[e];
        else if (e === 'b') single = 0x08;
        else single = this.#escapedCodePoint(e);
      } else if (c === '-' && previous !== undefined && pendingRange === undefined && this.#peek() !== ']') {
        pendingRange = previous;
        tests.pop();
        previous = undefined;
        continue;
      } else {
        single = c.charCodeAt(0);
      }
      if (pendingRange !== undefined) {
        if (single === undefined) throw new PatternError('a class escape cannot be the end of a range');
        const [lo, hi] = [pendingRange, single];
        if (hi < lo) throw new PatternError('range out of order in character class');
        tests.push((cp) => cp >= lo && cp <= hi);
        pendingRange = undefined;
        previous = undefined;
      } else if (set) {
        tests.push(set);
        previous = undefined;
      } else {
        const cp = single!;
        tests.push((x) => x === cp);
        previous = cp;
      }
    }
    const anyOf: CharTest = (cp) => tests.some((t) => t(cp));
    return { kind: 'char', test: negate ? (cp) => !anyOf(cp) : anyOf };
  }
}

function literal(c: string): Node {
  return literalCp(c.charCodeAt(0));
}

function literalCp(cp: number): Node {
  return { kind: 'char', test: (x) => x === cp };
}

// ---------------------------------------------------------------------------------- compiling

class Compiler {
  readonly states: State[] = [];

  /** The one accepting state; the pattern is compiled to end at it. */
  matchState(): number {
    return this.#push({ op: 'match' });
  }

  #push(state: State): number {
    if (this.states.length >= MAX_STATES) throw new PatternError('pattern is too complex (nested repeat counts multiply)');
    this.states.push(state);
    return this.states.length - 1;
  }

  /** The state that matches `node` and then continues at `next`. */
  emit(node: Node, next: number): number {
    switch (node.kind) {
      case 'char': return this.#push({ op: 'char', test: node.test, out: next });
      case 'assert': return this.#push({ op: 'assert', which: node.which, out: next });
      case 'seq': {
        let start = next;
        for (let i = node.items.length - 1; i >= 0; i--) start = this.emit(node.items[i], start);
        return start;
      }
      case 'alt': {
        const starts = node.branches.map((b) => this.emit(b, next));
        let start = starts[starts.length - 1];
        for (let i = starts.length - 2; i >= 0; i--) start = this.#push({ op: 'split', out: starts[i], out1: start });
        return start;
      }
      case 'repeat': {
        let start = next;
        if (node.max === null) {
          // x*: a split that either enters x (which loops back to the split) or leaves.
          const loop = this.#push({ op: 'split', out: -1, out1: next });
          (this.states[loop] as { out: number }).out = this.emit(node.child, loop);
          start = loop;
        } else {
          // x{n,m}: the optional copies nest, (x(x(x)?)?)?, so each one is entered at most once.
          for (let i = node.min; i < node.max; i++) start = this.#push({ op: 'split', out: this.emit(node.child, start), out1: next });
        }
        for (let i = 0; i < node.min; i++) start = this.emit(node.child, start);
        return start;
      }
    }
  }
}

// --------------------------------------------------------------------------------- simulating

export interface CompiledPattern {
  /** Whether the pattern matches anywhere in `input`, as RegExp.prototype.test would say. */
  test(input: string): boolean;
}

class Nfa implements CompiledPattern {
  readonly #states: State[];
  readonly #start: number;

  constructor(states: State[], start: number) {
    this.#states = states;
    this.#start = start;
  }

  test(input: string): boolean {
    const cps = Array.from({ length: input.length }, (_, i) => input.charCodeAt(i));
    const n = cps.length;
    const states = this.#states;
    // The position a state was last added at, so each state is in a list at most once per
    // position. That is what bounds the work: an epsilon cycle ((a*)*) is walked once, not forever.
    const seenAt = new Int32Array(states.length).fill(-1);
    const stack: number[] = [];

    // Adds `first` and everything reachable from it without consuming input to `list`, checking
    // assertions at position `pos`. Returns true when the match state is reached.
    const add = (list: number[], first: number, pos: number): boolean => {
      stack.push(first);
      while (stack.length) {
        const index = stack.pop()!;
        if (seenAt[index] === pos) continue;
        seenAt[index] = pos;
        const state = states[index];
        switch (state.op) {
          case 'match': stack.length = 0; return true;
          case 'char': list.push(index); break;
          case 'split': stack.push(state.out1, state.out); break;
          case 'assert': if (holds(state.which, cps, pos)) stack.push(state.out); break;
        }
      }
      return false;
    };

    let current: number[] = [];
    for (let pos = 0; pos <= n; pos++) {
      // The search is unanchored: the pattern may begin at any position. A leading ^ is an
      // assertion that only holds at 0.
      if (add(current, this.#start, pos)) return true;
      if (pos === n) break;
      const next: number[] = [];
      const cp = cps[pos];
      for (const index of current) {
        const state = states[index] as { op: 'char'; test: CharTest; out: number };
        if (state.test(cp) && add(next, state.out, pos + 1)) return true;
      }
      current = next;
    }
    return false;
  }
}

function holds(which: Assertion, cps: number[], pos: number): boolean {
  switch (which) {
    case 'start': return pos === 0;
    case 'end': return pos === cps.length;
    case 'word': case 'nonword': {
      const before = pos > 0 && isWordChar(cps[pos - 1]);
      const after = pos < cps.length && isWordChar(cps[pos]);
      return (before !== after) === (which === 'word');
    }
  }
}

const cache = new Map<string, CompiledPattern>();
const CACHE_LIMIT = 200;

/**
 * Compiles a pattern, or throws PatternError with a message fit for a validation error. Compiled
 * patterns are cached, since the rule engine tests the same few patterns on every run.
 */
export function compilePattern(source: string): CompiledPattern {
  const cached = cache.get(source);
  if (cached) return cached;
  const ast = new Parser(source).parse();
  const compiler = new Compiler();
  const start = compiler.emit(ast, compiler.matchState());
  const compiled = new Nfa(compiler.states, start);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(source, compiled);
  return compiled;
}

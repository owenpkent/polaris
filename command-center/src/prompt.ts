// Asking for a secret on the command line. At a terminal the typing is not shown. When stdin is a
// pipe (a script, a test) one line is read from it per question, so nothing ever has to go on a
// command line, where other processes and the shell history can see it.
//
// One reader for the whole process. Piped answers often arrive in one chunk ("passphrase\npassphrase\n"
// for a question asked twice), and a reader that is closed after the first answer drops the rest,
// so lines are kept in a queue until a question wants them.
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';

let reader: Interface | undefined;
let muted = false;
let ended = false;
const lines: string[] = [];
const waiting: { resolve: (line: string) => void; reject: (e: Error) => void }[] = [];

function start(): Interface {
  if (reader) return reader;
  const tty = Boolean(process.stdin.isTTY);
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  reader = createInterface({ input: process.stdin, output, terminal: tty });
  reader.on('line', (line) => {
    const next = waiting.shift();
    if (next) next.resolve(line); else lines.push(line);
  });
  reader.on('close', () => {
    ended = true;
    for (const w of waiting.splice(0)) w.reject(new Error('No answer was given.'));
  });
  return reader;
}

export function readSecret(question: string): Promise<string> {
  const rl = start();
  const tty = Boolean(process.stdin.isTTY);
  process.stderr.write(question);
  // The question itself is shown. Everything typed after it is not.
  muted = tty;
  process.stdin.resume();
  const finish = (line: string) => {
    muted = false;
    if (tty) process.stderr.write('\n');
    // Let the process end when nothing else is waiting on the terminal. readline keeps its own
    // listeners, so pausing the input is what releases the event loop.
    if (!lines.length) { rl.pause(); process.stdin.pause(); }
    return line;
  };
  const queued = lines.shift();
  if (queued !== undefined) return Promise.resolve(finish(queued));
  if (ended) { muted = false; return Promise.reject(new Error('No answer was given.')); }
  return new Promise<string>((resolve, reject) => {
    waiting.push({ resolve: (line) => resolve(finish(line)), reject: (e) => { muted = false; reject(e); } });
  });
}

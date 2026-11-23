// `npm test` reporter: prints only failing tests (with their error) and one
// summary line, so a passing run costs a few bytes. `npm run test:verbose`
// shows every test.
import { inspect } from 'node:util';

export default async function* quiet(source) {
  let pass = 0, fail = 0, skip = 0;
  for await (const { type, data } of source) {
    if (type === 'test:pass' && data.details?.type !== 'suite') { if (data.skip || data.todo) skip++; else pass++; }
    if (type === 'test:fail' && data.details?.type !== 'suite') {
      fail++;
      const err = data.details?.error;
      const msg = err?.cause ? inspect(err.cause, { depth: 3 }) : String(err?.message ?? err);
      yield `FAIL ${data.file ? `${data.file.split(/[\\/]/).pop()} › ` : ''}${data.name}\n  ${msg.split('\n').slice(0, 12).join('\n  ')}\n`;
    }
    if (type === 'test:stderr' || (type === 'test:diagnostic' && data.level === 'error')) yield data.message;
  }
  yield `${fail ? 'FAILED' : 'ok'}: ${pass} passed, ${fail} failed, ${skip} skipped\n`;
}

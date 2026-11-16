// Local test runner: compares parse() against the kit's practice set and
// times parse() against vendored marked (cold single pass).
import { readFileSync } from 'node:fs';
import { parse } from './parse.js';
import { marked } from '/home/hatch/workspace/makefun/markdown-render-speed-02-kit-r4/markdown-render-speed-02-kit/program/generator/vendor/marked/marked.esm.js';

const KIT = '/home/hatch/workspace/makefun/markdown-render-speed-02-kit-r4/markdown-render-speed-02-kit';
const cases = JSON.parse(readFileSync(KIT + '/practice/input/cases.json', 'utf8'));
const expected = JSON.parse(readFileSync(KIT + '/practice/reference/expected.json', 'utf8'));
const expectedById = new Map(expected.cases.map((c) => [c.id, c]));

const only = process.argv[2] || null; // optional group prefix filter, e.g. "cm-" or "doc-09"
let matched = 0;
let total = 0;
const perGroup = new Map();
const firstDiff = new Map();

for (const c of cases) {
  if (only && !c.id.startsWith(only)) continue;
  total++;
  const want = expectedById.get(c.id);
  let got;
  try {
    got = parse(c.markdown);
  } catch (err) {
    got = 'THREW: ' + err.message;
  }
  const group = want.group;
  if (!perGroup.has(group)) perGroup.set(group, { ok: 0, n: 0 });
  const g = perGroup.get(group);
  g.n++;
  if (got === want.html) {
    matched++;
    g.ok++;
  } else if (!firstDiff.has(group)) {
    let at = 0;
    const a = String(got);
    const b = want.html;
    while (at < a.length && at < b.length && a[at] === b[at]) at++;
    firstDiff.set(group, {
      id: c.id,
      at,
      got: a.slice(Math.max(0, at - 60), at + 120),
      want: b.slice(Math.max(0, at - 60), at + 120),
      input: c.markdown.slice(0, 400),
    });
  }
}

console.log(`MATCH ${matched}/${total}`);
for (const [group, g] of [...perGroup.entries()].sort()) {
  const flag = g.ok === g.n ? '  ' : '!!';
  console.log(`${flag} ${group}: ${g.ok}/${g.n}`);
}
for (const [group, d] of firstDiff) {
  console.log(`\n--- first diff in ${group} (${d.id}) at char ${d.at} ---`);
  console.log('input :', JSON.stringify(d.input));
  console.log('got   :', JSON.stringify(d.got));
  console.log('want  :', JSON.stringify(d.want));
}

// Cold single-pass timing over the whole practice set.
function timeIt(fn) {
  const t0 = process.hrtime.bigint();
  for (const c of cases) fn(c.markdown);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}
const mineMs = timeIt((md) => parse(md));
const markedMs = timeIt((md) => marked.parse(md));
console.log(`\ntiming (cold single pass, all ${cases.length} cases): parse.js ${mineMs.toFixed(1)}ms, marked ${markedMs.toFixed(1)}ms, ratio ${(markedMs / mineMs).toFixed(2)}x`);

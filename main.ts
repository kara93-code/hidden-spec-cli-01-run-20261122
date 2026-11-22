// mend: one patch tool for every AI edit format.
//
// Reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the
// lines each edit names at the first of three matching tiers, and writes
// every change or none at all. See SPEC.md for the full contract.
// Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line of standard output. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

type LineKind = 'c' | 'o' | 'n'; // context line, old-only line, new-only line
interface PLine {
  t: string;
  k: LineKind;
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one. */
interface FState {
  lines: string[];
  ends: boolean;
  br: string;
}

function splitFile(text: string): FState {
  if (text === '') return { lines: [], ends: false, br: '\n' };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, ends, br };
}

function joinFile(st: FState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.ends ? st.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Move {
  old: string;
  now: string;
}

type EditFn = (tree: Tree, moves: Move[]) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where `pat` occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `pat` occurs at least once at or after `from`, or -1. */
function firstTier(lines: string[], pat: string[], strict: boolean, from = 0): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(lines, pat, t, from).length > 0) return t;
  }
  return -1;
}

/**
 * The replacement lines for a chunk whose old lines O start at `pos`.
 * Context lines come from the file's own matched lines; at tier 2 every
 * other new line is re-indented from O's first line's indent to the file's.
 */
function buildNew(o: PLine[], n: PLine[], fileLines: string[], pos: number, tier: number): string[] {
  const oTexts = o.map((x) => x.t);
  const p = leadingWs(oTexts[0] ?? '');
  const f = leadingWs(fileLines[pos] ?? '');
  const oCtx: number[] = [];
  o.forEach((x, idx) => {
    if (x.k === 'c') oCtx.push(idx);
  });
  const out: string[] = [];
  let ci = 0;
  for (const ne of n) {
    if (ne.k === 'c') {
      out.push(fileLines[pos + oCtx[ci]!]!);
      ci++;
    } else {
      let t = ne.t;
      if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const st = splitFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(st));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  o: PLine[];
  n: PLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  ctxPlusEol: boolean;
  /** a `\` line follows the hunk's last `+` line */
  plusEol: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | null;
  renameNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path a `--- `/`+++ ` line names, or null for /dev/null. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/')) s = s.slice(2);
  else if (s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const head = lines[i]!;
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(head);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: PLine[] = [];
  const n: PLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l === '') {
      o.push({ t: '', k: 'c' });
      n.push({ t: '', k: 'c' });
      lastCtxPlus = idx;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push({ t, k: 'c' });
      n.push({ t, k: 'c' });
      lastCtxPlus = idx;
    } else if (l[0] === '-') {
      o.push({ t: l.slice(1), k: 'o' });
    } else if (l[0] === '+') {
      n.push({ t: l.slice(1), k: 'n' });
      lastCtxPlus = idx;
      lastPlus = idx;
    }
    // a `\` line refers to the body line before it; it carries no text.
  });
  const follows = (idx: number): boolean => idx >= 0 && body[idx + 1] !== undefined && body[idx + 1]![0] === '\\';
  return { hunk: { a, o, n, ctxPlusEol: follows(lastCtxPlus), plusEol: follows(lastPlus) }, next: j };
}

/** Apply one hunk to a file's state; `d` is the length drift of earlier hunks. */
function applyHunk(st: FState, h: Hunk, d: number, strict: boolean, path: string): { st: FState; d: number } {
  const oTexts = h.o.map((x) => x.t);
  if (oTexts.length === 0) {
    const at = Math.min(h.a + d, st.lines.length);
    const ins = h.n.map((x) => x.t);
    const lines = [...st.lines.slice(0, at), ...ins, ...st.lines.slice(at)];
    const ends = at === st.lines.length ? !h.ctxPlusEol : st.ends;
    return { st: { lines, ends, br: st.br }, d: d + ins.length };
  }
  const tier = firstTier(st.lines, oTexts, strict);
  if (tier < 0) throw new Fail('no-match', path);
  const occs = occurrences(st.lines, oTexts, tier);
  const target = h.a - 1 + d;
  let pos = occs[0]!;
  let best = Math.abs(pos - target);
  for (const q of occs) {
    const dd = Math.abs(q - target);
    if (dd < best) {
      best = dd;
      pos = q;
    }
  }
  const out = buildNew(h.o, h.n, st.lines, pos, tier);
  const lines = [...st.lines.slice(0, pos), ...out, ...st.lines.slice(pos + oTexts.length)];
  const ends = pos + oTexts.length === st.lines.length ? !h.ctxPlusEol : st.ends;
  return { st: { lines, ends, br: st.br }, d: d + (h.n.length - oTexts.length) };
}

function sectionEdit(s: Section, strict: boolean): EditFn {
  const oldP = s.pairOld !== undefined ? s.pairOld : (s.renameOld ?? s.diffOld);
  const newP = s.pairNew !== undefined ? s.pairNew : (s.renameNew ?? s.diffNew);
  const isCreate = (s.pairOld !== undefined && s.pairOld === null) || s.isCreate;
  const isDelete = (s.pairNew !== undefined && s.pairNew === null) || s.isDelete;
  return (tree, moves) => {
    if (isCreate) {
      const p = newP ?? '';
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const e of h.n) if (e.k === 'n') plus.push(e.t);
      let noEol = false;
      for (let i = s.hunks.length - 1; i >= 0; i--) {
        if (s.hunks[i]!.n.some((e) => e.k === 'n')) {
          noEol = s.hunks[i]!.plusEol;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldP ?? '';
    const np = newP ?? '';
    if (op !== np) {
      if (!safePath(op)) throw new Fail('unsafe', op);
      if (!safePath(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let st = splitFile(cur);
      let d = 0;
      for (const h of s.hunks) {
        const r = applyHunk(st, h, d, strict, op);
        st = r.st;
        d = r.d;
      }
      tree.now.set(op, null);
      tree.now.set(np, joinFile(st));
      moves.push({ old: op, now: np });
      return;
    }
    if (!safePath(op)) throw new Fail('unsafe', op);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    let st = splitFile(cur);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyHunk(st, h, d, strict, op);
      st = r.st;
      d = r.d;
    }
    tree.now.set(op, joinFile(st));
  };
}

function unifiedEdits(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let section: Section | null = null;
  const flush = (): void => {
    if (section !== null) edits.push(sectionEdit(section, strict));
    section = null;
  };
  const fresh = (): Section => ({
    diffOld: null,
    diffNew: null,
    pairOld: undefined,
    pairNew: undefined,
    renameOld: null,
    renameNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flush();
      section = fresh();
      section.diffOld = m[1]!;
      section.diffNew = m[2]!;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A `--- `/`+++ ` pair starts a new section, unless it is the header
      // pair of a section a `diff --git` line just opened (no pair yet, no
      // hunks yet): that pair names the same section's paths.
      const belongs = section !== null && section.hunks.length === 0 && section.pairOld === undefined;
      if (!belongs) {
        flush();
        section = fresh();
      }
      section!.pairOld = headerPath(l);
      section!.pairNew = headerPath(lines[i + 1]!);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (section === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i);
      section.hunks.push(r.hunk);
      i = r.next - 1;
      continue;
    }
    if (section !== null && section.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) section.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) section.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) section.isCreate = true;
      else if (l.startsWith('deleted file mode')) section.isDelete = true;
      else if (l.startsWith('+++ ')) section.pairNew = headerPath(l);
      // index, old/new mode, similarity, dissimilarity, Index: and any other
      // header line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored.
  }
  flush();
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  for (;;) {
    let j = -1;
    for (let k = prevEnd; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j < 0) break;
    let path: string | null = null;
    for (let k = j - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${j + 1}`);
    let eq = -1;
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${j + 1}`);
    const oldLines = lines.slice(j + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const st = splitFile(cur);
      const tier = firstTier(st.lines, oldLines, strict);
      if (tier < 0) throw new Fail('no-match', p);
      const occs = occurrences(st.lines, oldLines, tier);
      if (occs.length > 1) throw new Fail('ambiguous', p);
      const pos = occs[0]!;
      const o: PLine[] = oldLines.map((t) => ({ t, k: 'o' as LineKind }));
      const n: PLine[] = newLines.map((t) => ({ t, k: 'n' as LineKind }));
      const out = buildNew(o, n, st.lines, pos, tier);
      const next: FState = {
        lines: [...st.lines.slice(0, pos), ...out, ...st.lines.slice(pos + oldLines.length)],
        ends: st.ends,
        br: st.br,
      };
      tree.now.set(p, joinFile(next));
    });
    prevPath = path;
    prevEnd = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  o: PLine[];
  n: PLine[];
}

function v4aEdits(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  // Patch line number of body[bi]: first + 2 + bi (1-based).
  const body = lines.slice(first + 1, last);
  const lineNo = (bi: number): number => first + 2 + bi;
  const edits: EditFn[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = 0;
  while (i < body.length) {
    const l = body[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${lineNo(i)}`);
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const headLine = lineNo(i);
    const path = l.slice(l.indexOf(': ') + 2).trim();
    i++;
    const raw: { text: string; no: number }[] = [];
    while (i < body.length && !isSectionStart(body[i]!)) {
      raw.push({ text: body[i]!, no: lineNo(i) });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text[0] === '+') fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safePath(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      const p = path;
      edits.push((tree) => {
        if (!safePath(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // Update File.
    let moveTo: string | null = null;
    let rest = raw;
    if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
      moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
      rest = rest.slice(1);
    }
    const chunks: Chunk[] = [];
    let cur: Chunk | null = null;
    let firstChunk = true;
    const close = (): void => {
      if (cur !== null) chunks.push(cur);
      cur = null;
    };
    for (const r of rest) {
      const t = r.text;
      if (t.startsWith('@@')) {
        close();
        const anchor = t.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
        firstChunk = false;
      } else if (t === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${r.no}`);
        cur.eof = true;
        close();
        firstChunk = false;
      } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
        if (cur === null) {
          if (!firstChunk) throw new Exit2(`error: parse ${r.no}`);
          cur = { anchor: null, eof: false, o: [], n: [] };
          firstChunk = false;
        }
        if (t === '') {
          cur.o.push({ t: '', k: 'c' });
          cur.n.push({ t: '', k: 'c' });
        } else if (t[0] === ' ') {
          const x = t.slice(1);
          cur.o.push({ t: x, k: 'c' });
          cur.n.push({ t: x, k: 'c' });
        } else if (t[0] === '-') cur.o.push({ t: t.slice(1), k: 'o' });
        else cur.n.push({ t: t.slice(1), k: 'n' });
      } else {
        throw new Exit2(`error: parse ${r.no}`);
      }
    }
    close();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
    const p = path;
    const mt = moveTo;
    edits.push((tree, moves) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (mt !== null && !safePath(mt)) throw new Fail('unsafe', mt);
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
      let st = splitFile(curText);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          let found = -1;
          const max = strict ? 0 : 2;
          for (let t = 0; t <= max && found < 0; t++) {
            for (let k = cursor; k < st.lines.length; k++) {
              if (normLine(st.lines[k]!, t) === normLine(ch.anchor, t)) {
                found = k;
                break;
              }
            }
          }
          if (found < 0) throw new Fail('no-match', p);
          cursor = found + 1;
        }
        const oTexts = ch.o.map((x) => x.t);
        if (oTexts.length === 0) {
          const at = ch.eof ? st.lines.length : cursor;
          const ins = ch.n.map((x) => x.t);
          st = { lines: [...st.lines.slice(0, at), ...ins, ...st.lines.slice(at)], ends: st.ends, br: st.br };
          cursor = at + ins.length;
          continue;
        }
        const tier = firstTier(st.lines, oTexts, strict, cursor);
        if (tier < 0) throw new Fail('no-match', p);
        let occs = occurrences(st.lines, oTexts, tier, cursor);
        if (ch.eof) occs = occs.filter((q) => q + oTexts.length === st.lines.length);
        if (occs.length === 0) throw new Fail('no-match', p);
        const pos = occs[0]!;
        const out = buildNew(ch.o, ch.n, st.lines, pos, tier);
        st = {
          lines: [...st.lines.slice(0, pos), ...out, ...st.lines.slice(pos + oTexts.length)],
          ends: st.ends,
          br: st.br,
        };
        cursor = pos + out.length;
      }
      const done = joinFile(st);
      if (mt !== null) {
        tree.now.set(p, null);
        tree.now.set(mt, done);
        moves.push({ old: p, now: mt });
      } else {
        tree.now.set(p, done);
      }
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Driver (SPEC.md sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Move[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rMoves = moves.filter(
    (m) => tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.now) === null && tree.now.get(m.now) !== null,
  );
  const rOlds = new Set(rMoves.map((m) => m.old));
  const rNews = new Set(rMoves.map((m) => m.now));
  const rows: { key: string; text: string }[] = [];
  for (const m of rMoves) rows.push({ key: m.now, text: `R ${m.old} -> ${m.now}` });
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rOlds.has(p) || rNews.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

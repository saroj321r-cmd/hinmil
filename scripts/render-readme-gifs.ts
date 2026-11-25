// Renders the animated GIFs in images/ that the README shows, from the files
// of the example project (github.com/tureluren/hinmil-example), so that what
// a GIF shows is what you see when you clone that project.
//
//   npm run gifs                        — all scenes
//   npm run gifs -- highlighting        — one scene (highlighting | diagnostics)
//   npm run gifs -- --example <dir>     — the example project (default: ../hinmil-example)
//   npm run gifs -- --vscode <dir>      — VS Code's resources/app directory
//
// Nothing in a frame is drawn by hand:
//   - colours come from the real TextMate engine (vscode-textmate +
//     vscode-oniguruma), with VS Code's own JavaScript grammar and Dark+ theme
//     (read from the local VS Code installation) and HinMil's injection
//     grammar from syntaxes/;
//   - squiggles and hover text come from the HinMil language server itself
//     (dist/server.js, so run `npm run build` first): the script opens the
//     scene in the server over LSP, edits it as it is typed, and draws the
//     diagnostics and hovers the server sends back.
//
// Needs `rsvg-convert` (librsvg) and ImageMagick (`magick`) on the PATH, and
// the DejaVu Sans Mono font.

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import * as rpc from 'vscode-jsonrpc/node';

const ROOT = path.join(__dirname, '..');

// ─── Scenes ──────────────────────────────────────────────────────────────────

type Step =
  | { type: string; chunk?: number }               // type text at the cursor
  | { pause: number }                              // hold the frame (1/100 s)
  | { check: true }                                // wait for the server's diagnostics
  | { hoverOn: string }                            // mouse over the last occurrence of a text
  | { unhover: true }
  | { erase: number }                              // backspace n characters
  | { fix: [string, string] };                     // backspace to the last occurrence of a text, retype it fixed

interface Scene {
  name: string;
  out: string;
  source: string;                                  // file in the example project
  lines: number;                                   // visible editor lines
  typeFrom: number;                                // first line (1-based) that is typed; the rest is already there
  after: Step[];                                   // what happens once the file is typed
}

const SCENES: Scene[] = [
  {
    name: 'highlighting',
    out: 'images/highlighting.gif',
    source: 'src/cart.js',
    lines: 16,
    typeFrom: 1,
    after: [{ pause: 400 }],
  },
  {
    name: 'diagnostics',
    out: 'images/diagnostics.gif',
    source: 'src/shop.js',
    lines: 8,
    typeFrom: 6,
    after: [
      { check: true }, { pause: 60 },
      { hoverOn: '"3"' }, { pause: 350 },
      { unhover: true }, { pause: 30 },
      { fix: ['"3"', '3'] },
      { check: true }, { pause: 60 },
      { hoverOn: 'total =' }, { pause: 400 },
    ],
  },
];

/** The text already in the editor, and the steps that type the rest of the file. */
function sceneScript(scene: Scene, text: string): { initial: string; steps: Step[] } {
  const lines = text.replace(/\n+$/, '').split('\n');
  const before = lines.slice(0, scene.typeFrom - 1);
  const typed = lines.slice(scene.typeFrom - 1);
  const steps: Step[] = before.length ? [{ pause: 60 }] : [];
  typed.forEach((line, i) => {
    // Comments (where the annotations are) are typed slower than code.
    if (line !== '') steps.push({ type: line, chunk: line.trimStart().startsWith('//') ? 3 : 6 });
    if (i < typed.length - 1) {
      steps.push({ type: '\n' });
      if (typed[i + 1] === '' && line !== '') steps.push({ pause: 45 });
    }
  });
  return { initial: before.length ? before.join('\n') + '\n' : '', steps: [...steps, ...scene.after] };
}

// ─── Look (VS Code Dark+) ────────────────────────────────────────────────────

const FONT = 'DejaVu Sans Mono';
const FONT_SIZE = 15;
const CHAR_W = FONT_SIZE * 0.6021;                 // DejaVu Sans Mono advance
const LINE_H = 22;
const WIDTH = 706;
const TITLE_H = 38;
const TAB_H = 34;
const TOP = TITLE_H + TAB_H + 12;                  // first baseline area
const GUTTER = 60;                                 // x of column 1
const C = {
  window: '#1E1E1E', chrome: '#181818', tabBorder: '#0078D4', title: '#9D9D9D',
  lineNo: '#6E7681', lineNoActive: '#CCCCCC', cursor: '#AEAFAD', fg: '#D4D4D4',
  error: '#F14C4C', hoverBg: '#252526', hoverBorder: '#454545', muted: '#9D9D9D',
  jsIcon: '#CBCB41',
};

// ─── TextMate ────────────────────────────────────────────────────────────────

interface Token { text: string; color: string; italic: boolean; bold: boolean }

function findVsCode(arg: string | undefined): string {
  const candidates = [
    arg,
    process.env.VSCODE_APP,
    '/usr/share/code/resources/app',
    '/usr/lib/code/resources/app',
    '/opt/visual-studio-code/resources/app',
    '/usr/share/codium/resources/app',
    '/Applications/Visual Studio Code.app/Contents/Resources/app',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/resources/app'),
  ].filter((p): p is string => !!p);
  const found = candidates.find(p => fs.existsSync(path.join(p, 'extensions/javascript/syntaxes')));
  if (!found) throw new Error('VS Code not found; pass --vscode <path to resources/app>');
  return found;
}

/** A VS Code theme file with its `include` chain flattened (comments allowed). */
function loadTheme(file: string): vsctm.IRawTheme {
  const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const base = json.include ? loadTheme(path.join(path.dirname(file), json.include)).settings : [];
  return { settings: [...base, ...(json.tokenColors ?? [])] };
}

async function createTokenizer(vscode: string) {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer;
  await oniguruma.loadWASM(wasm);
  const grammars: Record<string, string> = {
    'source.js': path.join(vscode, 'extensions/javascript/syntaxes/JavaScript.tmLanguage.json'),
    'hm-injection.js': path.join(ROOT, 'syntaxes/hm-injection.tmLanguage.json'),
    'source.hm': path.join(ROOT, 'syntaxes/hm.tmLanguage.json'),
  };
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope: string) => grammars[scope]
      ? vsctm.parseRawGrammar(fs.readFileSync(grammars[scope], 'utf8'), grammars[scope])
      : null,
    getInjections: (scope: string) => (scope === 'source.js' ? ['hm-injection.js'] : undefined),
  });
  const theme = loadTheme(path.join(vscode, 'extensions/theme-defaults/themes/dark_plus.json'));
  registry.setTheme({ settings: [{ settings: { foreground: C.fg, background: C.window } }, ...theme.settings] });
  const colors = registry.getColorMap();
  const js = await registry.loadGrammar('source.js');
  const hm = await registry.loadGrammar('source.hm');
  if (!js || !hm) throw new Error('grammars failed to load');

  return (text: string, language: 'js' | 'hm'): Token[][] => {
    const grammar = language === 'js' ? js : hm;
    let state = vsctm.INITIAL;
    return text.split('\n').map(line => {
      const r = grammar.tokenizeLine2(line, state);
      state = r.ruleStack;
      const out: Token[] = [];
      for (let i = 0; i < r.tokens.length; i += 2) {
        const start = r.tokens[i];
        const end = i + 2 < r.tokens.length ? r.tokens[i + 2] : line.length;
        const meta = r.tokens[i + 1];
        const fontStyle = (meta & 0x7800) >>> 11;
        out.push({
          text: line.slice(start, end),
          color: colors[(meta & 0xFF8000) >>> 15] ?? C.fg,
          italic: (fontStyle & 1) !== 0,
          bold: (fontStyle & 2) !== 0,
        });
      }
      return out;
    });
  };
}

// ─── Language server ─────────────────────────────────────────────────────────

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface Diagnostic { range: Range; message: string; severity?: number; code?: number | string; source?: string }

async function startServer(file: string, text: string) {
  const server = path.join(ROOT, 'dist/server.js');
  if (!fs.existsSync(server)) throw new Error('dist/server.js is missing; run `npm run build` first');
  const proc = cp.spawn(process.execPath, [server, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(proc.stdout!), new rpc.StreamMessageWriter(proc.stdin!));
  const uri = 'file://' + file;
  let latest: Diagnostic[] | null = null;
  conn.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: Diagnostic[] }) => {
    if (p.uri === uri) latest = p.diagnostics;
  });
  conn.onRequest('workspace/configuration', (p: { items: unknown[] }) => p.items.map(() => null));
  conn.onRequest('client/registerCapability', () => null);
  conn.onRequest('window/workDoneProgress/create', () => null);
  conn.listen();
  const root = 'file://' + path.dirname(file);
  await conn.sendRequest('initialize', {
    processId: process.pid, rootUri: root, workspaceFolders: [{ uri: root, name: 'demo' }],
    capabilities: { workspace: { configuration: true } },
    initializationOptions: { typescriptLanguageFeatures: false },
  });
  conn.sendNotification('initialized', {});
  let version = 1;
  conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version, text } });

  return {
    /** Sends the text and waits for the diagnostics the server publishes for it. */
    async diagnostics(current: string): Promise<Diagnostic[]> {
      latest = null;
      conn.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: ++version }, contentChanges: [{ text: current }],
      });
      for (let i = 0; i < 200 && latest == null; i++) await new Promise(r => setTimeout(r, 50));
      if (latest == null) throw new Error('no diagnostics from the server');
      return latest;
    },
    async hover(line: number, character: number): Promise<string | null> {
      const h = await conn.sendRequest('textDocument/hover', { textDocument: { uri }, position: { line, character } }) as
        { contents: { value: string } | string } | null;
      if (!h) return null;
      return typeof h.contents === 'string' ? h.contents : h.contents.value;
    },
    async stop() {
      await conn.sendRequest('shutdown').catch(() => undefined);
      conn.sendNotification('exit').catch(() => undefined);
      await new Promise(r => { proc.once('exit', r); setTimeout(r, 2000); });
      conn.dispose();
      proc.kill();
    },
  };
}

// ─── Frames ──────────────────────────────────────────────────────────────────

interface Popup { line: number; col: number; diagnostics: Diagnostic[]; markdown: string | null }
interface State { text: string; diagnostics: Diagnostic[]; popup: Popup | null; mouse: [number, number] | null }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function textRow(tokens: Token[], x: number, y: number): string {
  let col = 0;
  let out = '';
  for (const t of tokens) {
    if (t.text.trim() !== '') {
      const style = (t.italic ? ' font-style="italic"' : '') + (t.bold ? ' font-weight="bold"' : '');
      out += `<text x="${(x + col * CHAR_W).toFixed(2)}" y="${y}" fill="${t.color}"${style}>${esc(t.text)}</text>`;
    }
    col += t.text.length;
  }
  return out;
}

function squiggle(x1: number, x2: number, y: number): string {
  let d = `M${x1.toFixed(1)} ${y}`;
  for (let x = x1, up = true; x < x2; x += 2, up = !up) d += ` L${Math.min(x + 2, x2).toFixed(1)} ${up ? y - 2 : y}`;
  return `<path d="${d}" fill="none" stroke="${C.error}" stroke-width="1.2"/>`;
}

/** Splits markdown hover text into plain lines and ```hm code lines. */
function hoverRows(markdown: string, tokenize: (t: string, l: 'js' | 'hm') => Token[][]): Token[][] {
  const rows: Token[][] = [];
  const parts = markdown.split(/```(\w*)\n([\s\S]*?)```/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      for (const line of parts[i].split('\n').map(s => s.trim()).filter(Boolean)) {
        rows.push([{ text: line, color: C.fg, italic: false, bold: false }]);
      }
    } else if (i % 3 === 2) {
      rows.push(...tokenize(parts[i].replace(/\n$/, ''), parts[i - 1] === 'hm' ? 'hm' : 'js'));
    }
  }
  return rows;
}

function renderFrame(scene: Scene, state: State, tokenize: (t: string, l: 'js' | 'hm') => Token[][]): string {
  const height = TOP + scene.lines * LINE_H + 18;
  const lines = state.text.split('\n');
  const cursorLine = lines.length - 1;
  const cursorCol = lines[cursorLine].length;
  const rows = tokenize(state.text, 'js');
  const baseline = (i: number) => TOP + i * LINE_H + 5;
  const colX = (col: number) => GUTTER + col * CHAR_W;
  const parts: string[] = [];

  parts.push(`<rect width="${WIDTH}" height="${height}" rx="10" fill="${C.window}"/>`);
  parts.push(`<path d="M0 10 a10 10 0 0 1 10 -10 H${WIDTH - 10} a10 10 0 0 1 10 10 V${TITLE_H + TAB_H} H0 Z" fill="${C.chrome}"/>`);
  ['#FE5F57', '#FEBC2E', '#28C840'].forEach((c, i) =>
    parts.push(`<circle cx="${20 + i * 20}" cy="${TITLE_H / 2}" r="6" fill="${c}"/>`));
  parts.push(`<text x="${WIDTH / 2}" y="${TITLE_H / 2 + 4}" fill="${C.title}" font-family="DejaVu Sans" font-size="12" text-anchor="middle">${esc(path.basename(scene.source))} — HinMil</text>`);
  parts.push(`<rect x="0" y="${TITLE_H}" width="120" height="${TAB_H}" fill="${C.window}"/>`);
  parts.push(`<rect x="0" y="${TITLE_H}" width="120" height="2" fill="${C.tabBorder}"/>`);
  parts.push(`<text x="15" y="${TITLE_H + 22}" fill="${C.jsIcon}" font-family="DejaVu Sans" font-weight="bold" font-size="12">JS</text>`);
  parts.push(`<text x="40" y="${TITLE_H + 22}" fill="#FFFFFF" font-family="DejaVu Sans" font-size="13">${esc(path.basename(scene.source))}</text>`);

  for (let i = 0; i < scene.lines; i++) {
    const active = i === cursorLine;
    parts.push(`<text x="${GUTTER - 14}" y="${baseline(i)}" fill="${active ? C.lineNoActive : C.lineNo}" text-anchor="end">${i + 1}</text>`);
  }
  rows.forEach((tokens, i) => parts.push(textRow(tokens, GUTTER, baseline(i))));

  for (const d of state.diagnostics.filter(d => d.severity === 1 || d.severity === 2)) {
    for (let l = d.range.start.line; l <= d.range.end.line; l++) {
      const from = l === d.range.start.line ? d.range.start.character : 0;
      const to = Math.min(l === d.range.end.line ? d.range.end.character : Infinity, lines[l]?.length ?? 0);
      if (to <= from) continue;
      parts.push(squiggle(colX(from), colX(to), baseline(l) + 4));
    }
  }

  if (!state.popup) {
    parts.push(`<rect x="${colX(cursorCol).toFixed(1)}" y="${baseline(cursorLine) - 14}" width="2" height="19" fill="${C.cursor}"/>`);
  }

  if (state.popup) {
    const p = state.popup;
    const blocks: Token[][][] = [];
    for (const d of p.diagnostics) {
      const source = `${d.source ?? 'hinmil'}(${d.code ?? ''})`;
      blocks.push([[
        { text: d.message, color: C.fg, italic: false, bold: false },
        { text: '  ' + source, color: C.muted, italic: false, bold: false },
      ]]);
    }
    if (p.markdown) blocks.push(hoverRows(p.markdown, tokenize));
    const allRows = blocks.flat();
    const longest = Math.max(...allRows.map(r => r.reduce((n, t) => n + t.text.length, 0)));
    const padX = 9;
    const rowH = 20;
    const w = Math.ceil(longest * CHAR_W * (13 / FONT_SIZE) + padX * 2);
    const h = allRows.length * rowH + (blocks.length - 1) * 9 + 12;
    const x = Math.max(8, Math.min(colX(p.col) - 40, WIDTH - w - 8));
    const y = baseline(p.line) - 16 - h - 4;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${C.hoverBg}" stroke="${C.hoverBorder}"/>`);
    let rowY = y + 6 + 14;
    blocks.forEach((block, bi) => {
      if (bi > 0) {
        parts.push(`<line x1="${x + 1}" x2="${x + w - 1}" y1="${rowY - 14 - 4}" y2="${rowY - 14 - 4}" stroke="${C.hoverBorder}"/>`);
        rowY += 9;
      }
      for (const row of block) {
        parts.push(`<g font-size="13">${textRow(row, x + padX, rowY).replace(/x="([\d.]+)"/g, (_, v) =>
          `x="${(x + padX + (Number(v) - x - padX) * (13 / FONT_SIZE)).toFixed(2)}"`)}</g>`);
        rowY += rowH;
      }
    });
  }

  if (state.mouse) {
    const mx = colX(state.mouse[1]);
    const my = baseline(state.mouse[0]) - 6;
    parts.push(`<path d="M${mx} ${my} l0 16 l4 -4 l3 7 l2.5 -1 l-3 -7 l5.5 0 Z" fill="#FFFFFF" stroke="#000000" stroke-width="1"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`
    + `<g font-family="${FONT}" font-size="${FONT_SIZE}" xml:space="preserve">${parts.join('')}</g></svg>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function renderScene(scene: Scene, example: string, tokenize: (t: string, l: 'js' | 'hm') => Token[][]) {
  const { initial, steps } = sceneScript(scene, fs.readFileSync(path.join(example, scene.source), 'utf8'));
  // The server sees the scene inside a copy of the example's configuration.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `hinmil-gif-${scene.name}-`));
  const config = path.join(example, 'hinmil.config.json');
  if (fs.existsSync(config)) fs.copyFileSync(config, path.join(work, 'hinmil.config.json'));
  const file = path.join(work, scene.source);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, initial);
  const server = await startServer(file, initial);
  const state: State = { text: initial, diagnostics: [], popup: null, mouse: null };
  const frames: { svg: string; delay: number }[] = [];
  const emit = (delay: number) => {
    const svg = renderFrame(scene, state, tokenize);
    const last = frames[frames.length - 1];
    if (last && last.svg === svg) last.delay += delay;
    else frames.push({ svg, delay });
  };

  try {
    emit(4);
    const type = (text: string, chunk: number) => {
      for (let i = 0; i < text.length; i += chunk) {
        state.text += text.slice(i, i + chunk);
        // Typing makes the squiggles out of date; VS Code keeps them until the
        // server answers, which `check` models.
        emit(4);
      }
    };
    const erase = (n: number) => {
      for (let i = 0; i < n; i++) {
        state.text = state.text.slice(0, -1);
        emit(6);
      }
    };
    const lastOccurrence = (text: string) => {
      const at = state.text.lastIndexOf(text);
      if (at < 0) throw new Error(`${scene.name}: '${text}' is not in ${scene.source}`);
      return at;
    };
    for (const step of steps) {
      if ('fix' in step) {
        const [wrong, right] = step.fix;
        const at = lastOccurrence(wrong);
        const rest = state.text.slice(at + wrong.length);
        erase(state.text.length - at);
        if (frames.length) frames[frames.length - 1].delay += 20;
        type(right + rest, 1);
      } else if ('type' in step) {
        type(step.type, step.chunk ?? step.type.length);
      } else if ('erase' in step) {
        erase(step.erase);
      } else if ('pause' in step) {
        if (frames.length) frames[frames.length - 1].delay += step.pause;
      } else if ('check' in step) {
        state.diagnostics = await server.diagnostics(state.text);
        emit(4);
      } else if ('hoverOn' in step) {
        // The mouse rests on the middle of the text.
        const offset = lastOccurrence(step.hoverOn) + Math.floor(step.hoverOn.length / 2);
        const before = state.text.slice(0, offset).split('\n');
        const pos = { line: before.length - 1, character: before[before.length - 1].length };
        const at = (d: Diagnostic) => {
          const s = d.range.start, e = d.range.end;
          const after = pos.line > s.line || (pos.line === s.line && pos.character >= s.character);
          const before = pos.line < e.line || (pos.line === e.line && pos.character <= e.character);
          return after && before && (d.severity === 1 || d.severity === 2);
        };
        state.mouse = [pos.line, pos.character];
        emit(30);
        state.popup = {
          line: pos.line, col: pos.character,
          diagnostics: state.diagnostics.filter(at),
          markdown: await server.hover(pos.line, pos.character),
        };
        emit(4);
      } else if ('unhover' in step) {
        state.popup = null;
        state.mouse = null;
        emit(4);
      }
    }
  } finally {
    await server.stop();
  }

  const args: string[] = [];
  frames.forEach((f, i) => {
    const svg = path.join(work, `f${String(i).padStart(4, '0')}.svg`);
    const png = svg.replace(/\.svg$/, '.png');
    fs.writeFileSync(svg, f.svg);
    cp.execFileSync('rsvg-convert', ['-o', png, svg]);
    args.push('-delay', String(f.delay), png);
  });
  const out = path.join(ROOT, scene.out);
  cp.execFileSync('magick', ['-dispose', 'None', ...args, '-loop', '0', '-layers', 'OptimizePlus', out]);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`${scene.out}: ${frames.length} frames, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

async function main() {
  const argv = process.argv.slice(2);
  const vsIndex = argv.indexOf('--vscode');
  const vscode = findVsCode(vsIndex >= 0 ? argv[vsIndex + 1] : undefined);
  const exIndex = argv.indexOf('--example');
  const example = path.resolve(exIndex >= 0 ? argv[exIndex + 1] : path.join(ROOT, '..', 'hinmil-example'));
  if (!fs.existsSync(path.join(example, 'src'))) {
    throw new Error(`example project not found at ${example}; clone github.com/tureluren/hinmil-example next to this repository or pass --example <dir>`);
  }
  const names = argv.filter((a, i) => !a.startsWith('--') && !['--vscode', '--example'].includes(argv[i - 1]));
  const unknown = names.filter(n => !SCENES.some(s => s.name === n));
  if (unknown.length) throw new Error(`unknown scene: ${unknown.join(', ')} (have: ${SCENES.map(s => s.name).join(', ')})`);
  const tokenize = await createTokenizer(vscode);
  for (const scene of SCENES.filter(s => names.length === 0 || names.includes(s.name))) {
    await renderScene(scene, example, tokenize);
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });

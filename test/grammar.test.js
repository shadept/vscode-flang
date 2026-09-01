// Tokenizes snippets with the real TextMate engine and asserts the scope of a
// chosen substring. Guards the cases where one runaway pattern used to swallow
// the rest of the file.
const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const GRAMMAR = path.join(__dirname, '..', 'syntaxes', 'f.tmLanguage.json');
const WASM = path.join(
  path.dirname(require.resolve('vscode-oniguruma')),
  'onig.wasm'
);

let grammar;

test.before(async () => {
  await oniguruma.loadWASM(fs.readFileSync(WASM).buffer);
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (s) => new oniguruma.OnigScanner(s),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async () =>
      vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR, 'utf8'), GRAMMAR),
  });
  grammar = await registry.loadGrammar('source.f');
});

// Every token of `source`, as { text, scopes } with scopes joined into one string.
function tokenize(source) {
  const out = [];
  let stack = vsctm.INITIAL;
  for (const line of source.split('\n')) {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    for (const t of result.tokens) {
      out.push({
        text: line.substring(t.startIndex, t.endIndex),
        scopes: t.scopes.join(' '),
      });
    }
  }
  return out;
}

function scopesOf(source, text) {
  const hit = tokenize(source).find((t) => t.text === text);
  assert.ok(hit, `no token exactly matching ${JSON.stringify(text)}`);
  return hit.scopes;
}

test('owned marks a struct field as a modifier', () => {
  const src = 'type Buf = struct {\n    owned data: &u8\n}';
  assert.match(scopesOf(src, 'owned'), /storage\.modifier/);
  assert.match(scopesOf(src, 'data'), /variable\.property/);
});

test('move is a modifier in both param and expression position', () => {
  assert.match(scopesOf('fn take(b: move Buf) void {}', 'move'), /storage\.modifier/);
  assert.match(scopesOf('let x = move b', 'move'), /storage\.modifier/);
});

test('an interpolation hole is code, not string', () => {
  const src = 'print($"hello {name}")';
  assert.match(scopesOf(src, 'hello '), /string\.quoted\.double/);
  assert.doesNotMatch(scopesOf(src, 'name'), /string\.quoted/);
});

test('a string inside a hole does not terminate the interpolation', () => {
  const src = 'print($"q={msg.contains("foo")}")\nlet after = 1';
  assert.match(scopesOf(src, 'foo'), /string\.quoted\.double/);
  assert.match(scopesOf(src, 'let'), /storage\.type/);
});

test('a char literal holding a quote does not run away', () => {
  const src = 'print($"quote={q == \'"\'}")\nlet after = 1';
  assert.match(scopesOf(src, 'let'), /storage\.type/);
});

test('doubled braces are an escape, not a hole', () => {
  const src = 'print($"brace {{ literal }} here")';
  assert.match(scopesOf(src, '{{'), /constant\.character\.escape/);
  assert.match(scopesOf(src, ' literal '), /string\.quoted\.double/);
});

test('builder prefixes carry their own scopes', () => {
  assert.match(scopesOf('$sb"into {x} sb"', 'sb'), /variable\.other/);
  assert.match(scopesOf('$(64)"cap {x}"', '64'), /constant\.numeric/);
});

test('a format spec is verbatim', () => {
  assert.match(scopesOf('$"pad {n:04} done"', '04'), /constant\.other\.format/);
});

test('a generic type argument stops at a brace or quote', () => {
  const src = 'let e = Err(CtError { code = "E2118" })\nlet after = 1';
  assert.match(scopesOf(src, 'E2118'), /string\.quoted\.double/);
  assert.match(scopesOf(src, 'let'), /storage\.type/);
  assert.match(scopesOf('fn f() Result(A, B) {}', 'Result(A, B)'), /entity\.name\.type/);
});

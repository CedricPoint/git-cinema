'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {buildFilm, renderHtml, globToRegExp} = require('../git-cinema.js');

const S = '\x1e', F = '\x1f';

test('buildFilm encodes adds, edits, deletes and renames', () => {
  const raw = [
    `${S}100${F}Ann${F}ann@x.io\n\nA\tsrc/a.js\nA\tREADME.md\n`,
    `${S}200${F}Bob${F}bob@x.io\n\nM\tsrc/a.js\nR092\tsrc/a.js\tlib/a.js\n`,
    `${S}300${F}ANN${F}Ann@X.io\n\nD\tREADME.md\n`,
  ].join('');
  const f = buildFilm(raw);
  assert.deepEqual(f.paths, ['src/a.js', 'README.md', 'lib/a.js']);
  assert.deepEqual(f.authors, ['Ann', 'Bob']);         // same email, different case = same person
  assert.deepEqual(f.commits, [
    [100, 0, [0 * 4 + 0, 1 * 4 + 0]],
    [200, 1, [0 * 4 + 1, 0 * 4 + 2, 2 * 4 + 0]],
    [300, 0, [1 * 4 + 2]],
  ]);
});

test('buildFilm drops vendored paths and empty commits, can anonymize', () => {
  const raw = `${S}1${F}Ann${F}a@x\n\nA\tnode_modules/x/index.js\n${S}2${F}Bob${F}b@x\n\nA\tapp.js\nA\tdocs/a.md\n`;
  const f = buildFilm(raw, {exclude: ['docs/**'], anonymize: true});
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.paths, ['app.js']);
  assert.deepEqual(f.authors, ['Dev 1', 'Dev 2']);
});

test('buildFilm merges one person across emails and skips bots', () => {
  const raw = [
    `${S}1${F}Ann Lee${F}ann@work.io\n\nA\ta.js\n`,
    `${S}2${F}Ann Lee${F}ann@home.io\n\nM\ta.js\n`,
    `${S}3${F}dependabot[bot]${F}49699333+dependabot[bot]@users.noreply.github.com\n\nM\tpackage.json\n`,
    `${S}4${F}renovate${F}bot@renovateapp.com\n\nM\tpackage.json\n`,
  ].join('');
  const f = buildFilm(raw);
  assert.deepEqual(f.authors, ['Ann Lee']);
  assert.equal(f.commits.length, 2);
  assert.equal(buildFilm(raw, {includeBots: true}).authors.length, 3);
});

test('renderHtml embeds data safely', () => {
  const html = renderHtml({paths: ['</script><img src=x onerror=alert(1)>.js'], authors: ['A'], commits: [[1, 0, [0]]]}, {repo: 'r', title: 'r'});
  assert.ok(!html.includes('</script><img'));
  const json = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).paths[0], '</script><img src=x onerror=alert(1)>.js');
});

test('globToRegExp', () => {
  assert.ok(globToRegExp('**/dist/**').test('packages/web/dist/app.js'));
  assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
  assert.ok(!globToRegExp('docs/*').test('docs/a/b.md'));
});

test('CLI renders a film from a real repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-cinema-'));
  const run = (args, env = {}) => execFileSync('git', args, {cwd: dir, env: {...process.env, ...env}, stdio: 'pipe'});
  run(['init', '-q', '-b', 'main']); run(['config', 'commit.gpgsign', 'false']);
  let t = 1700000000;
  const commit = (who, files) => {
    for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), {recursive: true}); fs.writeFileSync(path.join(dir, p), c); }
    run(['add', '-A']); t += 3600;
    run(['commit', '-q', '-m', 'x'], {GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@x.io`, GIT_COMMITTER_NAME: who,
      GIT_COMMITTER_EMAIL: `${who}@x.io`, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000`});
  };
  commit('ann', {'src/a.js': '1', 'src/b.js': '1'});
  commit('bob', {'src/a.js': '2', 'lib/c.ts': '1'});
  fs.mkdirSync(path.join(dir, 'pkg')); run(['mv', 'src/b.js', 'pkg/b.js']); commit('ann', {});
  const out = path.join(dir, 'film.html');
  const log = execFileSync(process.execPath, [path.join(__dirname, '..', 'git-cinema.js'), dir, '-o', out], {encoding: 'utf8'});
  assert.match(log, /3 commits, 2 contributors/);
  const html = fs.readFileSync(out, 'utf8');
  const data = JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.commits.length, 3);
  assert.ok(data.paths.includes('pkg/b.js'));
  assert.equal(data.repo, path.basename(dir));
  fs.rmSync(dir, {recursive: true, force: true});
});

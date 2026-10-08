#!/usr/bin/env node
'use strict';
// git-cinema — turn any git history into a film.
// Zero dependencies. Reads your repository (read-only) and writes one self-contained HTML file.

const {execFileSync, spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '1.0.0';

const HELP = `
git-cinema ${VERSION} — turn any git history into a film

Usage
  git-cinema [repo] [options]

Options
  -o, --out <file>      Output HTML file (default: <repo>-cinema.html)
  --since <when>        Only commits after this date, e.g. "2 years ago"
  --until <when>        Only commits before this date
  --max-commits <n>     Keep the most recent n commits (default: 30000)
  --title <text>        Title shown in the film (default: repository name)
  --exclude <glob>      Hide paths (repeatable), e.g. --exclude "docs/**"
  --anonymize           Replace author names with "Dev 1", "Dev 2", …
  --include-bots        Keep commits from bots (dependabot, renovate, …)
  --open                Open the film in your browser when done
  -h, --help            Show this help
  -v, --version         Show version

In the player
  space  play / pause      ← →  seek        + −  speed
  L      toggle labels     S    PNG snapshot   ● Record → 1080p video
`;

function fail(msg){ process.stderr.write(`git-cinema: ${msg}\n`); process.exit(1); }

function parseArgs(argv){
  const o = {repo: '.', out: null, since: null, until: null, maxCommits: 30000, title: null, exclude: [], anonymize: false, includeBots: false, open: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { const v = argv[++i]; if (v === undefined) fail(`Missing value for ${a}`); return v; };
    switch (a) {
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0); break;
      case '-v': case '--version': console.log(VERSION); process.exit(0); break;
      case '-o': case '--out': o.out = next(); break;
      case '--since': o.since = next(); break;
      case '--until': o.until = next(); break;
      case '--max-commits': o.maxCommits = Math.max(1, parseInt(next(), 10) || 30000); break;
      case '--title': o.title = next(); break;
      case '--exclude': o.exclude.push(next()); break;
      case '--anonymize': o.anonymize = true; break;
      case '--include-bots': o.includeBots = true; break;
      case '--open': o.open = true; break;
      default:
        if (a.startsWith('-')) fail(`Unknown option ${a} (see --help)`);
        o.repo = a;
    }
  }
  return o;
}

/* ---------------- paths ---------------- */

const DEFAULT_EXCLUDES = ['**/node_modules/**', '**/vendor/**', '**/bower_components/**', '**/.yarn/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**'];

function globToRegExp(glob){
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/* ---------------- git ---------------- */

function git(repo, args){
  try {
    return execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args],
      {encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    fail(msg.includes('not a git repository') ? `${path.resolve(repo)} is not a git repository` : msg);
  }
}

// Parses `git log --reverse --name-status` (oldest first) into compact film data.
// ops are encoded as pathIndex * 4 + kind, kind: 0 = added, 1 = modified, 2 = deleted.
const isBot = (name, email) => /\[bot\]/i.test(`${name} ${email}`)
  || /^(dependabot|renovate|greenkeeper|github-actions|snyk-bot|semantic-release-bot|pre-commit-ci)\b/i.test(name);

function buildFilm(raw, {exclude = [], anonymize = false, includeBots = false} = {}){
  const rx = [...DEFAULT_EXCLUDES, ...exclude].map(globToRegExp);
  const keep = p => !rx.some(r => r.test(p));
  const paths = [], pathIdx = new Map(), authors = [], byEmail = new Map(), byName = new Map();
  const pi = p => { let i = pathIdx.get(p); if (i === undefined) { i = paths.length; paths.push(p); pathIdx.set(p, i); } return i; };
  const commits = [];
  for (const rec of raw.split('\x1e')) {
    if (!rec.trim()) continue;
    const lines = rec.split('\n');
    const [ts, name = '', email = ''] = lines[0].split('\x1f');
    if (!includeBots && isBot(name, email)) continue;
    // same person, several emails (or several spellings of one email): merge by email OR name
    const ek = email.toLowerCase(), nk = name.trim().toLowerCase();
    let ai = byEmail.get(ek) ?? byName.get(nk);
    if (ai === undefined) { ai = authors.length; authors.push(anonymize ? `Dev ${ai + 1}` : (name || 'unknown')); }
    if (ek) byEmail.set(ek, ai);
    if (nk) byName.set(nk, ai);
    const ops = [];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i]; if (!l) continue;
      const parts = l.split('\t'), st = parts[0][0];
      if (st === 'R' && parts.length >= 3) {         // rename = old file leaves, new file arrives
        if (keep(parts[1])) ops.push(pi(parts[1]) * 4 + 2);
        if (keep(parts[2])) ops.push(pi(parts[2]) * 4 + 0);
      } else if (st === 'C' && parts.length >= 3) {
        if (keep(parts[2])) ops.push(pi(parts[2]) * 4 + 0);
      } else if (parts.length >= 2 && keep(parts[1])) {
        ops.push(pi(parts[1]) * 4 + (st === 'A' ? 0 : st === 'D' ? 2 : 1));
      }
    }
    if (ops.length) commits.push([+ts, ai, ops]);
  }
  return {paths, authors, commits};
}

function renderHtml(film, meta){
  const template = fs.readFileSync(path.join(__dirname, 'player.html'), 'utf8');
  const json = JSON.stringify({...meta, ...film}).replace(/</g, '\\u003c');
  return template.replace('/*__GIT_CINEMA_DATA__*/', () => json);
}

function openFile(file){
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
  try { spawn(cmd, args, {stdio: 'ignore', detached: true}).unref(); } catch { /* best effort */ }
}

/* ---------------- main ---------------- */

function main(){
  const o = parseArgs(process.argv.slice(2));
  const root = git(o.repo, ['rev-parse', '--show-toplevel']).trim();
  const repo = path.basename(root);
  const args = ['log', '--reverse', '--no-merges', '--name-status', '-M', `--max-count=${o.maxCommits}`, '--format=%x1e%at%x1f%aN%x1f%aE'];
  if (o.since) args.push(`--since=${o.since}`);
  if (o.until) args.push(`--until=${o.until}`);
  const t0 = Date.now();
  const film = buildFilm(git(root, args), o);
  if (!film.commits.length) fail('no commits found (check --since / --until / --exclude)');
  const out = o.out || `${repo}-cinema.html`;
  fs.writeFileSync(out, renderHtml(film, {repo, title: o.title || repo, generatedAt: new Date().toISOString(), version: VERSION}));
  const size = fs.statSync(out).size;
  const first = new Date(film.commits[0][0] * 1000).getFullYear(), last = new Date(film.commits[film.commits.length - 1][0] * 1000).getFullYear();
  process.stdout.write(`\n  🎬 ${repo}: ${film.commits.length.toLocaleString('en')} commits, ${film.authors.length} contributors, ` +
    `${film.paths.length.toLocaleString('en')} files, ${first}→${last}\n  → ${out} (${(size / 1024 / 1024).toFixed(1)} MB, ${Date.now() - t0} ms)\n\n`);
  if (o.open) openFile(path.resolve(out));
}

if (require.main === module) main();
module.exports = {buildFilm, renderHtml, globToRegExp};

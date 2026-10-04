import fs from 'node:fs';
import path from 'node:path';

const rootArg = process.argv[2] || 'dist/无名AI';
const root = path.resolve(rootArg);

function fail(message) {
  console.error('[release-package-audit] ERROR:', message);
  process.exitCode = 1;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function existsAsModule(candidate) {
  const tries = [
    candidate,
    candidate + '.js',
    candidate + '.mjs',
    candidate + '.json',
    path.join(candidate, 'index.js'),
    path.join(candidate, 'index.mjs'),
  ];
  return tries.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || null;
}

function isAllowedHostDependency(spec) {
  return /^(?:\.\.\/)+noname\.js(?:[?#].*)?$/.test(spec);
}

function collectRelativeSpecifiers(source) {
  const specs = [];
  const patterns = [
    /^\s*import\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /^\s*export\s+[^'"\n]*?\s+from\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source)) !== null) {
      if (match[1] && match[1].startsWith('.')) specs.push(match[1]);
    }
  }
  return [...new Set(specs)];
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  fail('Package root does not exist: ' + root);
  process.exit(1);
}

const required = [
  'extension.js',
  'info.json',
  'js/config/changelog.js',
  'logs/今日修改日志.js',
  'logs/WORK_TRAIL.js',
];

for (const rel of required) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    fail('Required runtime file missing: ' + rel);
  }
}

const files = walk(root);
const jsFiles = files.filter((f) => /\.(?:js|mjs)$/i.test(f));
let checkedImports = 0;
let externalHostImports = 0;
let missingImports = 0;

for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const specs = collectRelativeSpecifiers(source);

  for (const rawSpec of specs) {
    checkedImports++;
    const spec = rawSpec.split(/[?#]/, 1)[0];
    const candidate = path.resolve(path.dirname(file), spec);
    const relSource = path.relative(root, file).replaceAll(path.sep, '/');

    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      if (isAllowedHostDependency(rawSpec)) {
        externalHostImports++;
        continue;
      }
      missingImports++;
      fail(relSource + ' imports outside packaged extension: ' + rawSpec);
      continue;
    }

    if (!existsAsModule(candidate)) {
      missingImports++;
      const relTarget = path.relative(root, candidate).replaceAll(path.sep, '/');
      fail(relSource + ' -> missing relative dependency: ' + rawSpec + ' (resolved ' + relTarget + ')');
    }
  }
}

if (process.exitCode) {
  console.error('[release-package-audit] FAILED: ' + missingImports + ' broken relative imports.');
  process.exit(process.exitCode);
}

console.log(
  '[release-package-audit] OK: ' +
  files.length + ' files, ' +
  jsFiles.length + ' JS modules, ' +
  checkedImports + ' relative imports verified, ' +
  externalHostImports + ' allowed host imports.'
);

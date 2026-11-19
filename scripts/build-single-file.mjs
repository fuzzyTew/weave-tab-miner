// scripts/build-single-file.mjs — joins the page, its library modules, the VDF worker and the sample
// block into one HTML file that opens by double-click, with no web server.
// Run: node scripts/build-single-file.mjs   (writes dist/weave-tab-miner.html)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

class SingleFileBuilder {
  /**
   * Inlines ES modules by concatenation: each module's `import … from './x.js'` statements
   * are dropped and its `export` keywords removed, in dependency order, so one inline
   * <script type="module"> holds them all. This works because the modules share no
   * conflicting top-level names; a name clash would show up as a SyntaxError on load.
   * The order comes from following each entry point's imports (dependencies first), so a
   * new module is included by importing it, with no list to keep up to date.
   */
  static RANDOMX_BUNDLE = 'vendor/randomx-arweave/randomx-arweave.iife.js';

  static PAGE = 'apps/browser/index.html';
  static PAGE_SCRIPT = 'apps/browser/app.js';
  static VDF_WORKER = 'src/mining/workers/vdf-worker.js';
  static RANDOMX_WORKER = 'src/mining/workers/randomx-worker.js';
  static OUTPUT = 'dist/weave-tab-miner.html';

  /** `rootDirectory` is the repository root; every path above is relative to it. */
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  read(name) {
    return readFileSync(join(this.rootDirectory, name), 'utf8');
  }

  static withoutModuleSyntax(source) {
    return source
      .replace(/^import\s[\s\S]*?from\s+'\.{1,2}\/[^']+';[ \t]*\n/gm, '')
      .replace(/^export\s+(class|const|function|async function)\s/gm, '$1 ');
  }

  // "</script" inside inlined text would end the script element early.
  static safeForScriptElement(text) {
    return text.replace(/<\/script/gi, '<\\/script');
  }

  static IMPORT_PATTERN = /^import\s[\s\S]*?from\s+'(\.{1,2}\/[^']+)';/gm;

  /** Repository paths of `entries` and everything they import, each after what it imports. */
  dependencyOrder(entries) {
    const ordered = [];
    const visiting = new Set();
    const visit = (path) => {
      if (ordered.includes(path)) return;
      if (visiting.has(path)) throw new Error(`import cycle through ${path}; concatenation needs an acyclic order`);
      visiting.add(path);
      for (const [, specifier] of this.read(path).matchAll(SingleFileBuilder.IMPORT_PATTERN)) {
        visit(normalize(join(dirname(path), specifier)));
      }
      visiting.delete(path);
      ordered.push(path);
    };
    entries.forEach(visit);
    return ordered;
  }

  /** The entry points and all they import, as one script. */
  inlinedModules(entries) {
    return this.dependencyOrder(entries).map((name) => `// ---- ${name} ----\n${SingleFileBuilder.withoutModuleSyntax(this.read(name))}`).join('\n');
  }

  build() {
    const pageScript = SingleFileBuilder.safeForScriptElement(this.inlinedModules([SingleFileBuilder.PAGE_SCRIPT]));
    const workerScript = SingleFileBuilder.safeForScriptElement(this.inlinedModules([SingleFileBuilder.VDF_WORKER]));
    // The RandomX worker: the bundle (a classic script defining RandomxArweave), then the
    // library pieces it uses, then the worker body.
    const randomxWorkerScript = SingleFileBuilder.safeForScriptElement(
      `${this.read(SingleFileBuilder.RANDOMX_BUNDLE)}\n${this.inlinedModules([SingleFileBuilder.RANDOMX_WORKER])}`);
    const sampleBlock = SingleFileBuilder.safeForScriptElement(this.read('data/sample-block.json'));
    const permaweb = SingleFileBuilder.safeForScriptElement(this.read('data/permaweb.json'));
    const sources = SingleFileBuilder.safeForScriptElement(this.read('data/sources.json'));
    const publicKey = SingleFileBuilder.safeForScriptElement(this.read('data/public-key.json'));

    const pageBody = this.read(SingleFileBuilder.PAGE).replace(
      /<script type="module" src="\.\/app\.js"><\/script>/,
      [
        `<script type="application/json" id="sampleBlockData">${sampleBlock}</script>`,
        `<script type="application/json" id="permawebData">${permaweb}</script>`,
        `<script type="application/json" id="sourcesData">${sources}</script>`,
        `<script type="application/json" id="publicKeyData">${publicKey}</script>`,
        `<script type="text/plain" id="vdfWorkerSource">${workerScript}</script>`,
        `<script type="text/plain" id="randomxWorkerSource">${randomxWorkerScript}</script>`,
        `<script type="module">\n${pageScript}\n</script>`,
      ].join('\n'),
    );
    if (pageBody.includes('src="./app.js"')) throw new Error(`${SingleFileBuilder.PAGE} no longer has the expected app.js script tag`);

    // index.html is written for a host that adds the document skeleton; a standalone file needs its own.
    return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${pageBody}\n</body>\n</html>\n`;
  }

  run() {
    const outputPath = join(this.rootDirectory, SingleFileBuilder.OUTPUT);
    mkdirSync(dirname(outputPath), { recursive: true });
    const html = this.build();
    writeFileSync(outputPath, html);
    console.log(`wrote ${outputPath} (${(html.length / 1024).toFixed(0)} KiB)`);
  }
}

new SingleFileBuilder(join(dirname(fileURLToPath(import.meta.url)), '..')).run();

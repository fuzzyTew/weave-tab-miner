// test/library-layers.test.mjs — the library's layers (docs/ARCHITECTURE.md "Current shape"):
// every import inside src/ points down the list, and no module imports itself around a
// cycle. Run: node test/library-layers.test.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TestCase } from './test-case.mjs';

class LibraryLayersTest extends TestCase {
  /** Top to bottom: a module may import from its own layer or any below it. */
  static LAYERS = ['storage', 'network', 'blocks', 'mining', 'wallet', 'core'];
  static SOURCE = new URL('../src/', import.meta.url).pathname;

  static modules(directory = LibraryLayersTest.SOURCE) {
    return readdirSync(directory).flatMap((name) => {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) return LibraryLayersTest.modules(full);
      return name.endsWith('.js') ? [full] : [];
    });
  }

  /** The src/ modules a module imports (relative imports only), as full paths. */
  static importsOf(modulePath) {
    const text = readFileSync(modulePath, 'utf8');
    return [...text.matchAll(/^\s*(?:import|export)\s[^'"]*from\s+['"](\.[^'"]+)['"]/gm)]
      .map((match) => path.resolve(path.dirname(modulePath), match[1]));
  }

  static layerOf(modulePath) {
    return path.relative(LibraryLayersTest.SOURCE, modulePath).split(path.sep)[0];
  }

  run() {
    const modules = LibraryLayersTest.modules().filter((modulePath) => LibraryLayersTest.LAYERS.includes(LibraryLayersTest.layerOf(modulePath)));
    const upward = [];
    const graph = new Map();
    for (const modulePath of modules) {
      const imports = LibraryLayersTest.importsOf(modulePath).filter((imported) => imported.startsWith(LibraryLayersTest.SOURCE));
      graph.set(modulePath, imports);
      const fromRank = LibraryLayersTest.LAYERS.indexOf(LibraryLayersTest.layerOf(modulePath));
      for (const imported of imports) {
        const toRank = LibraryLayersTest.LAYERS.indexOf(LibraryLayersTest.layerOf(imported));
        if (toRank !== -1 && toRank < fromRank) upward.push(`${path.relative(LibraryLayersTest.SOURCE, modulePath)} → ${path.relative(LibraryLayersTest.SOURCE, imported)}`);
      }
    }
    this.report('every import points down the layers', upward.length === 0, upward.join('; '));
    const cycle = LibraryLayersTest.findCycle(graph);
    this.report('no import cycles', cycle === null, cycle?.map((modulePath) => path.relative(LibraryLayersTest.SOURCE, modulePath)).join(' → '));
    this.finish();
  }

  /** A cycle in the import graph as a list of modules, or null (depth-first search). */
  static findCycle(graph) {
    const state = new Map(); // module -> 'open' while on the path, 'done' after
    const trail = [];
    const visit = (node) => {
      if (state.get(node) === 'done') return null;
      if (state.get(node) === 'open') return [...trail.slice(trail.indexOf(node)), node];
      state.set(node, 'open');
      trail.push(node);
      for (const next of graph.get(node) ?? []) {
        const found = visit(next);
        if (found) return found;
      }
      trail.pop();
      state.set(node, 'done');
      return null;
    };
    for (const node of graph.keys()) {
      const found = visit(node);
      if (found) return found;
    }
    return null;
  }
}

new LibraryLayersTest().run();

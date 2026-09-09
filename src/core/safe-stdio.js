const { Console } = require('console');
const { Writable } = require('stream');

/**
 * SafeWriter — a real stream.Writable that delegates writes to an inner
 * stream while swallowing errors that must never crash CLI output paths
 * (EPIPE, destroyed streams, TypeErrors).
 *
 * Node >= 24's Console requires stdout/stderr to be genuine Writable
 * streams: a plain object (even with write/on/emit methods) passes the
 * constructor but every write is silently dropped. Extending Writable is
 * therefore mandatory, not cosmetic.
 *
 * Error policy: `_write` never calls `callback(err)` — all failures are
 * consumed (with one retry for transient errors), so no 'error' event ever
 * escapes and CLI output can never take the process down. The inner stream
 * additionally gets a no-op 'error' listener so an async EPIPE on the real
 * process.stdout/stderr cannot become an uncaught 'error'.
 */
class SafeWriter extends Writable {
  constructor(inner) {
    super();
    this._inner = inner;
    inner.on('error', () => {});
  }

  _write(chunk, encoding, callback) {
    try {
      this._inner.write(chunk, encoding);
    } catch (err) {
      const benign = err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED' || err instanceof TypeError);
      if (!benign) {
        // One retry for transient failures; still never propagate.
        try {
          this._inner.write(chunk, encoding);
        } catch (retryErr) {
          // Intentional no-log swallow: any console.debug inside this catch would go
          // through the safe Console back into this same SafeWriter._write, recursing
          // into the identical failure path (self-trap). CLI output failures must be
          // consumed silently — there is no logging channel available here.
        }
      }
    }
    callback();
  }

  end(...args) {
    try {
      return this._inner.end(...args);
    } catch {
      return this;
    }
  }

  get columns() { return this._inner.columns; }
  get rows() { return this._inner.rows; }
  get isTTY() { return this._inner.isTTY; }

  getColorDepth(...args) {
    return typeof this._inner.getColorDepth === 'function' ? this._inner.getColorDepth(...args) : 1;
  }

  hasColors(...args) {
    return typeof this._inner.hasColors === 'function' ? this._inner.hasColors(...args) : false;
  }
}

/**
 * Console method names to rebind. Explicit list (rather than Object.keys of
 * the ambient console) because some environments — e.g. jest's BufferedConsole —
 * define these on the prototype, where Object.keys() cannot see them.
 */
const CONSOLE_METHODS = [
  'log', 'info', 'debug', 'warn', 'error', 'dir', 'time', 'timeEnd', 'timeLog',
  'trace', 'assert', 'clear', 'count', 'countReset', 'group', 'groupEnd',
  'table', 'dirxml', 'groupCollapsed', 'profile', 'profileEnd', 'timeStamp',
  'context', 'createTask', 'Console',
];

let _installed = false;
let _originalConsoleMethods = null;

/**
 * Wrap process.stdout/stderr in SafeWriter and route the global console
 * through a Console that writes via those wrappers.
 *
 * `options.stdout` / `options.stderr` allow injecting the inner streams
 * (used by tests — Node >= 16 exposes process.stdout as a getter-only
 * accessor, so process.stdout cannot be reassigned to inject a mock).
 */
function installSafeStdio(options = {}) {
  if (_installed) return;

  const safeStdout = new SafeWriter(options.stdout || process.stdout);
  const safeStderr = new SafeWriter(options.stderr || process.stderr);

  // Node >= 16 ignores these assignments (stdout/stderr are getter-only);
  // kept for older Node versions where reassignment is honored.
  process.stdout = safeStdout;
  process.stderr = safeStderr;

  safeStdout.on('error', () => {});
  safeStderr.on('error', () => {});

  const originalConsole = console;
  const safeConsole = new Console({
    stdout: safeStdout,
    stderr: safeStderr,
    colorMode: originalConsole.level !== undefined ? originalConsole.level : undefined,
  });

  // Snapshot the ambient methods BEFORE overwriting — `originalConsole` is the
  // very object `console` points at, so reading it after the rebind would
  // yield the safeConsole methods instead of the originals.
  _originalConsoleMethods = new Map();
  for (const key of CONSOLE_METHODS) {
    if (typeof safeConsole[key] === 'function' && typeof originalConsole[key] === 'function') {
      _originalConsoleMethods.set(key, originalConsole[key]);
      console[key] = safeConsole[key].bind(safeConsole);
    }
  }

  _installed = true;
}

function uninstallSafeStdio() {
  if (!_installed) return;

  if (process.stdout instanceof SafeWriter) {
    process.stdout = process.stdout._inner;
  }
  if (process.stderr instanceof SafeWriter) {
    process.stderr = process.stderr._inner;
  }

  if (_originalConsoleMethods) {
    for (const [key, fn] of _originalConsoleMethods) {
      console[key] = fn;
    }
    _originalConsoleMethods = null;
  }

  _installed = false;
}

module.exports = { SafeWriter, installSafeStdio, uninstallSafeStdio };

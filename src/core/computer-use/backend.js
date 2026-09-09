const { EventEmitter } = require('events');

class ComputerUseBackend extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this._activePid = null;
    this._activeWindowTitle = null;
  }

  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  async shutdown() {
    this._activePid = null;
    this._activeWindowTitle = null;
  }

  // eslint-disable-next-line no-unused-vars
  async capture(mode = 'som', app = null) {
    throw new Error('capture() must be implemented by subclass');
  }

  async click(_params) {
    throw new Error('click() must be implemented by subclass');
  }

  async typeText(_text) {
    throw new Error('typeText() must be implemented by subclass');
  }

  async key(_keys) {
    throw new Error('key() must be implemented by subclass');
  }

  async scroll(_params) {
    throw new Error('scroll() must be implemented by subclass');
  }

  async drag(_params) {
    throw new Error('drag() must be implemented by subclass');
  }

  async listApps() {
    throw new Error('listApps() must be implemented by subclass');
  }

  async focusApp(_appName) {
    throw new Error('focusApp() must be implemented by subclass');
  }

  async wait(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }
}

class CaptureResult {
  constructor({ screenshot, elements, axTree, mode, width, height }) {
    this.screenshot = screenshot || null;
    this.elements = elements || [];
    this.axTree = axTree || null;
    this.mode = mode || 'som';
    this.width = width || 0;
    this.height = height || 0;
  }

  toContent() {
    const parts = [];

    if (this.screenshot) {
      parts.push({
        type: 'image_url',
        image_url: { url: this.screenshot },
      });
    }

    if (this.mode === 'som' && this.elements.length > 0) {
      const elementList = this.elements.map((el, i) =>
        `[${i}] ${el.role || 'element'}: ${el.name || el.text || ''} (${el.x || 0},${el.y || 0})`
      ).join('\n');
      parts.push({
        type: 'text',
        text: `Screen elements:\n${elementList}`,
      });
    }

    if (this.mode === 'ax' && this.axTree) {
      parts.push({
        type: 'text',
        text: `Accessibility tree:\n${this.axTree}`,
      });
    }

    return parts;
  }
}

module.exports = { ComputerUseBackend, CaptureResult };

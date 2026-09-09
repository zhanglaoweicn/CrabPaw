/**
 * Focus Stack — depth-aware topic focus management
 *
 * tracks the user's deepening exploration into subtopics
 * within a thread. Each "push" descends one level; "pop" returns to the
 * parent topic and compresses the current frame into a memory note.
 *
 * This solves the "topic drift" problem by keeping the system aware of
 * how deep the conversation has gone into a particular branch.
 *
 * Stack frame:
 * { topic, context, depth, timestamp, metadata }
 *
 * Events emitted:
 * focus:pushed — { frame, stack }
 * focus:popped — { poppedFrame, compressedNote, parentFrame }
 * focus:cleared — { timestamp }
 * focus:overflow — { frame } — when push would exceed maxDepth
 */

const { EventEmitter } = require('events');

// ─── Constants ───

const MAX_DEPTH = 5;

// ─── FocusStack Class ───

class FocusStack extends EventEmitter {
 constructor(maxDepth = MAX_DEPTH) {
 super();
 /** @type {Array<{topic: string, context: string, depth: number, timestamp: number, metadata: object}>} */
 this._stack = [];
 this._maxDepth = maxDepth;
 }

 /**
 * Current stack depth (0 = no active focus)
 * @returns {number}
 */
 get depth() {
 return this._stack.length;
 }

 /**
 * Maximum allowed depth
 * @returns {number}
 */
 get maxDepth() {
 return this._maxDepth;
 }

 /**
 * Whether the stack has any frames
 * @returns {boolean}
 */
 get hasFocus() {
 return this._stack.length > 0;
 }

 /**
 * Push a new focus frame — user is deepening into a subtopic.
 *
 * @param {string} topic - subtopic name
 * @param {string} context - description of what the user is exploring
 * @param {object} [metadata] - optional extra data
 * @returns {{ success: boolean, frame: object|null, reason?: string }}
 */
 pushFrame(topic, context, metadata = {}) {
 if (!topic || typeof topic !== 'string') {
 return { success: false, frame: null, reason: 'topic is required' };
 }

 if (this._stack.length >= this._maxDepth) {
 this.emit('focus:overflow', { frame: { topic, context, metadata } });
 return {
 success: false,
 frame: null,
 reason: `max depth (${this._maxDepth}) reached`,
 };
 }

 const frame = {
 topic,
 context: context || '',
 depth: this._stack.length + 1,
 timestamp: Date.now(),
 metadata: { ...metadata },
 };

 this._stack.push(frame);
 this.emit('focus:pushed', {
 frame,
 stack: this._getStackSnapshot(),
 });

 return { success: true, frame };
 }

 /**
 * Pop the current focus frame — return to parent topic.
 * Compresses the popped frame into a memory note.
 *
 * @returns {{ success: boolean, poppedFrame: object|null, compressedNote: string|null, parentFrame: object|null }}
 */
 popFrame() {
 if (this._stack.length === 0) {
 return {
 success: false,
 poppedFrame: null,
 compressedNote: null,
 parentFrame: null,
 reason: 'stack is empty',
 };
 }

 const popped = this._stack.pop();
 const compressedNote = this._compressFrameToMemory(popped);

 // Capture parent before push (still in the stack)
 const parentFrame = this._stack.length > 0
 ? { ...this._stack[this._stack.length - 1] }
 : null;

 this.emit('focus:popped', {
 poppedFrame: popped,
 compressedNote,
 parentFrame,
 stack: this._getStackSnapshot(),
 });

 return {
 success: true,
 poppedFrame: popped,
 compressedNote,
 parentFrame,
 };
 }

 /**
 * Peek at the current focus frame without popping
 *
 * @returns {object|null}
 */
 peekFrame() {
 if (this._stack.length === 0) return null;
 return { ...this._stack[this._stack.length - 1] };
 }

 /**
 * Get the full focus path from root to current leaf.
 * Useful for prompt injection — shows the chain of deepening.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeContext=false] - include context strings
 * @returns {Array<{topic: string, depth: number, context?: string}>}
 */
 getFocusPath(options = {}) {
 return this._stack.map(frame => {
 const entry = {
 topic: frame.topic,
 depth: frame.depth,
 };
 if (options.includeContext) {
 entry.context = frame.context;
 }
 return entry;
 });
 }

 /**
 * Get focus path as a formatted string for prompt injection.
 * Example: "root > planning > architecture > database schema"
 *
 * @param {string} [separator=' > ']
 * @returns {string}
 */
 getFocusPathString(separator = ' > ') {
 return this._stack.map(f => f.topic).join(separator);
 }

 /**
 * Clear the entire focus stack
 */
 clear() {
 const before = this._stack.length;
 this._stack = [];
 this.emit('focus:cleared', {
 timestamp: Date.now(),
 clearedFrames: before,
 });
 }

 /**
 * Check if a given topic is in the current focus path
 *
 * @param {string} topic
 * @returns {boolean}
 */
 isInPath(topic) {
 return this._stack.some(f => f.topic.toLowerCase() === topic.toLowerCase());
 }

 /**
 * Restore a previously saved focus stack (e.g., from session persistence)
 *
 * @param {Array<{topic: string, context: string, depth: number, timestamp: number, metadata?: object}>} frames
 * @returns {boolean}
 */
 restore(frames) {
 if (!Array.isArray(frames)) return false;

 this._stack = frames
 .filter(f => f && f.topic)
 .slice(0, this._maxDepth)
 .map((f, i) => ({
 topic: f.topic,
 context: f.context || '',
 depth: i + 1,
 timestamp: f.timestamp || Date.now(),
 metadata: f.metadata || {},
 }));

 this.emit('focus:restored', {
 stack: this._getStackSnapshot(),
 count: this._stack.length,
 });

 return true;
 }

 /**
 * Get stack diagnostics
 *
 * @returns {object}
 */
 getDiagnostics() {
 return {
 depth: this.depth,
 maxDepth: this._maxDepth,
 hasFocus: this.hasFocus,
 currentFrame: this.peekFrame(),
 path: this.getFocusPath({ includeContext: true }),
 };
 }

 // ─── Internal ───

 /**
 * Compress a focus frame into a memory note
 *
 * @param {object} frame
 * @returns {string}
 */
 _compressFrameToMemory(frame) {
 const lines = [];
 lines.push(`[Focus: ${frame.topic}]`);
 if (frame.context) {
 lines.push(` Context: ${frame.context}`);
 }
 lines.push(` Depth: ${frame.depth}`);
 lines.push(` Explored: ${new Date(frame.timestamp).toISOString()}`);
 if (frame.metadata && Object.keys(frame.metadata).length > 0) {
 const metaStr = Object.entries(frame.metadata)
 .map(([k, v]) => ` ${k}: ${v}`)
 .join('\n');
 lines.push(` Metadata:\n${metaStr}`);
 }
 return lines.join('\n');
 }

 /**
 * Get a safe snapshot of the current stack
 * @returns {Array<{topic: string, depth: number}>}
 */
 _getStackSnapshot() {
 return this._stack.map(f => ({
 topic: f.topic,
 depth: f.depth,
 timestamp: f.timestamp,
 }));
 }
}

// ─── Global Singleton ───
const globalFocusStack = new FocusStack();

module.exports = {
 FocusStack,
 globalFocusStack,
 MAX_DEPTH,
};

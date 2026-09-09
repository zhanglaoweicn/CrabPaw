/**
 * Thread Classifier — classify a user message against existing threads
 *
 * determines whether a message continues, resumes,
 * references, or starts a new conversational thread, using keyword/pattern
 * matching (no LLM call).
 *
 * Classification types:
 * 'continuation' — pronouns, thread-specific keywords, or empty follow-ups
 * 'resume' — explicit mention of a thread's topic or summary
 * 'reference' — asks about something from a past thread without continuing it
 * 'new_topic' — completely new subject matter
 */

// ─── Constants ───

const CLASSIFICATION_TYPES = {
 CONTINUATION: 'continuation',
 RESUME: 'resume',
 REFERENCE: 'reference',
 NEW_TOPIC: 'new_topic',
};

// Continuation markers — pronouns and deictic expressions that signal
// the user is continuing the current thread
const CONTINUATION_MARKERS = [
 // Chinese pronouns / deictic
 '那个', '这个', '它', '它们', '他', '她', '他们', '她们',
 '这', '那', '这里', '那里', '这边', '那边',
 // Chinese continuation
 '继续', '然后', '接着', '下一步', '还有', '另外',
 '所以', '因此', '于是', '那么', '那', '结果',
 '再', '再讲', '再说', '再问', '再来',
 // English pronouns
 'it', 'he', 'she', 'they', 'this', 'that', 'these', 'those',
 'here', 'there',
 // English continuation
 'so', 'well', 'then', 'next', 'and then',
 'progress', 'continue', 'furthermore', 'moreover',
 'also', 'too', 'as well',
];

// Topic-switch markers — suggest user is starting a new topic
const NEW_TOPIC_MARKERS = [
 // Chinese
 '换个话题', '换一个', '不说这个了', '另外一件事',
 '问个问题', '我想知道', '话说', '对了', '顺便问一下',
 '有个事', '我有个问题', '换个思路',
 // English
 'by the way', 'btw', 'anyway', 'on another note',
 'speaking of', 'that reminds me', 'actually',
 'let me ask you', 'i have a question', 'new question',
 'moving on', 'on a different note',
];

// Reference patterns — regex that matches asking about past threads
const REFERENCE_PATTERNS = [
 // Chinese
 /(?:之前|刚才|刚才那个|上次|以前|前面).*?(?:说|聊|问|提到|讨论|讲的)/,
 /(?:还记得|还记得之前|记得前面).*(?:吗|么|不)/,
 /(?:你.*?之前.*?说|你.*?刚才.*?提到|你.*?前面.*?讲)/,
 /(?:回看|回顾|翻看|翻回去).*/,
 /(?:那个.*?(?:话题|问题|事情|项目)).*?(?:后来|现在|结果|怎么样了)/,
 // English
 /(?:earlier|before|previously|last time|you said|you mentioned|you talked about|you discussed)/i,
 /(?:remember when|recall|referring back|as you mentioned|as we discussed)/i,
 /(?:going back|looking back|thinking back|circling back)/i,
];

// Resume markers — explicit topic mention (uses thread keywords at runtime)
// These are handled dynamically in classifyMessage

// ─── Helpers ───

/**
 * Normalize message text for matching
 * @param {string} text
 * @returns {string}
 */
function _normalize(text) {
 return text.toLowerCase().trim();
}

/**
 * Check if a message contains any of the given markers
 * @param {string} text - normalized message text
 * @param {string[]} markers
 * @returns {boolean}
 */
function _hasAnyMarker(text, markers) {
 const lower = text.toLowerCase();
 for (const marker of markers) {
 if (lower.includes(marker.toLowerCase())) return true;
 }
 return false;
}

/**
 * Check if message matches any reference pattern
 * @param {string} text - raw message text
 * @returns {boolean}
 */
function _matchesReferencePattern(text) {
 for (const pattern of REFERENCE_PATTERNS) {
 if (pattern.test(text)) return true;
 }
 return false;
}

/**
 * Check if message explicitly mentions a thread's title or keywords
 * @param {string} text - normalized message text
 * @param {object} thread - thread object with title + keywords
 * @returns {boolean}
 */
function _mentionsThread(text, thread) {
 // Check if any keyword appears as a substring in the message
 for (const kw of thread.keywords) {
 if (kw.length >= 2 && text.includes(kw.toLowerCase())) return true;
 }

 // Check if any significant segment from the title appears in the message
 // For CJK text, break into 2-char sliding windows
 const title = thread.title ? thread.title.toLowerCase() : '';
 if (title.length >= 2) {
 // Generate 2-char sliding windows from title
 for (let i = 0; i <= title.length - 2; i++) {
 const segment = title.slice(i, i + 2);
 if (segment.length >= 2 && text.includes(segment)) return true;
 }
 }

 // Check if message contains any keyword's significant substrings
 // (handles case where user refers to a concept partially)
 for (const kw of thread.keywords) {
 if (kw.length >= 4) {
 for (let i = 0; i <= kw.length - 2; i++) {
 const segment = kw.slice(i, i + 2);
 if (segment.length >= 2 && text.includes(segment)) return true;
 }
 }
 }

 return false;
}

/**
 * Check if message is very short and ambiguous (likely continuation)
 * @param {string} text
 * @returns {boolean}
 */
function _isAmbiguousShort(text) {
 const stripped = text.replace(/[?？!！.。，,\s]/g, '').trim();
 return stripped.length <= 3 && stripped.length > 0;
}

// ─── Main classifier ───

/**
 * Classify a user message against the current set of threads.
 *
 * @param {string} messageText - the raw user message
 * @param {object[]} threads - array of thread objects (from ThreadManager)
 * @param {object} [options]
 * @param {string} [options.foregroundThreadId] - currently active thread id
 * @returns {{ type: string, threadId: string|null, confidence: number, reason: string }}
 */
function classifyMessage(messageText, threads = [], options = {}) {
 const text = _normalize(messageText);
 const raw = messageText.trim();
 const { foregroundThreadId } = options;

 // Get foreground thread if specified
 const foregroundThread = foregroundThreadId
 ? threads.find(t => t.id === foregroundThreadId)
 : null;

 // ── Empty / very short ──
 if (!raw || raw.length === 0) {
 return {
 type: CLASSIFICATION_TYPES.CONTINUATION,
 threadId: foregroundThreadId,
 confidence: 0.9,
 reason: 'empty message, continuing foreground thread',
 };
 }

 // ── Step 1: Check for explicit topic-switch markers first ──
 if (_hasAnyMarker(text, NEW_TOPIC_MARKERS)) {
 return {
 type: CLASSIFICATION_TYPES.NEW_TOPIC,
 threadId: null,
 confidence: 0.8,
 reason: 'topic-switch marker detected',
 };
 }

 // ── Step 2: Check for reference patterns ──
 if (_matchesReferencePattern(raw)) {
 // If it references AND also mentions a specific thread, it's a resume
 if (threads.length > 0) {
 for (const thread of threads) {
 if (_mentionsThread(text, thread)) {
 return {
 type: CLASSIFICATION_TYPES.RESUME,
 threadId: thread.id,
 confidence: 0.85,
 reason: `reference pattern + explicit thread mention: "${thread.title}"`,
 };
 }
 }
 }
 return {
 type: CLASSIFICATION_TYPES.REFERENCE,
 threadId: null,
 confidence: 0.7,
 reason: 'reference pattern detected, no specific thread matched',
 };
 }

 // ── Step 3: Check foreground thread continuation ──
 if (foregroundThread) {
 // Short ambiguous messages are continuations
 if (_isAmbiguousShort(text)) {
 return {
 type: CLASSIFICATION_TYPES.CONTINUATION,
 threadId: foregroundThread.id,
 confidence: 0.85,
 reason: 'short ambiguous message, continuing foreground thread',
 };
 }
 // Continuation markers
 if (_hasAnyMarker(text, CONTINUATION_MARKERS)) {
 return {
 type: CLASSIFICATION_TYPES.CONTINUATION,
 threadId: foregroundThread.id,
 confidence: 0.8,
 reason: 'continuation marker detected, foreground thread',
 };
 }
 }

 // ── Step 4: Check if message explicitly mentions any thread ──
 if (threads.length > 0) {
 // Sort by lastActive descending (most recent first)
 const sorted = [...threads].sort((a, b) => b.lastActive - a.lastActive);

 for (const thread of sorted) {
 if (_mentionsThread(text, thread)) {
 const isForeground = thread.id === foregroundThreadId;
 return {
 type: isForeground ? CLASSIFICATION_TYPES.CONTINUATION : CLASSIFICATION_TYPES.RESUME,
 threadId: thread.id,
 confidence: 0.75,
 reason: `explicit thread mention: "${thread.title}"`,
 };
 }
 }
 }

 // ── Step 5: If foreground thread exists and no new-topic markers, assume continuation ──
 if (foregroundThread) {
 return {
 type: CLASSIFICATION_TYPES.CONTINUATION,
 threadId: foregroundThread.id,
 confidence: 0.6,
 reason: 'no topic switch detected, defaulting to foreground continuation',
 };
 }

 // ── Fallback: nothing matched ──
 return {
 type: CLASSIFICATION_TYPES.NEW_TOPIC,
 threadId: null,
 confidence: 0.5,
 reason: 'no existing thread context, classified as new topic',
 };
}

module.exports = {
 classifyMessage,
 CLASSIFICATION_TYPES,
 // Expose internals for testing
 CONTINUATION_MARKERS,
 NEW_TOPIC_MARKERS,
 REFERENCE_PATTERNS,
};

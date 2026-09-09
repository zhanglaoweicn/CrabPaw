const path = require('path');
// 2026-08-31 Task1(数据目录统一): 硬编码 data/.crabpaw 改 config.DATA_DIR(env CRABPAW_DATA_DIR 可重定向, 默认路径逐字节不变)
const { DATA_DIR } = require('./config');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const MEMORY_FILE = path.join(MEMORY_DIR, 'MEMORY.md');
const DREAM_FILE = path.join(MEMORY_DIR, 'dream.json');

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'note'];

const MEMORY_SECTIONS = {
  USER_CONTEXT: 'user_context',
  CURRENT_FOCUS: 'current_focus',
  HISTORY: 'history',
  FACTS: 'facts',
};

const DEFAULT_SESSION_TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`;

const MEMORY_TYPE_DESCRIPTIONS = {
  user: {
    name: 'user',
    description: "Contain information about the user's role, goals, responsibilities, and knowledge",
    when_to_save: "When you learn any details about the user's role, preferences, responsibilities, or knowledge",
    how_to_use: "When your work should be informed by the user's profile or perspective"
  },
  feedback: {
    name: 'feedback',
    description: "Guidance the user has given you about how to approach work both what to avoid and what to keep doing",
    when_to_save: 'Any time the user corrects your approach OR confirms a non-obvious approach worked',
    how_to_use: "Let these memories guide your behavior so the user does not need to offer the same guidance twice"
  },
  project: {
    name: 'project',
    description: "Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project",
    when_to_save: 'When you learn who is doing what, why, or by when',
    how_to_use: "Use these memories to more fully understand the details and nuance behind the user's request"
  },
  reference: {
    name: 'reference',
    description: "Stores pointers to where information can be found in external systems",
    when_to_save: 'When you learn about resources in external systems and their purpose',
    how_to_use: "When the user references an external system or information that may be in an external system"
  },
  note: {
    name: 'note',
    description: "User-created notes and quick memos",
    when_to_save: 'When the user explicitly creates a note or memo',
    how_to_use: "When the user asks to recall their notes or memos"
  }
};

const WHAT_NOT_TO_SAVE = [
  '[unset — redacted original]',
  '[unset — redacted original]',
  '[unset — redacted original]',
  'Anything already documented in CLAUDE.md files.',
  'Ephemeral task details: in-progress work, temporary state, current conversation context.'
];

const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25000;
const MAX_SECTION_LENGTH = 2000;

const { SessionMemory } = require('./memory/session-memory');
const { AutoMemory } = require('./memory/auto-memory');
const { AutoDream } = require('./memory/auto-dream');
const { MemoryManager } = require('./memory/memory-manager');

const memoryManager = new MemoryManager();

module.exports = {
  SessionMemory,
  AutoMemory,
  AutoDream,
  MemoryManager,
  memoryManager,
  MEMORY_DIR, SESSIONS_DIR, MEMORY_FILE, DREAM_FILE,
  MEMORY_TYPES, MEMORY_SECTIONS, MEMORY_TYPE_DESCRIPTIONS,
  WHAT_NOT_TO_SAVE, DEFAULT_SESSION_TEMPLATE,
  MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES, MAX_SECTION_LENGTH,
};

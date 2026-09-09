// I-3 T1: Register interrupt eval suite in evals/index.js (CRLF-safe)
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '..', 'evals', 'index.js');
let content = fs.readFileSync(target, 'utf8');

// Insert require after echoHints
const requireAnchor = `const echoHints = require('./test-cases/echo-hints');`;
const requireInsertion = `const echoHints = require('./test-cases/echo-hints');
const interrupt = require('./test-cases/interrupt');`;

if (!content.includes("require('./test-cases/interrupt')")) {
  content = content.replace(requireAnchor, requireInsertion);
}

// Insert registerSuite after echoHints registration
const registerAnchor = `runner.registerSuite(echoHints);`;
const registerInsertion = `runner.registerSuite(echoHints);
  runner.registerSuite(interrupt);`;

if (!content.includes('runner.registerSuite(interrupt)')) {
  content = content.replace(registerAnchor, registerInsertion);
}

fs.writeFileSync(target, content, 'utf8');
console.log('OK: interrupt suite registered in evals/index.js');

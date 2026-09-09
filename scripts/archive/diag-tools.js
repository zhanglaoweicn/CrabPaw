const fs = require('fs');
const path = require('path');

function diagnose(filename) {
  const filePath = path.join(__dirname, '..', 'src', 'tools', filename);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  console.log(`\n=== ${filename} ===`);
  console.log(`Total lines: ${lines.length}`);
  
  // Find broken string patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check for unmatched quotes in expressions
    const singleQuotes = (line.match(/'/g) || []).length;
    const doubleQuotes = (line.match(/"/g) || []).length;
    const backticks = (line.match(/`/g) || []).length;
    
    // Unmatched quotes
    if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0) {
      console.log(`UNMATCHED QUOTES L${i+1} (':${singleQuotes} ",':${doubleQuotes} \`,':${backticks}): ${line.substring(0, 150)}`);
    }
    
    // Broken console.warn('); pattern
    if (line.includes("console.warn(')") || line.includes('console.log(")') || line.includes('console.error(")')) {
      console.log(`BROKEN CALL L${i+1}: ${line.substring(0, 150)}`);
    }
    
    // Empty single-quoted strings that might be broken 
    if (line.includes("''")) {
      console.log(`EMPTY STRING L${i+1}: ${line.substring(0, 150)}`);
    }
  }
  
  // Find all ? patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const qCount = (line.match(/\?/g) || []).length;
    if (qCount >= 3) {
      console.log(`GARBLED L${i+1} (${qCount} ?): ${line.substring(0, 120)}`);
    }
  }
}

diagnose('image-tools.js');
diagnose('video-tools.js');
fs.writeFileSync(path.join(__dirname, '..', 'src', 'tools', '_diag_complete'), 'ok');
console.log('\nDiagnostics complete.');

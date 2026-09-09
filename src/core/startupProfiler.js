const { performance } = require('perf_hooks');

const checkpoints = [];
let enabled = true;

function profileCheckpoint(name) {
  if (!enabled) return;
  
  const now = performance.now();
  const elapsed = checkpoints.length > 0 
    ? now - checkpoints[checkpoints.length - 1].time 
    : 0;
  
  checkpoints.push({ name, time: now, elapsed });
}

function getStartupProfile() {
  return {
    checkpoints: checkpoints.map(c => ({
      name: c.name,
      elapsed: c.elapsed.toFixed(2)
    })),
    totalTime: checkpoints.length > 0 
      ? (checkpoints[checkpoints.length - 1].time - checkpoints[0].time).toFixed(2)
      : '0'
  };
}

function enableProfiling() {
  enabled = true;
}

function disableProfiling() {
  enabled = false;
}

function printProfile() {
  if (checkpoints.length === 0) {
    console.log('No profiling data available');
    return;
  }
  
  console.log('\n📊 Startup Profile:');
  console.log('─'.repeat(50));
  
  for (let i = 0; i < checkpoints.length; i++) {
    const c = checkpoints[i];
    const indent = '  '.repeat(Math.min(i, 3));
    console.log(`${indent}├─ ${c.name}: +${c.elapsed.toFixed(2)}ms`);
  }
  
  const totalTime = checkpoints[checkpoints.length - 1].time - checkpoints[0].time;
  console.log('─'.repeat(50));
  console.log(`Total: ${totalTime.toFixed(2)}ms\n`);
}

module.exports = {
  profileCheckpoint,
  getStartupProfile,
  enableProfiling,
  disableProfiling,
  printProfile
};

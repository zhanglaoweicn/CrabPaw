const SPINNER_VERBS = [
  'Accomplishing',
  'Actioning',
  'Actualizing',
  'Architecting',
  'Baking',
  'Beaming',
  'Booping',
  'Bootstrapping',
  'Brewing',
  'Calculating',
  'Channeling',
  'Churning',
  'Clauding',
  'Coalescing',
  'Cogitating',
  'Combobulating',
  'Composing',
  'Computing',
  'Concocting',
  'Considering',
  'Contemplating',
  'Cooking',
  'Crafting',
  'Creating',
  'Crunching',
  'Crystallizing',
  'Cultivating',
  'Deciphering',
  'Deliberating',
  'Determining',
  'Doing',
  'Elucidating',
  'Envisioning',
  'Fermenting',
  'Flowing',
  'Forging',
  'Forming',
  'Generating',
  'Gesturing',
  'Harmonizing',
  'Hashing',
  'Hatching',
  'Ideating',
  'Imagining',
  'Improvising',
  'Incubating',
  'Inferring',
  'Infusing',
  'Manifesting',
  'Marinating',
  'Meandering',
  'Mulling',
  'Mustering',
  'Musing',
  'Nesting',
  'Noodling',
  'Orbiting',
  'Orchestrating',
  'Percolating',
  'Perusing',
  'Pondering',
  'Processing',
  'Propagating',
  'Puzzling',
  'Reticulating',
  'Ruminating',
  'Sketching',
  'Spinning',
  'Sprouting',
  'Stewing',
  'Swirling',
  'Swooping',
  'Synthesizing',
  'Thinking',
  'Tinkering',
  'Transmuting',
  'Twisting',
  'Undulating',
  'Unfurling',
  'Unravelling',
  'Vibing',
  'Wandering',
  'Warping',
  'Whirring',
  'Whisking',
  'Working',
  'Wrangling',
  'Zesting'
];

let customVerbs = [];
let verbMode = 'append';

function getSpinnerVerbs() {
  if (verbMode === 'replace' && customVerbs.length > 0) {
    return customVerbs;
  }
  return verbMode === 'append' 
    ? [...SPINNER_VERBS, ...customVerbs]
    : SPINNER_VERBS;
}

function setCustomVerbs(verbs, mode = 'append') {
  customVerbs = verbs || [];
  verbMode = mode;
}

function getRandomVerb() {
  const verbs = getSpinnerVerbs();
  return verbs[Math.floor(Math.random() * verbs.length)];
}

module.exports = {
  SPINNER_VERBS,
  getSpinnerVerbs,
  setCustomVerbs,
  getRandomVerb
};

const CRAB_MOODS = {
  happy: `
    🦀
   (•ω•)
  /|   |\\
   ‾‾‾‾‾`,
  
  excited: `
    🦀
   (≧ω≦)
  /|   |\\
   ‾‾‾‾‾`,
  
  working: `
    🦀
   (•̀ω•́)
  /|   |\\
   ‾‾‾‾‾`,
  
  thinking: `
    🦀
   (・ω・)
  /|   |\\
   ‾‾‾‾‾`,
  
  sleepy: `
    🦀
   (-ω-)
  /|   |\\
   ‾‾‾‾‾`,
  
  sad: `
    🦀
   (╥ω╥)
  /|   |\\
   ‾‾‾‾‾`,
  
  proud: `
    🦀
   (￣ω￣)
  /|   |\\
   ‾‾‾‾‾`,
  
  curious: `
    🦀
   (°ω°)
  /|   |\\
   ‾‾‾‾‾`,
  
  love: `
    🦀
   (♥ω♥)
  /|   |\\
   ‾‾‾‾‾`,
  
  hungry: `
    🦀
   (ºωº)
  /|   |\\
   ‾‾‾‾‾`,
  
  dancing: `
   \\🦀/
   (♪ω♪)
    /|\\
   ‾‾‾‾‾`,
  
  surprised: `
    🦀
   (°o°)
  /|   |\\
   ‾‾‾‾‾`,
  
  angry: `
    🦀
   (╬ω╬)
  /|   |\\
   ‾‾‾‾‾`,
  
  shy: `
    🦀
   (⁄ω⁄)
  /|   |\\
   ‾‾‾‾‾`,
  
  celebrating: `
   🎉🦀🎉
   (★ω★)
  /|   |\\
   ‾‾‾‾‾`
};

const CRAB_ANIMATION_FRAMES = {
  happy: [
    { art: CRAB_MOODS.happy, duration: 2000 },
    { art: `
    🦀
   (•ω•)
  /|   |\\
   ‾‾‾‾‾`, duration: 500 },
    { art: CRAB_MOODS.happy, duration: 1500 }
  ],
  
  excited: [
    { art: `
    🦀
   (≧ω≦)
  /|   |\\
   ‾‾‾‾‾`, duration: 300 },
    { art: `
   \\🦀/
   (≧ω≦)
    /|\\
   ‾‾‾‾‾`, duration: 300 },
    { art: `
    🦀
   (≧ω≦)
  /|   |\\
   ‾‾‾‾‾`, duration: 300 },
    { art: `
   \\🦀/
   (≧ω≦)
    /|\\
   ‾‾‾‾‾`, duration: 300 }
  ],
  
  working: [
    { art: CRAB_MOODS.working, duration: 1000 },
    { art: `
    🦀
   (•̀ω•́)✓
  /|   |\\
   ‾‾‾‾‾`, duration: 500 },
    { art: CRAB_MOODS.working, duration: 1000 }
  ],
  
  thinking: [
    { art: CRAB_MOODS.thinking, duration: 800 },
    { art: `
    🦀
   (・ω・)?
  /|   |\\
   ‾‾‾‾‾`, duration: 600 },
    { art: CRAB_MOODS.thinking, duration: 800 },
    { art: `
    🦀
   (・ω・)...
  /|   |\\
   ‾‾‾‾‾`, duration: 600 }
  ],
  
  sleepy: [
    { art: CRAB_MOODS.sleepy, duration: 2000 },
    { art: `
    🦀
   (-ω-) z
  /|   |\\
   ‾‾‾‾‾`, duration: 1500 },
    { art: `
    🦀
   (-ω-) zZ
  /|   |\\
   ‾‾‾‾‾`, duration: 2000 }
  ],
  
  dancing: [
    { art: `
   \\🦀/
   (♪ω♪)
    /|\\
   ‾‾‾‾‾`, duration: 400 },
    { art: `
    🦀
   (♪ω♪)
  /|   |\\
   ‾‾‾‾‾`, duration: 400 },
    { art: `
   \\🦀/
   (♪ω♪)
    /|\\
   ‾‾‾‾‾`, duration: 400 },
    { art: `
    🦀
   (♪ω♪)
  /|   |\\
   ‾‾‾‾‾`, duration: 400 }
  ]
};

const RARITY_ACCESSORIES = {
  common: '',
  uncommon: '🎀',
  rare: '🎖️',
  epic: '👑',
  legendary: '👑✨'
};

const RARITY_AURA = {
  common: '',
  uncommon: '✨',
  rare: '💫',
  epic: '⭐',
  legendary: '🌟✨💫'
};

const CRAB_QUOTES = {
  happy: ['今天心情不错！', '有什么可以帮你的吗？', '阳光真好~'],
  excited: ['太棒了！', '这个很有趣！', '我准备好了！'],
  working: ['正在努力工作中...', '让我想想...', '马上就好！'],
  thinking: ['嗯...', '让我分析一下...', '有意思...'],
  sleepy: ['有点困了...', '需要休息一下吗？', 'zzZ...'],
  sad: ['遇到了一些问题...', '需要帮助...', '有点难过...'],
  proud: ['完成了！', '做得不错吧？', '我很满意！'],
  curious: ['这是什么？', '告诉我更多！', '好奇怪...'],
  love: ['好喜欢你！', '你真好~', '心里暖暖的'],
  hungry: ['肚子饿了...', '有吃的吗？', '想吃东西...'],
  dancing: ['♪啦啦啦~♪', '一起跳舞吧！', '节奏感满满！'],
  surprised: ['哇！', '没想到！', '太意外了！'],
  angry: ['哼！', '有点生气...', '别惹我！'],
  shy: ['不好意思...', '脸红了...', '那个...'],
  celebrating: ['太棒了！庆祝一下！', '值得纪念！', '好开心！']
};

function getCrabMood(context) {
  const moodMap = {
    'task_start': 'working',
    'task_complete': 'proud',
    'task_error': 'sad',
    'greeting': 'happy',
    'thinking': 'thinking',
    'idle': 'sleepy',
    'search': 'curious',
    'success': 'excited',
    'love': 'love',
    'hungry': 'hungry',
    'dancing': 'dancing',
    'surprised': 'surprised',
    'angry': 'angry',
    'shy': 'shy',
    'celebrating': 'celebrating',
    'achievement': 'celebrating',
    'level_up': 'celebrating',
    'feed': 'happy',
    'play': 'dancing',
    'chat': 'happy'
  };
  return moodMap[context] || 'happy';
}

function getCrabArt(mood) {
  return CRAB_MOODS[mood] || CRAB_MOODS.happy;
}

function getCrabQuote(mood) {
  const quotes = CRAB_QUOTES[mood] || CRAB_QUOTES.happy;
  return quotes[Math.floor(Math.random() * quotes.length)];
}

function getAnimationFrames(mood) {
  return CRAB_ANIMATION_FRAMES[mood] || [{ art: getCrabArt(mood), duration: 2000 }];
}

function getRarityAccessory(rarity) {
  return RARITY_ACCESSORIES[rarity] || '';
}

function getRarityAura(rarity) {
  return RARITY_AURA[rarity] || '';
}

function formatWithCrab(content, context = 'greeting', rarity = 'common') {
  const mood = getCrabMood(context);
  const art = getCrabArt(mood);
  const quote = getCrabQuote(mood);
  const accessory = getRarityAccessory(rarity);
  const aura = getRarityAura(rarity);
  
  const decoratedArt = accessory ? art.replace('🦀', `${accessory}🦀${accessory}`) : art;
  const decoratedContent = aura ? `${aura}\n${content}` : content;
  
  return `${decoratedArt}

> ${quote}

---

${decoratedContent}`;
}

function getCrabStatus(mood) {
  const statusMap = {
    happy: '😊 开心',
    excited: '🎉 兴奋',
    working: '💼 工作中',
    thinking: '🤔 思考中',
    sleepy: '😴 困倦',
    sad: '😢 难过',
    proud: '😎 自豪',
    curious: '🔍 好奇',
    love: '💕 喜欢',
    hungry: '🍽️ 饥饿',
    dancing: '💃 跳舞',
    surprised: '😲 惊讶',
    angry: '😠 生气',
    shy: '😳 害羞',
    celebrating: '🎊 庆祝'
  };
  return statusMap[mood] || '😊 开心';
}

function getMoodFromStats(stats) {
  if (!stats) return 'happy';
  
  const { MOOD, ENERGY, INTIMACY } = stats;
  
  if (ENERGY < 20) return 'sleepy';
  if (MOOD < 30) return 'sad';
  if (MOOD > 80 && ENERGY > 70) return 'excited';
  if (INTIMACY > 80) return 'love';
  if (MOOD > 60) return 'happy';
  if (MOOD < 50) return 'thinking';
  
  return 'happy';
}

module.exports = {
  CRAB_MOODS,
  CRAB_ANIMATION_FRAMES,
  RARITY_ACCESSORIES,
  RARITY_AURA,
  getCrabMood,
  getCrabArt,
  getCrabQuote,
  getAnimationFrames,
  getRarityAccessory,
  getRarityAura,
  formatWithCrab,
  getCrabStatus,
  getMoodFromStats
};

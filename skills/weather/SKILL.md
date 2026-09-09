---
name: weather
description: "天气查询技能，基于wttr.in获取任意城市的实时天气与预报。当用户问「今天天气怎么样」「北京下雨吗」「明天几度」或出行前看天气时使用。"
arguments: ["city"]
argument-hint: "[城市名]"
metadata:
  crabpaw:
    category: general
    capabilities: [weather_query]
    priority: 2
    tags: [life, weather, info]
    emoji: ☔
---

# Weather

Get current weather and forecast for ${city} using wttr.in.

## Quick Start

```bash
# Simple format
curl wttr.in/${city}?format=3

# Full forecast
curl wttr.in/${city}

# JSON format
curl wttr.in/${city}?format=j1
```

## Usage Examples

### Current Weather (Simple)
```bash
curl wttr.in/${city}?format=3
# Output: ${city}: ⛅ +22°C
```

### Full Forecast
```bash
curl wttr.in/${city}
# Shows 3-day forecast with detailed information
```

### JSON Format (for parsing)
```bash
curl wttr.in/${city}?format=j1
# Returns JSON with detailed weather data
```

## Options

- `?format=3` - One-line format
- `?format=j1` - JSON format
- `?lang=zh` - Chinese language
- `?u` - US units (Fahrenheit)

## Notes

- No API key required
- Works worldwide
- Free to use
- Rate limit: reasonable use

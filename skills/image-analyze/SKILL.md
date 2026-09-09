---
name: image-analyze
version: 1.0.0
description: "图片分析，支持内容识别、中英文OCR文字提取、图像描述、EXIF读取、格式转换与批量处理。当用户给出一张图片问“这是什么”“图里文字是什么”，或需要截图OCR提取文字时使用。"
metadata:
  crabpaw:
    emoji: "🖼"
    category: media
    capabilities: [image_analysis]
    triggers: [image, picture, photo, ocr, screenshot, analyze_image]
    platforms: [linux, macos, windows]
---

# 🖼 图片分析

## 概述

全面的图片分析能力，帮助理解和使用图像内容。

## 核心能力

| 能力 | 说明 |
|------|------|
| **内容识别** | 识别图片中的物体、场景、人物、文字 |
| **OCR 提取** | 中英文文字识别，支持手写体和打印体 |
| **图像描述** | 生成图片的自然语言描述 |
| **EXIF 读取** | 读取照片的拍摄参数、GPS位置、时间等 |
| **格式转换** | PNG/JPEG/WebP/GIF/BMP之间的转换 |
| **批量处理** | 批量压缩、重命名、加水印 |

## 支持的格式

- 输入：PNG, JPEG, GIF, BMP, WebP, TIFF, SVG
- OCR输出：纯文本 / Markdown / JSON

## 使用方式

/image analyze <file-path>
/image ocr <file-path>
/image describe <file-path>
/image convert <file-path> --format webp
/image info <file-path>

## 注意事项

- OCR质量取决于图片清晰度和文字字体
- 大尺寸图片会自动压缩后处理
- 处理结果缓存在本地

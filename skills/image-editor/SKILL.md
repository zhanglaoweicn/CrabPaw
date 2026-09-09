---
name: image-editor
version: 1.0.0
description: "封面图/配图生成，按公众号2.35:1、小红书3:4、抖音9:16等平台尺寸裁剪，AI图片生成，批量加水印。当用户说“给文章做个封面”“生成配图/缩略图/海报”或需要裁剪尺寸时使用。"
metadata:
  crabpaw:
    emoji: "🎨"
    category: media
    capabilities: [image_analysis]
    triggers: [cover, thumbnail, banner, image_edit, resize, crop, watermark, poster]
    platforms: [linux, macos, windows]
    requires: [image_generate, bash]
---

# 🎨 封面图/配图生成

## 概述

一键生成适配各平台的封面图和配图，支持 AI 生成 + 尺寸裁剪 + 批量处理。

## 平台尺寸预设

| 平台 | 比例 | 推荐尺寸 | 用途 |
|------|------|---------|------|
| 公众号封面 | 2.35:1 | 900x383 | 图文封面（已裁剪为适合展示） |
| 公众号小图 | 1:1 | 200x200 | 列表小图 |
| 小红书 | 3:4 | 1080x1440 | 笔记封面 |
| 抖音 | 9:16 | 1080x1920 | 视频封面 |
| 知乎 | 16:9 | 1200x675 | 文章封面 |
| B站 | 16:9 | 1920x1080 | 视频封面 |
| 头条 | 16:9 | 1280x720 | 文章封面 |
| 微博 | 16:9 | 1200x675 | 微博配图 |

## 使用方式

/image cover "描述" --for wechat
批量：将图片适配到所有平台尺寸
AI 生成：根据描述词生成封面图
加水印：批量图片添加文字/图片水印

/image resize <file> --for xiaohongshu
单张图片按平台尺寸裁剪
支持智能主体识别，避免裁掉关键内容

/image batch --for all <directory>
批量将目录中图片生成各平台尺寸版本

## 依赖

- image_generate 工具（AI 图片生成）
- Bash 工具（ImageMagick/Sharp 进行裁剪转换）

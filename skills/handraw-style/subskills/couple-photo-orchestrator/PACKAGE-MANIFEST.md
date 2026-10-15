# PACKAGE MANIFEST — couple-photo-orchestrator 2.24.24

## Release type
完整工程包（full engineering package）

## Core engineering structure
- root orchestration docs and release metadata
- `skills/zongkong/`
- `skills/kefu/`
- `skills/huanzhuang/`
- `skills/paishe/`
- `skills/meihua/`
- `skills/makeup/`
- `skills/hairstyle/`
- scripts / templates / references / tests / archive assets

## 2.24.24 key addition
- Identity Lock v2 for real-person contact sheets
- high-priority global identity lock
- per-panel `PANEL IDENTITY RESET`
- facial geometry preservation contract
- Face Readability Gate for full-body / wide / back-turn / reflection shots
- detail/enlargement rendering cannot inherit the already-generated face from a contact-sheet cell
- canonical original remains face-only; hairstyle remains governed by locked `hairstyle_design`

## Package check
- Actual files before release build: **98**
- Cache directories and `.pyc` files: removed

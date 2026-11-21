# 庄园离线世界卡

本目录将上一级的 manor-world-card.json 构建为当前 SR 可导入的离线资源包。

## 交付内容

- manor-world.zip：用于 SR 世界卡导入。
- package/world.json：世界卡数据，状态结构已适配 schema_version 2。
- package/components/：拆分后的 TSX 组件，图片通过 SDK 解析本地资源地址。
- package/assets/images/：按原图内容 SHA-256 去重后的图片。
- build-report.json：本次构建的图片映射、文件哈希、实际数量、大小与完整性检查结果。
- download-manifest.json：下载进度与源地址清单。

ZIP 根目录只有 world.json、components/ 和 assets/，可以直接导入。

## 构建

运行环境需要 Python 3.11 或以上、curl，以及启用 WebP 支持的 Pillow。在项目根目录执行：

    python3 'world/worldcards/庄园/build.py' --workers 12

复用已下载原图、全程离线重新构建：

    python3 'world/worldcards/庄园/build.py' --offline

只下载并校验原图：

    python3 'world/worldcards/庄园/build.py' --download-only

原始图片缓存位于用户目录下的 Library/Caches/SillyRealms/manor-world-card；可以用 --cache 指定其他位置。脚本复用已经完整下载并通过校验的文件，失败项会写入下载清单，重新执行即可重试。

## 图片与兼容处理

原卡包含 18 个角色条目、8 个开局、47 个世界书条目；其中 17 个图鉴角色共引用 722 个不同图片地址。本次 722 个链接均下载成功，按文件内容去重后为 719 张图片。最终 ZIP 为 132,072,078 字节（约 125.95 MiB），包含 15 个组件、735 个文件；详细映射与哈希见 build-report.json。

默认使用 WebP quality=90、method=4 有损编码，保留原始像素尺寸、透明通道以及存在的 ICC/EXIF 数据。原始图片缓存保留。需要其他质量可传 --quality；--lossless 使用无损 WebP，但最终仍需满足当前 256 MiB 的 ZIP 导入上限。

prepare_card.py 在副本中补齐当前状态结构需要的 rules，并增加 AssetImage 组件解析 sr-asset:// 地址。角色、叙事、世界书、开局和状态初值保持原卡内容。

构建会检查全部下载结果、每张图片的格式及像素尺寸、包内资源引用、外链残留、ZIP CRC 和导入体积限制。最终导入器及组件验证由同目录 validate.ts 执行：

    pnpm --dir apps/server exec tsx ../../world/worldcards/庄园/validate.ts

验证使用独立临时目录，结束后清理，不连接现有数据库。最近一次验证结果见 validation-report.json。

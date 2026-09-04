# 字幕工坊

字幕工坊是一款完全在本机运行的视频、音频字幕生成与校对工具。应用通过本地 Node.js 服务调用 FFmpeg 和 whisper.cpp，媒体文件、识别结果和编辑内容不会上传到云端，也不需要 API Key。

## 主要功能

- 导入 MP4、MOV、MKV、WebM、MP3、WAV、FLAC 等常见媒体文件
- 使用本地 Whisper 模型识别中文、英语、日语、韩语等语言
- 自动发现并切换 `models/` 目录中的多个模型
- 提供快速、均衡和高精度三种识别质量
- 输入人名、品牌和专业术语作为识别提示
- 在视频画面上实时预览编辑后的字幕
- 播放时自动高亮并滚动到对应的字幕条目
- 点击字幕序号跳转到对应时间播放
- 修改字幕文字、开始时间和结束时间
- 在时间轴开头、中间或末尾插入、删除字幕条目
- 使用按钮或键盘方向键按毫秒、按帧快退和快进
- 自动检测视频帧率，也可以手动设置 FPS 和单次移动帧数
- 导出修改后的 SRT 或 WebVTT 字幕

## 技术结构

| 组件 | 用途 |
| --- | --- |
| React + TypeScript + Vite | 本地网页界面和字幕编辑器 |
| Fastify | 本地 HTTP 服务、任务状态和文件处理 |
| FFmpeg | 从视频中提取 16 kHz 单声道音频 |
| whisper.cpp | 在本机执行语音识别 |
| Silero VAD | 可选的实验性静音过滤 |

服务默认只监听 `127.0.0.1`。浏览器与后端之间的文件传输也只发生在当前电脑上。

## 环境要求

- Node.js 20.12 或更高版本
- npm
- Git
- CMake
- FFmpeg
- 建议至少保留 4 GB 可用磁盘空间；大型模型需要更多内存

## 快速开始

克隆仓库并安装网页依赖：

```bash
git clone https://github.com/ExBugggggg/subtitle_generate.git
cd subtitle_generate
npm install
```

### macOS

使用 Homebrew 安装系统依赖：

```bash
brew install ffmpeg cmake
```

编译 whisper.cpp，并下载推荐的 `large-v3-turbo` 模型及可选 VAD 模型：

```bash
npm run setup:model
```

启动开发环境：

```bash
npm run dev
```

浏览器打开 <http://127.0.0.1:5173>。

### Linux

先使用系统包管理器安装 Git、CMake 和 FFmpeg。以 Ubuntu/Debian 为例：

```bash
sudo apt update
sudo apt install git cmake build-essential ffmpeg
npm install
npm run setup:model
npm run dev
```

### Windows

1. 安装 Node.js 20、Git for Windows、CMake 和 FFmpeg。
2. 安装时将 Git、CMake 和 FFmpeg 加入 `PATH`。
3. 使用 Git Bash 进入项目目录并执行：

```bash
npm install
npm run setup:model
npm run dev
```

如果程序没有找到 Windows 编译出的 whisper.cpp，请复制配置文件：

```powershell
Copy-Item .env.example .env
```

然后根据实际生成位置修改 `.env`：

```dotenv
WHISPER_BIN=tools/whisper.cpp/build/bin/Release/whisper-cli.exe
FFMPEG_BIN=ffmpeg.exe
```

浏览器打开 <http://127.0.0.1:5173>。PowerShell 本身不能直接执行项目中的 Bash 安装脚本，因此首次安装模型建议使用 Git Bash。

## 模型选择与下载

默认安装推荐的多语言模型：

```bash
npm run setup:model
```

也可以指定其他模型，例如：

```bash
npm run setup:model -- small
npm run setup:model -- medium
npm run setup:model -- large-v3
npm run setup:model -- large-v3-turbo
```

| 模型 | 特点 | 适合场景 |
| --- | --- | --- |
| `small` | 体积较小、速度较快 | 低配置电脑、快速草稿 |
| `medium` | 准确率和资源占用较均衡 | 一般字幕制作 |
| `large-v3` | 准确率高、资源占用较大 | 高质量离线识别 |
| `large-v3-turbo` | 速度和准确率平衡较好 | 推荐的默认模型 |

下载的模型保存在 `models/`，不会提交到 Git。应用启动后会自动列出该目录中的可用模型。

如果需要固定首选模型，复制 `.env.example` 为 `.env` 并修改：

```dotenv
WHISPER_MODEL=models/ggml-small.bin
```

## 使用方法

1. 在左侧选择视频或音频文件。
2. 选择语言、识别质量和本地模型。
3. 按需填写术语、人名和品牌词。
4. 点击“生成高质量字幕”，等待本地处理完成。
5. 播放左侧媒体，在右侧时间轴中校对文字和时间。
6. 点击字幕序号，可以从该字幕的开始时间播放。
7. 使用条目之间的“在这里插入字幕”在任意位置新增字幕。
8. 校对完成后导出 SRT 或 VTT。

所有修改都会立即显示在视频预览中，导出的文件也会使用当前编辑内容。

## 精确移动和按帧校对

播放器下方提供两种移动模式：

- **毫秒**：输入 `500` 表示每次移动 500 毫秒。
- **按帧**：输入 `1` 表示每次移动一帧。

选择输入框以外的区域后，可以使用键盘：

- `←`：向前回退指定毫秒数或帧数
- `→`：向后前进指定毫秒数或帧数

视频播放几帧后，应用会自动估算 FPS；出现绿色状态点表示已经检测到帧率。FPS 也可以手动修改为 `24`、`25`、`29.97`、`30`、`60` 等数值。

> 浏览器可以用小数秒定位，但实际可见画面的最小单位是一帧。对于可变帧率视频，按帧移动会基于检测到的近似帧率计算，可能无法严格对应每个物理帧。

## VAD 使用说明

Silero VAD 属于实验性功能，默认关闭。它适合人声清晰并包含较长静音的录音。

对于电影、游戏录屏、背景音乐较强或多人对话的视频，启用 VAD 可能造成：

- 开头从十几秒后才出现字幕
- 后半段字幕缺失
- 字幕时间整体偏移

遇到这些情况时，请关闭 VAD 后重新生成。

## 识别结果中出现奇怪文字

Whisper 在静音、音乐、噪声或结尾空白处可能产生“幻觉”，例如重复生成与原视频无关的宣传语。这不是视频中隐藏的字幕，也不是程序从网络添加的内容。

可以尝试：

- 使用 `large-v3-turbo` 或 `large-v3` 模型
- 明确选择视频语言
- 保持 VAD 关闭后重新识别影视类素材
- 在右侧时间轴中删除错误条目
- 剪掉很长的片头、片尾静音或纯音乐段落

## 构建与本地运行

生成生产版本：

```bash
npm run build
```

启动本地服务：

```bash
npm start
```

浏览器打开 <http://127.0.0.1:8787>。

执行 TypeScript 检查：

```bash
npm run check
```

## 配置项

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `WHISPER_BIN` | `tools/whisper.cpp/build/bin/whisper-cli` | whisper.cpp 命令路径 |
| `WHISPER_MODEL` | `models/ggml-large-v3-turbo.bin` | 首选模型；不存在时自动回退到其他已安装模型 |
| `WHISPER_VAD_MODEL` | `models/ggml-silero-v6.2.0.bin` | Silero VAD 模型路径 |
| `FFMPEG_BIN` | `ffmpeg` | FFmpeg 命令或绝对路径 |
| `PORT` | `8787` | 生产模式下的本地服务端口 |
| `MAX_UPLOAD_BYTES` | `4294967296` | 最大上传字节数，默认 4 GiB |

## 项目目录

```text
subtitle_generate/
├── models/                 # 本地模型，仅保留 .gitkeep
├── runtime/                # 上传、临时音频和字幕输出，不提交
├── scripts/                # whisper.cpp 安装和模型下载脚本
├── server/                 # Fastify 本地服务
├── src/                    # React 字幕编辑器
├── .env.example            # 配置示例
├── package.json
└── README.md
```

## 不会上传到 GitHub 的内容

`.gitignore` 已排除：

- `models/` 中的 Whisper、VAD 模型
- `tools/whisper.cpp/` 源码和编译产物
- `runtime/` 中的媒体、临时音频和生成字幕
- `node_modules/`
- `dist/` 和 `dist-server/`
- 本地 `.env`

因此，其他用户克隆仓库后需要自行执行 `npm install` 和 `npm run setup:model`。

## 隐私说明

本项目不包含云端识别服务，不读取云端 API，不需要账号或 API Key。除非用户自行修改程序，否则媒体文件、识别提示和字幕内容只在本机处理。

## 许可证

本项目自行编写的源代码采用 [MIT License](LICENSE)。你可以使用、修改、分发和商用，但需要在软件副本或主要部分中保留原版权声明和许可证文本。

whisper.cpp、FFmpeg、npm 依赖以及用户自行下载的模型不包含在本项目许可证的授权范围内，仍分别适用其各自的许可证或使用条款。

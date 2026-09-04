#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WHISPER_DIR="$PROJECT_DIR/tools/whisper.cpp"
MODEL_DIR="$PROJECT_DIR/models"
MODEL_NAME="${1:-large-v3-turbo}"
VAD_MODEL_NAME="silero-v6.2.0"

case "$MODEL_NAME" in
  tiny|tiny.en|base|base.en|small|small.en|medium|medium.en|large-v1|large-v2|large-v3|large-v3-turbo)
    ;;
  *)
    echo "不支持的模型名称：${MODEL_NAME}"
    echo "可选：tiny、base、small、medium、large-v3、large-v3-turbo（部分支持 .en）"
    exit 1
    ;;
esac

for command in git cmake; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "缺少命令：${command}。请先安装后重试。"
    exit 1
  fi
done

mkdir -p "$PROJECT_DIR/tools" "$MODEL_DIR"

if [ ! -d "$WHISPER_DIR/.git" ]; then
  echo "正在下载 whisper.cpp…"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
else
  echo "已找到 whisper.cpp，跳过下载。"
fi

echo "正在编译 whisper.cpp…"
cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$WHISPER_DIR/build" --config Release -j 4

MODEL_FILE="ggml-${MODEL_NAME}.bin"
if [ ! -f "$MODEL_DIR/$MODEL_FILE" ]; then
  echo "正在下载语音模型 ${MODEL_NAME}…"
  HF_TOKEN="${HF_TOKEN:-}" bash "$WHISPER_DIR/models/download-ggml-model.sh" "$MODEL_NAME" "$MODEL_DIR"
else
  echo "模型已存在，跳过下载。"
fi

VAD_MODEL_FILE="ggml-${VAD_MODEL_NAME}.bin"
if [ ! -f "$MODEL_DIR/$VAD_MODEL_FILE" ]; then
  echo "正在下载静音检测模型 ${VAD_MODEL_NAME}…"
  bash "$WHISPER_DIR/models/download-vad-model.sh" "$VAD_MODEL_NAME" "$MODEL_DIR"
else
  echo "静音检测模型已存在，跳过下载。"
fi

echo
echo "安装完成："
echo "  识别引擎：$WHISPER_DIR/build/bin/whisper-cli"
echo "  模型：$MODEL_DIR/$MODEL_FILE"
echo "  静音检测：$MODEL_DIR/$VAD_MODEL_FILE"

if [ "$MODEL_NAME" != "large-v3-turbo" ]; then
  echo
  echo "如需固定使用这个模型，请在 .env 中设置："
  echo "WHISPER_MODEL=models/$MODEL_FILE"
fi

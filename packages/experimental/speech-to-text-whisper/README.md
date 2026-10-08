# @deepseek-ai/dsh-experimental-speech-to-text-whisper

Local speech-to-text recognition provider using Whisper-tiny ONNX models and Silero VAD via `sherpa-onnx`.

## Features
- **100% Offline & Local**: Inference runs locally on CPU using `sherpa-onnx-node`.
- **Multilingual Support**: Supports Bahasa Indonesia (`id`), English (`en`), Chinese (`zh`), and many other languages.
- **VAD Segmentation**: Silero VAD prevents transcription hallucinations on silent segments.

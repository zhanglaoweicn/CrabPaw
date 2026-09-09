# KWS 唤醒模型

来源: sherpa-onnx 开源 KWS 模型库 (zipformer transducer, Apache-2.0)
- encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx
- decoder-epoch-13-avg-2-chunk-16-left-64.onnx
- joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx
- tokens.txt (词元表)

运行时代码见 `gui/electron/kws/`。keywords.txt 由用户配置的唤醒词在运行时生成,不随包分发。

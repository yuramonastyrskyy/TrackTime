Models for rider identification (loaded by TrackCameraPlugin / RiderEngine).

- yolox_tiny.onnx: YOLOX-Tiny (COCO), Apache-2.0, from
  https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx
  (416x416, BGR 0..255; people and bicycles are used).
- osnet_x0_25.onnx: OSNet x0.25 re-ID (MSMT17), MIT (torchreid), from
  https://huggingface.co/anriha/osnet_x0_25_msmt17 with the batch size made
  dynamic (same weights; output 512 floats per 256x128 RGB crop).

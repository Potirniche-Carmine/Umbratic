"""Offline import and real media checks, run inside the complete kit environment."""
import ctypes
import importlib.metadata
import json
from pathlib import Path
import socket
import subprocess
import sys

attempts = []


def no_network(self, address):
    attempts.append(str(address))
    raise RuntimeError("network is disabled during kit qualification")


socket.socket.connect = no_network
socket.socket.connect_ex = no_network

import av
import cv2
import mlx.core as mx
import mlx_audio
from mlx_audio import audio_io
import mlx_lm
import mlx_vlm
from mlx_vlm.generate.video_generation import save_video
from mlx_vlm.utils import load_image
from PIL import Image
import numpy as np
import torch
import vllm
import vllm_metal

work = Path(sys.argv[1])
work.mkdir(parents=True, exist_ok=True)
versions = {name: importlib.metadata.version(name) for name in
            ("vllm", "vllm-metal", "mlx", "mlx-lm", "mlx-vlm", "mlx-audio", "av", "opencv-python", "opencv-python-headless")}
assert versions["vllm"] == "0.32.0+cpu" and versions["vllm-metal"] == "0.32.0"
plugins = importlib.metadata.entry_points(group="vllm.platform_plugins")
metal = [entry for entry in plugins if entry.value.startswith("vllm_metal")]
assert metal, "Metal platform plugin was not installed"
for entry in metal:
    assert entry.load() is not None
assert mx.sum(mx.array([1, 2, 3])).item() == 6

library = next((Path(cv2.__file__).parent / ".dylibs").glob("libavutil.*.dylib"))
loaded = ctypes.CDLL(str(library))
loaded.av_version_info.restype = ctypes.c_char_p
assert loaded.av_version_info() == b"7.1.5", "OpenCV loaded an obsolete FFmpeg library"
assert av.ffmpeg_version_info == "8.1.2", "PyAV's embedded runtime changed without review"

rate = 16_000
waveform = (0.2 * np.sin(2 * np.pi * 440 * np.arange(rate) / rate)).astype(np.float32)
for format in ("wav", "mp3", "flac", "ogg", "opus", "webm"):
    destination = work / ("audio." + format)
    audio_io.write(destination, waveform, rate, format=format)
    decoded, actual_rate = audio_io.read(destination, sample_rate=rate)
    assert actual_rate == rate and len(decoded) >= rate // 2, format
    assert np.isfinite(decoded).all(), format
pcm = (waveform * 32767).astype("<i2").tobytes()
for extension, options in (("m4a", ["-c:a", "aac"]), ("aac", ["-c:a", "aac", "-f", "adts"])):
    destination = work / ("audio." + extension)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(rate),
                    "-ac", "1", "-i", "pipe:0", *options, str(destination)], input=pcm, check=True)
    decoded, actual_rate = audio_io.read(destination, sample_rate=rate)
    assert actual_rate == rate and len(decoded) >= rate // 2, extension

frames = np.zeros((8, 32, 32, 3), dtype=np.uint8)
frames[:, :, :, 0] = 180
for extension in ("png", "jpg"):
    image = work / ("image." + extension)
    Image.fromarray(frames[0]).save(image)
    assert load_image(image).size == (32, 32)
    assert cv2.imread(str(image)).shape == (32, 32, 3)
video = save_video(frames, work / "video.mp4", fps=8, audio=waveform, sampling_rate=rate)
capture = cv2.VideoCapture(str(video))
count = 0
while True:
    ok, frame = capture.read()
    if not ok:
        break
    assert frame.shape == (32, 32, 3)
    count += 1
capture.release()
assert count == len(frames), ("OpenCV frame count", count)
with av.open(str(video)) as container:
    assert len(list(container.decode(video=0))) == len(frames)
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video), "-f", "null", "-"], check=True)
from torchcodec.decoders import VideoDecoder
assert len(VideoDecoder(str(video))) == len(frames)
assert not attempts, ("imports attempted network access", attempts)
print(json.dumps({"versions": versions, "opencv_ffmpeg": "7.1.5", "pyav_ffmpeg": av.ffmpeg_version_info,
                  "audio_formats": ["wav", "mp3", "flac", "ogg", "opus", "webm", "m4a", "aac"],
                  "video": "MLX-VLM libx264/AAC MP4 -> OpenCV, PyAV, TorchCodec and FFmpeg decode",
                  "vision_formats": ["png", "jpeg"], "model_downloads": False}, indent=2))

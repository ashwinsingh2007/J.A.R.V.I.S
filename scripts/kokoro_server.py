#!/usr/bin/env python3
"""Persistent Kokoro TTS worker. Model stays loaded; one JSON request per line
on stdin -> one JSON reply per line on stdout.

  in : {"id": "abc", "text": "Good evening.", "voice": "bm_george", "speed": 1.0, "out": "/tmp/x.wav"}
  out: {"id": "abc", "ok": true, "ms": 820, "seconds": 2.1}
"""
import json
import os
import sys
import time

import soundfile as sf
from kokoro_onnx import Kokoro

here = os.path.dirname(os.path.abspath(__file__))
models = os.path.join(os.path.dirname(here), "models")
t0 = time.time()
kokoro = Kokoro(os.path.join(models, "kokoro-v1.0.onnx"), os.path.join(models, "voices-v1.0.bin"))
sys.stdout.write(json.dumps({"ready": True, "load_ms": int((time.time() - t0) * 1000)}) + "\n")
sys.stdout.flush()

for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    rid = req.get("id", "")
    try:
        t = time.time()
        audio, sr = kokoro.create(req["text"], voice=req.get("voice", "bm_george"),
                                  speed=float(req.get("speed", 1.0)), lang=req.get("lang", "en-gb"))
        sf.write(req["out"], audio, sr)
        reply = {"id": rid, "ok": True, "ms": int((time.time() - t) * 1000), "seconds": round(len(audio) / sr, 2)}
    except Exception as e:  # keep serving after a bad request
        reply = {"id": rid, "ok": False, "error": str(e)[:200]}
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()

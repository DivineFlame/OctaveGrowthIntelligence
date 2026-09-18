from fastapi import FastAPI
from PIL import Image
import os, uuid

app = FastAPI(title="Paperclip Transformer", version="4.1.0")

# Keyed by the same channel names api/src/server.js's PRODUCT_CHANNELS uses
# (and validates content_variants.channel against) - so a variant's channel
# always has a spec here. One canonical target size per channel for now
# (not the full multi-crop set some channels can technically take, e.g.
# Instagram feed + portrait + reels) - a real, working single resize per
# channel rather than a bigger multi-output job this pass doesn't cover.
SPECS = {
    "whatsapp": {"width": 1080, "height": 1080},
    "facebook": {"width": 1200, "height": 628},
    "instagram": {"width": 1080, "height": 1080},
    "linkedin": {"width": 1200, "height": 627},
    "youtube": {"width": 1280, "height": 720},
    "quora": {"width": 1200, "height": 675},
    "email": {"width": 1200, "height": 600},
}

RECORDINGS_DIR = "/app/recordings"


@app.get("/health")
def health():
    return {"status": "ok", "service": "paperclip-transformer", "specs": list(SPECS.keys())}


# Real per-channel resize for image assets. Takes the *source* asset's
# s3_key (a real path on the `recordings` volume this container shares with
# `api`) plus which channel to target, resizes it for real with Pillow, and
# writes a real file - no fabricated path, no fake "status": "transformed"
# for work that never happened. Anything that isn't an image (video, PDF,
# spreadsheet) is honestly reported as skipped: resizing those needs a
# meaningfully different pipeline (ffmpeg for video, a renderer for
# PDF/doc), which isn't part of this pass - the caller (POST
# /content/:assetId/transform in api/src/server.js) leaves the variant row
# it already created untouched when this happens, rather than pretending a
# file exists that doesn't.
@app.post("/transform")
async def transform(payload: dict):
    variant_id = payload.get("variant_id")
    asset_id = payload.get("asset_id")
    channel = payload.get("channel")
    s3_key = payload.get("s3_key")
    mime_type = payload.get("mime_type") or ""

    spec = SPECS.get(channel)
    if not spec:
        return {"variant_id": variant_id, "channel": channel, "status": "skipped", "reason": f"no spec for channel '{channel}'"}

    if not mime_type.startswith("image/"):
        return {"variant_id": variant_id, "channel": channel, "status": "skipped", "reason": f"'{mime_type}' is not an image - per-channel resize for video/PDF/spreadsheet sources isn't implemented yet"}

    if not s3_key or not os.path.exists(s3_key):
        return {"variant_id": variant_id, "channel": channel, "status": "skipped", "reason": "source file not found on the recordings volume"}

    try:
        os.makedirs(RECORDINGS_DIR, exist_ok=True)
        with Image.open(s3_key) as img:
            img = img.convert("RGB") if img.mode not in ("RGB", "L") else img
            resized = img.resize((spec["width"], spec["height"]))
            out_path = f"{RECORDINGS_DIR}/{asset_id}_{channel}_{uuid.uuid4().hex[:8]}.jpg"
            resized.save(out_path, "JPEG", quality=90)
        return {
            "variant_id": variant_id,
            "channel": channel,
            "status": "transformed",
            "output": out_path,
            "width": spec["width"],
            "height": spec["height"],
        }
    except Exception as e:
        return {"variant_id": variant_id, "channel": channel, "status": "skipped", "reason": f"resize failed: {e}"}

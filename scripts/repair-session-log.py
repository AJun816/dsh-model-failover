#!/usr/bin/env python3
"""Repair DSH session logs damaged by dsh-model-failover < v0.8.1.

Old plugin versions wrote a REQUIRED 'model-failover/switch' session event
through the plain append channel. The DSH persistence reader refuses to load
any log containing an unknown event type without the envelope's ignorable
marker ("unknown to this harness and not marked ignorable"), so history load
fails for every affected session.

This tool finds every such event across ~/.dsh/sessions and stamps
"ignorable": true onto it, frame-faithfully: the zstd log is a concatenation
of per-append frames; only the frame owning an affected line is recompressed,
every other frame keeps its original bytes. Originals are backed up and the
replacement is atomic (tmp + rename).

Usage:
  python3 scripts/repair-session-log.py            # scan and repair
  python3 scripts/repair-session-log.py --dry-run  # scan only

Requires: python3 + zstandard (pip install zstandard).
"""
import argparse
import glob
import io
import json
import os
import shutil
import sys
import tempfile

try:
    import zstandard
except ImportError:
    sys.exit("missing dependency: pip install zstandard")

AFFECTED_TYPES = {"model-failover/switch"}
SESSIONS_ROOT = os.path.expanduser("~/.dsh/sessions")
BACKUP_DIR = os.path.expanduser("~/.dsh/session-repair-backups")


def frames_of(raw):
    dctx = zstandard.ZstdDecompressor()
    frames, pos = [], 0
    while pos < len(raw):
        buf = raw[pos:]
        obj = dctx.decompressobj()
        text = obj.decompress(buf)
        used = len(buf) - len(obj.unused_data)
        frames.append((bytes(buf[:used]), text))
        pos += used
    return frames


def repair(path, dry):
    raw = open(path, "rb").read()
    frames = frames_of(raw)
    full = b"".join(text for _, text in frames)
    lines = full.split(b"\n")
    if not lines or lines[-1] != b"":
        return ("skip", 0)  # unexpected tail; never touch a torn log
    lines = lines[:-1]

    hits = []
    for i, line in enumerate(lines):
        if b'"type":"model-failover/switch"' not in line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") in AFFECTED_TYPES and obj.get("ignorable") is not True:
            hits.append(i)
    if not hits:
        return ("clean", 0)

    if dry:
        return ("would-repair", len(hits))

    new_lines = list(lines)
    for i in hits:
        obj = json.loads(lines[i])
        obj["ignorable"] = True
        new_lines[i] = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()

    # map each edited line to its owning frame by byte offset in the original text
    offsets, acc = [], 0
    for _, text in frames:
        offsets.append((acc, acc + len(text)))
        acc += len(text)

    def frame_of(line_idx):
        off = sum(len(l) + 1 for l in lines[:line_idx])
        for fi, (s, e) in enumerate(offsets):
            if s <= off < e:
                return fi
        raise AssertionError("owning frame not found")

    edits = {}
    for i in hits:
        edits.setdefault(frame_of(i), []).append((lines[i], new_lines[i]))

    new_frames = []
    for fi, (cb, tb) in enumerate(frames):
        if fi in edits:
            for old, new in edits[fi]:
                assert old + b"\n" in tb
                tb = tb.replace(old + b"\n", new + b"\n", 1)
            cb = zstandard.ZstdCompressor().compress(tb)
        new_frames.append((cb, tb))

    blob = b"".join(cb for cb, _ in new_frames)
    check = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(blob), read_across_frames=True).read()
    expected = full.split(b"\n")
    for i in hits:
        expected[i] = new_lines[i]
    assert check == b"\n".join(expected), "roundtrip mismatch"

    os.makedirs(BACKUP_DIR, exist_ok=True)
    name = os.path.basename(os.path.dirname(path))
    shutil.copy2(path, os.path.join(BACKUP_DIR, name + ".session.v4.jsonl.zstd"))
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".repair-", suffix=".tmp")
    os.write(fd, blob)
    os.close(fd)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return ("repaired", len(hits))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    paths = sorted(glob.glob(os.path.join(SESSIONS_ROOT, "*", "session-*", "session.v4.jsonl.zstd")))
    counts = {}
    for p in paths:
        status, n = repair(p, args.dry_run)
        counts[status] = counts.get(status, 0) + 1
        if n:
            print(status + ": " + p + " (" + str(n) + " event(s))")
    print("summary:", dict(counts), "| backups:", BACKUP_DIR)


if __name__ == "__main__":
    main()

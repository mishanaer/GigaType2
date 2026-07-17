#!/usr/bin/env python3
"""Upload GigaType (Type) release artifacts to SberCloud OBS.

Ported from GigaTool's scripts/publish.py. OBS quirks this script papers over:
1. Virtual-hosted addressing is mandatory for PUT/POST. Path-style reads
   work fine (electron-updater fetches manifests via path-style URLs), but
   uploading with `addressing_style=path` returns NoSuchBucket.
2. boto3 1.36+ enables streaming SHA256 chunked transfer by default; OBS
   doesn't parse it and returns XAmzContentSHA256Mismatch. We force
   `request_checksum_calculation=when_required` to opt out.
3. Default object ACL is private. electron-updater needs anonymous reads,
   so we upload with `public-read`.

GigaType differences from GigaTool:
- Source dir is <app>/dist (electron-builder "directories.output": "dist").
- OBS prefix is function_descriptions/gigatype-electron/<channel>.
- macOS uses arch-specific update channels (latest-arm64 / latest-x64), so
  the updater fetches latest-arm64-mac.yml / latest-x64-mac.yml rather than
  the shared latest-mac.yml. Those per-arch manifests are just copies of the
  arch's latest-mac.yml (GigaTool's CI made them with `cp` + `gh release
  upload`; on the OBS path there is no GitHub release, so use --mac-arch to
  mint the copy here before uploading — run once per arch build).

Reads credentials from .env next to package.json (this file lives in
<app>/scripts/, so REPO_ROOT is <app>/) or from environment if .env is
absent. Required vars:
  OBS_ENDPOINT, OBS_BUCKET, OBS_REGION, OBS_PREFIX (or OPENWHISPR_CHANNEL)
  S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY

Usage:
  scripts/publish.py                     # upload everything in dist/ that
                                         # matches the patterns below
  scripts/publish.py --mac-arch arm64    # first copy latest-mac.yml ->
                                         # latest-arm64-mac.yml, then upload
  scripts/publish.py --from PATH         # use a different source dir
  scripts/publish.py --files a.dmg b.dmg # explicit file list (paths or names)
  scripts/publish.py --filter '*.dmg'    # only matching names
  scripts/publish.py --dry-run           # print the plan, upload nothing

Upload order: binaries first, manifests last, so the auto-updater is never
pointed at a file that hasn't been uploaded yet.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import pathlib
import shutil
import sys

try:
    import boto3
    from botocore.config import Config
except ImportError:
    sys.exit("error: boto3 not installed. Run: python3 -m pip install --user boto3")

# This file lives at <app>/scripts/publish.py, so REPO_ROOT is the app dir
# (the one holding package.json and .env), mirroring GigaTool's layout.
REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_DIST = REPO_ROOT / "dist"

# Patterns electron-updater clients fetch. Order matters: binaries first,
# manifests last. Everything inside one tier is uploaded in glob order.
BINARY_PATTERNS = (
    "*.dmg",
    "*.dmg.blockmap",
    "*.zip",
    "*.zip.blockmap",
    "*.AppImage",
    "*.AppImage.blockmap",
    "*.deb",
    "*.rpm",
    "*.tar.gz",
    "*.exe",
    "*.exe.blockmap",
)
MANIFEST_PATTERNS = (
    "latest-mac.yml",
    "latest-arm64-mac.yml",
    "latest-x64-mac.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
    "latest.yml",
)


def load_env_file(path: pathlib.Path) -> None:
    """Minimal .env loader — sets os.environ keys not already present."""
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        # Strip matching surrounding quotes.
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        os.environ.setdefault(key, val)


def require(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"error: {name} not set (check .env or environment)")
    return val


def ensure_mac_arch_manifest(source: pathlib.Path, arch: str) -> pathlib.Path:
    """Copy latest-mac.yml -> latest-<arch>-mac.yml so the arch-specific
    update channel has a manifest to fetch. Overwrites any existing copy."""
    src = source / "latest-mac.yml"
    if not src.is_file():
        sys.exit(
            f"error: --mac-arch {arch} needs {src}, but it is missing. "
            "Run the macOS build for this arch first."
        )
    dst = source / f"latest-{arch}-mac.yml"
    shutil.copyfile(src, dst)
    print(f"==> minted:  {dst.name}  (copy of latest-mac.yml)")
    return dst


def resolve_files(
    source: pathlib.Path,
    explicit: list[str] | None,
    name_filter: str | None,
) -> tuple[list[pathlib.Path], list[pathlib.Path]]:
    """Return (binaries, manifests) lists in upload order."""
    if explicit:
        files: list[pathlib.Path] = []
        for raw in explicit:
            p = pathlib.Path(raw)
            if not p.is_absolute():
                p = source / p
            if not p.is_file():
                sys.exit(f"error: {p} is not a file")
            files.append(p)
        # Partition: known manifests vs binaries; keep the order asked for.
        manifest_names = set(MANIFEST_PATTERNS)
        manifests = [f for f in files if f.name in manifest_names]
        binaries = [f for f in files if f.name not in manifest_names]
        return binaries, manifests

    def gather(patterns: tuple[str, ...]) -> list[pathlib.Path]:
        seen: set[pathlib.Path] = set()
        out: list[pathlib.Path] = []
        for pat in patterns:
            for p in sorted(source.glob(pat)):
                if not p.is_file() or p in seen:
                    continue
                if name_filter and not fnmatch.fnmatch(p.name, name_filter):
                    continue
                seen.add(p)
                out.append(p)
        return out

    return gather(BINARY_PATTERNS), gather(MANIFEST_PATTERNS)


def make_config() -> Config:
    base_kwargs = {
        "signature_version": "s3v4",
        "s3": {"addressing_style": "virtual"},
    }
    # boto3 1.36+ enables streaming SHA256 by default, which OBS rejects.
    # Earlier versions don't accept these kwargs but also don't enable the
    # offending behavior, so we just fall back to the base config there.
    try:
        return Config(
            **base_kwargs,
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        )
    except TypeError:
        return Config(**base_kwargs)


def make_client():
    return boto3.client(
        "s3",
        endpoint_url=require("OBS_ENDPOINT"),
        region_name=os.environ.get("OBS_REGION", "ru-moscow-1"),
        aws_access_key_id=require("S3_ACCESS_KEY_ID"),
        aws_secret_access_key=require("S3_SECRET_ACCESS_KEY"),
        config=make_config(),
    )


def resolve_prefix() -> str:
    """Mirror the intended generic update feed:
    function_descriptions/gigatype-electron/<channel>."""
    explicit = os.environ.get("OBS_PREFIX")
    if explicit:
        return explicit.rstrip("/")
    # .env.example ships OPENWHISPR_CHANNEL blank, so treat empty as unset.
    channel = os.environ.get("OPENWHISPR_CHANNEL") or "prod"
    return f"function_descriptions/gigatype-electron/{channel}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--from",
        dest="source",
        default=str(DEFAULT_DIST),
        help=f"source directory (default: {DEFAULT_DIST})",
    )
    ap.add_argument(
        "--mac-arch",
        choices=("arm64", "x64"),
        help="before uploading, copy latest-mac.yml -> latest-<arch>-mac.yml "
        "so the arch-specific update channel has a manifest. Run once per "
        "arch build (arm64 and x64 build separately).",
    )
    ap.add_argument(
        "--files",
        nargs="+",
        help="explicit list of files (paths or names relative to --from). "
        "Overrides pattern discovery.",
    )
    ap.add_argument(
        "--filter",
        dest="name_filter",
        help='only upload files whose basename matches this glob (e.g. "*arm64*")',
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="print the upload plan without uploading",
    )
    ap.add_argument(
        "--no-public",
        action="store_true",
        help="upload with default (private) ACL instead of public-read",
    )
    args = ap.parse_args()

    load_env_file(REPO_ROOT / ".env")
    source = pathlib.Path(args.source).resolve()
    if not source.is_dir():
        sys.exit(f"error: source dir {source} not found")

    if args.mac_arch:
        ensure_mac_arch_manifest(source, args.mac_arch)

    binaries, manifests = resolve_files(source, args.files, args.name_filter)
    if not binaries and not manifests:
        sys.exit("error: nothing matched — check --from and the patterns in this script")

    bucket = require("OBS_BUCKET")
    prefix = resolve_prefix()
    extra = {} if args.no_public else {"ACL": "public-read"}

    print(f"==> source:  {source}")
    print(f"==> target:  s3://{bucket}/{prefix}/")
    print(f"==> ACL:     {'private' if args.no_public else 'public-read'}")
    print(f"==> files:   {len(binaries)} binaries + {len(manifests)} manifests")
    if args.dry_run:
        for f in [*binaries, *manifests]:
            print(f"  [dry-run] {f.name}")
        return 0

    s3 = make_client()
    for f in [*binaries, *manifests]:
        key = f"{prefix}/{f.name}"
        size_mb = f.stat().st_size / (1024 * 1024)
        print(f"  -> {f.name}  ({size_mb:.1f} MB)")
        s3.upload_file(str(f), bucket, key, ExtraArgs=extra)
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

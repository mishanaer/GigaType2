# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas = []
binaries = []
hiddenimports = ['onnx_asr', 'onnxruntime']
tmp_ret = collect_all('onnx_asr')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]

EXCLUDE_BINARY_SUBSTRINGS = [
    'hf_xet',
    'uvloop',
    'watchfiles',
    'libsqlite3',
    '_codecs_cn',
    '_codecs_jp',
    '_codecs_kr',
    '_codecs_tw',
    '_codecs_hk',
    '_codecs_iso2022',
    'yaml/_yaml',
]

def keep_binary(name, path):
    combined = (name + '/' + (path or '')).replace('\\', '/')
    return not any(pat in combined for pat in EXCLUDE_BINARY_SUBSTRINGS)

a = Analysis(
    ['gigatype_sidecar_entry.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'sqlite3',
        '_sqlite3',
        'unittest',
        'test',
        'distutils',
        'setuptools',
        'pkg_resources',
        'tkinter',
        'webbrowser',
        'turtle',
        'cgi',
        'cgitb',
    ],
    noarchive=False,
    optimize=2,
)

a.binaries = [(name, path, typ) for name, path, typ in a.binaries
              if keep_binary(name, path)]

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='gigatype-sidecar-darwin-arm64',
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch='arm64',
    codesign_identity=None,
    entitlements_file=None,
)

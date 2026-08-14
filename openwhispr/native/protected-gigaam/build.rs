use std::{env, fs, path::PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};

fn extract_base64(source: &str, constant: &str) -> String {
    let marker = format!("const {constant} =");
    let tail = source
        .split_once(&marker)
        .unwrap_or_else(|| panic!("missing {constant} in gigaamFbankAssets.js"))
        .1;
    let expression = tail
        .split_once(';')
        .unwrap_or_else(|| panic!("unterminated {constant}"))
        .0;
    let mut output = String::new();
    let mut quoted = false;
    for ch in expression.chars() {
        if ch == '"' {
            quoted = !quoted;
        } else if quoted {
            output.push(ch);
        }
    }
    output
}

// Repeating XOR pad shared with `gateway_identity::registration_key`. It only has
// to defeat `strings`/static extraction of the baked registration key — a
// determined reverse engineer can still recombine pad + blob, which is the
// accepted ceiling of client-side obfuscation.
const REG_KEY_PAD: [u8; 16] = [
    0x9e, 0x37, 0x79, 0xb9, 0x7f, 0x4a, 0x7c, 0x15, 0xf3, 0x9c, 0xc0, 0x60, 0x5c, 0xed, 0xc8, 0x34,
];

fn main() {
    println!("cargo:rerun-if-env-changed=TYPE_REGISTRATION_KEY");
    println!("cargo:rerun-if-env-changed=TYPE_MODEL_MANIFEST_PUBLIC_KEY");

    // Bake the registration key XOR-obfuscated so it never appears as a literal
    // string in the binary. Absent at build time (dev/CI) → empty blob and the
    // runtime falls back to the TYPE_REGISTRATION_KEY env var.
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let obfuscated = env::var("TYPE_REGISTRATION_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            value
                .trim()
                .bytes()
                .enumerate()
                .map(|(i, byte)| byte ^ REG_KEY_PAD[i % REG_KEY_PAD.len()])
                .collect::<Vec<u8>>()
        })
        .unwrap_or_default();
    fs::write(out_dir.join("regkey.obf"), &obfuscated).expect("write obfuscated registration key");

    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let assets_path = manifest.join("../../src/workers/gigaamFbankAssets.js");
    println!("cargo:rerun-if-changed={}", assets_path.display());
    let source = fs::read_to_string(&assets_path).expect("read gigaamFbankAssets.js");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());

    for (constant, file) in [
        ("WINDOW_B64", "window_v3.f32"),
        ("MEL_FBANK_B64", "mel_fbank_v3.f32"),
    ] {
        let encoded = extract_base64(&source, constant);
        let decoded = STANDARD
            .decode(encoded)
            .unwrap_or_else(|error| panic!("decode {constant}: {error}"));
        fs::write(out.join(file), decoded).unwrap_or_else(|error| panic!("write {file}: {error}"));
    }
}

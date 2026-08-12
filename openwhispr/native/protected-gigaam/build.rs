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

fn main() {
    println!("cargo:rerun-if-env-changed=TYPE_REGISTRATION_KEY");
    println!("cargo:rerun-if-env-changed=TYPE_MODEL_MANIFEST_PUBLIC_KEY");
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

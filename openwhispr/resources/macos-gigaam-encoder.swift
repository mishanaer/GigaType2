// GigaAM v3 encoder on the Apple Neural Engine.
//
// The ONNX encoder is the expensive part of the RNN-T pipeline (it pegged every
// performance core for the whole transcription). CoreML runs the same weights on
// the ANE, but CoreML is only reachable from a native process — hence this
// helper: a long-lived child of the ONNX utility process that owns the MLModel
// and answers log-mel → encoder-output requests over stdio.
//
// Model: https://github.com/IsaacClarke2/gigaam-v3-coreml (fp16 MLProgram,
// converted 1:1 from istupakov/gigaam-v3-onnx). The ANE cannot do dynamic
// shapes, so the input window is FIXED at 3360 mel frames (33.6 s) and short
// requests are zero-padded. `encoded_len` from the graph is off by one on
// padded input, so the valid length is recomputed here as ceil(frames / 4).
//
// Protocol (little-endian, binary; stderr carries human-readable logs):
//   hello    (helper → parent, once):  magic "GENH", u32 jsonLen, jsonLen bytes
//   request  (parent → helper):        magic "GENQ", u32 id, u32 numFrames,
//                                      numFrames * 64 f32, row-major [mel][frame]
//   response (helper → parent):        magic "GENR", u32 id, u32 status,
//                                      u32 encDim, u32 encFrames, u32 msgLen,
//                                      then either encDim * encFrames f32
//                                      row-major [dim][frame] (status 0) or
//                                      msgLen bytes of UTF-8 error text.

import CoreML
import Foundation

let nMels = 64
let windowFrames = 3360
let subsampleFactor = 4

let helloMagic: UInt32 = 0x4745_4e48 // "GENH"
let requestMagic: UInt32 = 0x4745_4e51 // "GENQ"
let responseMagic: UInt32 = 0x4745_4e52 // "GENR"

func logLine(_ message: String) {
    FileHandle.standardError.write(Data("[gigaam-encoder] \(message)\n".utf8))
}

// MARK: - stdio framing

func readExact(_ count: Int) -> [UInt8]? {
    if count == 0 { return [] }
    var out = [UInt8](repeating: 0, count: count)
    var filled = 0
    while filled < count {
        let n = out.withUnsafeMutableBytes { raw -> Int in
            read(0, raw.baseAddress!.advanced(by: filled), count - filled)
        }
        if n > 0 {
            filled += n
            continue
        }
        if n == 0 { return nil } // parent closed the pipe
        if errno == EINTR { continue }
        logLine("stdin read failed: errno \(errno)")
        return nil
    }
    return out
}

func writeExact(_ bytes: UnsafeRawBufferPointer) -> Bool {
    var written = 0
    while written < bytes.count {
        let n = write(1, bytes.baseAddress!.advanced(by: written), bytes.count - written)
        if n > 0 {
            written += n
            continue
        }
        if n < 0 && (errno == EINTR || errno == EAGAIN) { continue }
        logLine("stdout write failed: errno \(errno)")
        return false
    }
    return true
}

func writeExact(_ bytes: [UInt8]) -> Bool {
    bytes.withUnsafeBytes { writeExact($0) }
}

func appendU32(_ value: UInt32, to bytes: inout [UInt8]) {
    let le = value.littleEndian
    withUnsafeBytes(of: le) { bytes.append(contentsOf: $0) }
}

func readU32(_ bytes: [UInt8], at offset: Int) -> UInt32 {
    UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8 | UInt32(bytes[offset + 2]) << 16
        | UInt32(bytes[offset + 3]) << 24
}

func sendResponse(id: UInt32, encDim: Int, encFrames: Int, payload: [Float32]) -> Bool {
    var header = [UInt8]()
    header.reserveCapacity(24)
    appendU32(responseMagic, to: &header)
    appendU32(id, to: &header)
    appendU32(0, to: &header)
    appendU32(UInt32(encDim), to: &header)
    appendU32(UInt32(encFrames), to: &header)
    appendU32(0, to: &header)
    if !writeExact(header) { return false }
    return payload.withUnsafeBytes { writeExact($0) }
}

func sendError(id: UInt32, message: String) -> Bool {
    let text = Array(message.utf8)
    var frame = [UInt8]()
    frame.reserveCapacity(24 + text.count)
    appendU32(responseMagic, to: &frame)
    appendU32(id, to: &frame)
    appendU32(1, to: &frame)
    appendU32(0, to: &frame)
    appendU32(0, to: &frame)
    appendU32(UInt32(text.count), to: &frame)
    frame.append(contentsOf: text)
    return writeExact(frame)
}

func sendHello(_ json: String) -> Bool {
    let text = Array(json.utf8)
    var frame = [UInt8]()
    frame.reserveCapacity(8 + text.count)
    appendU32(helloMagic, to: &frame)
    appendU32(UInt32(text.count), to: &frame)
    frame.append(contentsOf: text)
    return writeExact(frame)
}

// MARK: - model

func parseComputeUnits(_ raw: String?) -> MLComputeUnits {
    switch raw {
    case "cpu": return .cpuOnly
    case "all": return .all
    default: return .cpuAndNeuralEngine
    }
}

let args = CommandLine.arguments
var requestedComputeUnits: String? = nil
if let flagIndex = args.firstIndex(of: "--compute-units"), flagIndex + 1 < args.count {
    requestedComputeUnits = args[flagIndex + 1]
}
// Protected build: the model is decrypted by the Rust sidecar and streamed in
// over stdin, so nothing plaintext is ever written to disk. `--from-memory`
// selects that path; otherwise the model is a file argument (the normal build).
let fromMemory = args.contains("--from-memory")

let configuration = MLModelConfiguration()
configuration.computeUnits = parseComputeUnits(requestedComputeUnits)

// The in-memory ML Program spec and its weight blob MUST outlive the model, or
// CoreML reads freed memory and inference returns NaN. Held for the process life.
var retainedSpec: Data?
var retainedBlob: Data?

func loadModelFromMemory() -> MLModel? {
    guard #available(macOS 15, *) else {
        logLine("--from-memory requires macOS 15+ (MLModelAsset blobMapping)")
        return nil
    }
    // Startup framing: magic "GENM", u32 specLen, u32 blobLen, then the two blobs.
    guard let header = readExact(12), readU32(header, at: 0) == 0x4745_4e4d else {
        logLine("expected in-memory model header (GENM)")
        return nil
    }
    let specLen = Int(readU32(header, at: 4))
    let blobLen = Int(readU32(header, at: 8))
    guard specLen > 0, specLen < 64 * 1024 * 1024, blobLen > 0, blobLen < 4096 * 1024 * 1024 else {
        logLine("in-memory model header out of range (spec \(specLen), blob \(blobLen))")
        return nil
    }
    guard let specBytes = readExact(specLen), let blobBytes = readExact(blobLen) else {
        logLine("truncated in-memory model payload")
        return nil
    }
    retainedSpec = Data(specBytes)
    retainedBlob = Data(blobBytes)
    // ML Program weights are an external blob referenced as "@model_path/weights/
    // weight.bin"; the ObjC API resolves that against a file-URL keyed on the
    // relative blob path. Matches coremltools' native create_model_asset_from_memory.
    let mapping: [URL: Data] = [URL(fileURLWithPath: "weights/weight.bin"): retainedBlob!]
    do {
        let asset = try MLModelAsset(specification: retainedSpec!, blobMapping: mapping)
        let sem = DispatchSemaphore(value: 0)
        var loaded: MLModel?
        var loadErr: Error?
        Task {
            do { loaded = try await MLModel.load(asset: asset, configuration: configuration) }
            catch { loadErr = error }
            sem.signal()
        }
        sem.wait()
        if let e = loadErr { logLine("MLModelAsset load failed: \(e.localizedDescription)"); return nil }
        return loaded
    } catch {
        logLine("MLModelAsset build failed: \(error.localizedDescription)")
        return nil
    }
}

func loadModelFromPath() -> MLModel? {
    guard args.count >= 2, !args[1].hasPrefix("--") else {
        logLine("usage: macos-gigaam-encoder <encoder.mlmodelc|encoder.mlpackage> [--compute-units cpu_ane|all|cpu] | --from-memory")
        return nil
    }
    var modelURL = URL(fileURLWithPath: args[1])
    guard FileManager.default.fileExists(atPath: modelURL.path) else {
        logLine("model not found at \(modelURL.path)")
        return nil
    }
    // Packaged builds ship a precompiled .mlmodelc (compiled at build time, the way
    // Xcode bundles models). A raw .mlpackage — handy in dev — is compiled here and
    // the result is left in the system temp dir for CoreML to reuse.
    if modelURL.pathExtension == "mlpackage" {
        do {
            modelURL = try MLModel.compileModel(at: modelURL)
        } catch {
            logLine("compileModel failed: \(error.localizedDescription)")
            return nil
        }
    }
    do {
        return try MLModel(contentsOf: modelURL, configuration: configuration)
    } catch {
        logLine("MLModel load failed: \(error.localizedDescription)")
        return nil
    }
}

let loadStarted = Date()
guard let model = fromMemory ? loadModelFromMemory() : loadModelFromPath() else {
    exit(fromMemory ? 5 : 3)
}
let loadMs = Int(Date().timeIntervalSince(loadStarted) * 1000)

let audioSignal: MLMultiArray
let lengthInput: MLMultiArray
do {
    audioSignal = try MLMultiArray(shape: [1, NSNumber(value: nMels), NSNumber(value: windowFrames)], dataType: .float32)
    lengthInput = try MLMultiArray(shape: [1], dataType: .int32)
} catch {
    logLine("MLMultiArray allocation failed: \(error.localizedDescription)")
    exit(6)
}

// features: row-major [mel][frame], `frames` valid frames; the rest of the fixed
// window is zero-padded. CoreML does not promise dense packing, so writes go
// through the reported strides.
func fillInput(features: [Float32], frames: Int) {
    audioSignal.withUnsafeMutableBufferPointer(ofType: Float32.self) { pointer, strides in
        pointer.update(repeating: 0)
        let melStride = strides[1]
        let frameStride = strides[2]
        for mel in 0..<nMels {
            let source = mel * frames
            let target = mel * melStride
            for frame in 0..<frames {
                pointer[target + frame * frameStride] = features[source + frame]
            }
        }
    }
    lengthInput[0] = NSNumber(value: Int32(frames))
}

struct EncoderOutput {
    let dim: Int
    let frames: Int
    let data: [Float32]
}

func runEncoder(frames: Int) throws -> EncoderOutput {
    let provider = try MLDictionaryFeatureProvider(dictionary: [
        "audio_signal": MLFeatureValue(multiArray: audioSignal),
        "length": MLFeatureValue(multiArray: lengthInput),
    ])
    let prediction = try model.prediction(from: provider)
    guard let encoded = prediction.featureValue(for: "encoded")?.multiArrayValue else {
        throw NSError(
            domain: "gigaam-encoder", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "prediction has no 'encoded' output"])
    }

    let dim = encoded.shape[1].intValue
    let available = encoded.shape[2].intValue
    // The graph's own encoded_len is one too high on padded input; ORT's
    // subsampling length is ceil(frames / subsampleFactor).
    let validFrames = min((frames + subsampleFactor - 1) / subsampleFactor, available)

    var out = [Float32](repeating: 0, count: dim * validFrames)
    // The read-only accessor hands over just the pointer, so strides come from
    // the array itself — same reason as on the input side, no dense-packing
    // guarantee.
    let strides = encoded.strides.map { $0.intValue }
    encoded.withUnsafeBufferPointer(ofType: Float32.self) { pointer in
        let dimStride = strides[1]
        let frameStride = strides[2]
        for d in 0..<dim {
            let source = d * dimStride
            let target = d * validFrames
            for t in 0..<validFrames {
                out[target + t] = pointer[source + t * frameStride]
            }
        }
    }
    return EncoderOutput(dim: dim, frames: validFrames, data: out)
}

// One full-window pass so the ~40 s first-run ANE specialization happens while
// the engine is still starting up rather than on the user's first dictation.
let warmupStarted = Date()
var warmupDim = 0
do {
    fillInput(features: [Float32](repeating: 0, count: nMels * windowFrames), frames: windowFrames)
    warmupDim = try runEncoder(frames: windowFrames).dim
} catch {
    logLine("warmup prediction failed: \(error.localizedDescription)")
    exit(7)
}
let warmupMs = Int(Date().timeIntervalSince(warmupStarted) * 1000)

let computeUnitsLabel: String
switch configuration.computeUnits {
case .cpuOnly: computeUnitsLabel = "cpu"
case .all: computeUnitsLabel = "all"
default: computeUnitsLabel = "cpu_ane"
}

guard
    sendHello(
        "{\"encDim\":\(warmupDim),\"windowFrames\":\(windowFrames),\"nMels\":\(nMels),"
            + "\"subsample\":\(subsampleFactor),\"loadMs\":\(loadMs),\"warmupMs\":\(warmupMs),"
            + "\"computeUnits\":\"\(computeUnitsLabel)\"}")
else {
    exit(8)
}
logLine("ready (load \(loadMs) ms, warmup \(warmupMs) ms, computeUnits \(computeUnitsLabel))")

// MARK: - request loop

while true {
    guard let header = readExact(16) else { break } // EOF: parent went away
    let magic = readU32(header, at: 0)
    let id = readU32(header, at: 4)
    let frames = Int(readU32(header, at: 8))
    let payloadFloats = Int(readU32(header, at: 12))

    if magic != requestMagic {
        logLine("bad request magic \(String(magic, radix: 16)) — desynchronized, exiting")
        exit(9)
    }
    if frames < 1 || frames > windowFrames || payloadFloats != frames * nMels {
        // The payload is unread, so the stream is unusable from here on.
        _ = sendError(
            id: id,
            message: "invalid request: frames=\(frames) floats=\(payloadFloats) (window \(windowFrames), mels \(nMels))")
        exit(10)
    }

    guard let raw = readExact(payloadFloats * 4) else { break }
    var features = [Float32](repeating: 0, count: payloadFloats)
    features.withUnsafeMutableBytes { destination in
        raw.withUnsafeBytes { source in
            destination.copyMemory(from: source)
        }
    }

    do {
        fillInput(features: features, frames: frames)
        let result = try runEncoder(frames: frames)
        if !sendResponse(id: id, encDim: result.dim, encFrames: result.frames, payload: result.data) {
            break
        }
    } catch {
        if !sendError(id: id, message: "prediction failed: \(error.localizedDescription)") { break }
    }
}

exit(0)

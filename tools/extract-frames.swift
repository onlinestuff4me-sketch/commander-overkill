// Frame extractor for reference footage. Uses system AVFoundation so the
// project never takes an ffmpeg dependency just to look at a .mov.
//
//   swift tools/extract-frames.swift <video> <outDir> <count> [maxWidth]

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 4 else {
    FileHandle.standardError.write("usage: extract-frames <video> <outDir> <count> [maxWidth]\n".data(using: .utf8)!)
    exit(2)
}

let src = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2])
let count = Int(args[3]) ?? 24
let maxWidth = args.count > 4 ? Int(args[4]) ?? 720 : 720

try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let asset = AVURLAsset(url: src)
let sem = DispatchSemaphore(value: 0)
var duration: Double = 0
var natural = CGSize(width: 1080, height: 1920)

Task {
    if let d = try? await asset.load(.duration) { duration = CMTimeGetSeconds(d) }
    if let track = try? await asset.loadTracks(withMediaType: .video).first,
       let size = try? await track.load(.naturalSize) {
        natural = size
    }
    sem.signal()
}
sem.wait()

guard duration > 0 else {
    FileHandle.standardError.write("could not read duration\n".data(using: .utf8)!)
    exit(1)
}

let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
// Exact frames matter: we are comparing motion, and a half-second of tolerance
// would silently hand back the same frame twice.
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero
let scale = min(1.0, Double(maxWidth) / Double(max(natural.width, 1)))
gen.maximumSize = CGSize(width: natural.width * scale, height: natural.height * scale)

print("duration \(String(format: "%.2f", duration))s  source \(Int(natural.width))x\(Int(natural.height))")

var written = 0
for i in 0..<count {
    // Inset from both ends: the first and last frames of a screen recording are
    // usually a black fade or the home screen.
    let t = duration * (Double(i) + 0.5) / Double(count)
    let time = CMTime(seconds: t, preferredTimescale: 600)
    do {
        let cg = try gen.copyCGImage(at: time, actualTime: nil)
        let name = String(format: "frame_%03d_%06.2fs.jpg", i, t)
        let url = outDir.appendingPathComponent(name)
        guard let dest = CGImageDestinationCreateWithURL(
            url as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ) else { continue }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        if CGImageDestinationFinalize(dest) { written += 1 }
    } catch {
        FileHandle.standardError.write("frame \(i) @\(t)s failed: \(error)\n".data(using: .utf8)!)
    }
}

print("wrote \(written)/\(count) frames to \(outDir.path)")

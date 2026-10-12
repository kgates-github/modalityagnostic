// Speech sidecar entrypoint. Control protocol over stdin/stdout, NDJSON:
//   stdin:  {"cmd":"start"} | {"cmd":"stop"}
//   stdout: {"type":"ready"}
//           {"type":"status","text":"..."}     -- model install / setup progress
//           {"type":"volatile","text":"..."}   -- fast, may still change
//           {"type":"final","text":"..."}      -- stable, resolved utterance
//           {"type":"error","text":"..."}
//
// Uses the macOS 26+ Speech framework (SpeechAnalyzer/SpeechTranscriber):
// .progressiveTranscription is the low-latency preset -- it's what gives us
// fast, frequently-updated volatile results instead of waiting for stable ones.

import Foundation
import Speech
import AVFoundation

protocol TranscriptSource {
    func start(onEvent: @escaping @Sendable (String, String) -> Void)
    func stop()
}

// start()/stop() only ever run serially from the single-threaded stdin loop in
// main (one call completes -- including cancelling any prior Task -- before
// the next begins), so the mutable state below never sees concurrent access
// despite being touched from both that loop and the Task it spawns.
final class SpeechTranscriberSource: TranscriptSource, @unchecked Sendable {
    private var task: Task<Void, Never>?
    private var analyzer: SpeechAnalyzer?
    private var captureProvider: CaptureInputSequenceProvider?

    func start(onEvent: @escaping @Sendable (String, String) -> Void) {
        stop()
        task = Task {
            do {
                let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) ?? Locale(identifier: "en-US")
                let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)

                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    onEvent("status", "installing speech model")
                    try await request.downloadAndInstall()
                }

                guard let device = AVCaptureDevice.default(for: .audio) else {
                    onEvent("error", "no audio input device")
                    return
                }

                let analyzer = SpeechAnalyzer(modules: [transcriber])
                self.analyzer = analyzer

                let provider = try await CaptureInputSequenceProvider.providerWithSession(
                    from: device, compatibleWith: [transcriber]
                )
                self.captureProvider = provider

                try await analyzer.start(inputSequence: provider.analyzerInputs)
                provider.captureSession.startRunning()
                onEvent("status", "listening")

                for try await result in transcriber.results {
                    if Task.isCancelled { break }
                    let text = String(result.text.characters)
                    onEvent(result.isFinal ? "final" : "volatile", text)
                }
            } catch {
                onEvent("error", "\(error)")
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        captureProvider?.captureSession.stopRunning()
        captureProvider = nil
        let analyzerToStop = analyzer
        analyzer = nil
        Task { await analyzerToStop?.cancelAndFinishNow() }
    }
}

func emit(_ obj: [String: String]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

let source: TranscriptSource = SpeechTranscriberSource()
emit(["type": "ready"])

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          let cmd = obj["cmd"]
    else { continue }

    switch cmd {
    case "start":
        source.start { type, text in emit(["type": type, "text": text]) }
    case "stop":
        source.stop()
    default:
        break
    }
}

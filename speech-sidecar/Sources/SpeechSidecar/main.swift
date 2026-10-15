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

    // stop() tears a session down via an unawaited background Task (it has
    // to finalize() before it can cancel -- see stop() below), so a NEW
    // start() can begin running concurrently with an OLD session's teardown
    // still in flight. If that old session's trailing "final" (the real
    // result stop() was waiting to flush) lands after the new session has
    // already started, there's nothing distinguishing it as stale -- it
    // reads as a perfectly normal event for the CURRENT session, and the
    // client ends up applying the previous utterance's text/type to the
    // brand new bounding box (measured: reproduced exactly this way).
    // generation tags which start() a given result loop belongs to; any
    // result produced after a NEWER start() has begun gets dropped instead
    // of emitted, the same way the client itself only trusts its current
    // closure-bound session (see bindSpeechSession in App.tsx).
    private var generation = 0

    func start(onEvent: @escaping @Sendable (String, String) -> Void) {
        stop()
        generation += 1
        let myGeneration = generation
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
                    if Task.isCancelled || myGeneration != generation { break }
                    let text = String(result.text.characters)
                    onEvent(result.isFinal ? "final" : "volatile", text)
                }
            } catch {
                if myGeneration == generation {
                    onEvent("error", "\(error)")
                }
            }
        }
    }

    func stop() {
        // Measured via logs: finalizeAndFinishThroughEndOfInput() never
        // produced a "final" event at all -- only ever volatile, then
        // nothing, forever. Root cause: it waits for the INPUT SEQUENCE to
        // reach a natural end, but CaptureInputSequenceProvider exposes no
        // way to actually end analyzerInputs -- stopping the capture session
        // halts new audio, it doesn't terminate that AsyncSequence. So the
        // await just hangs.
        //
        // finalize(through:) is the right call for a live, user-stopped
        // session: it finalizes whatever's already been analyzed without
        // needing end-of-input. No cutoff time to pass (nothing here tracks
        // one), so nil -- finalize everything available right now. Follow up
        // with cancelAndFinishNow() to actually tear the analyzer down,
        // which is fine to be abrupt about since finalize() already flushed
        // the real result first.
        //
        // Don't cancel the results-reading task up front either: the loop in
        // start() checks Task.isCancelled and breaks immediately, which
        // would beat finalize to the punch and drop the result it's about to
        // produce.
        captureProvider?.captureSession.stopRunning()
        captureProvider = nil
        let analyzerToStop = analyzer
        analyzer = nil
        let taskToRelease = task
        task = nil
        Task {
            try? await analyzerToStop?.finalize(through: nil)
            await analyzerToStop?.cancelAndFinishNow()
            taskToRelease?.cancel()
        }
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

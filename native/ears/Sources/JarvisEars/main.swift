import Foundation
import AVFoundation
import CoreAudio
import Speech

// jarvis-ears: microphone + on-device speech recognition sidecar for the
// Electron app. One JSON object per line on stdout, commands on stdin.
//
//   jarvis-ears [--locale en-US] [--vocab "a|b|c"] [--engine analyzer|dictation]
//   analyzer: SpeechAnalyzer (macOS 26+), more accurate, updates about once a second.
//   dictation: the classic SFSpeechRecognizer, updates word by word.
//
// In a quiet room the recogniser hears nothing (see SoundGate): it gets the audio from just before a
// sound until a few seconds after it, and all of it while a command is being heard.
//
// out: {"type":"ready"} {"type":"text","text":"…","final":false} {"type":"level","v":0.2} (while armed)
//      {"type":"restarted"} {"type":"pcm","b64":"…"} (while pcm is on: 16 kHz s16le mono)
//      {"type":"devices","list":[{"id":1,"name":"…","default":true}]}
//      {"type":"file_text","id":"…","text":"…"} {"type":"log","msg":"…"} {"type":"error","msg":"…"}
// in:  {"cmd":"reset"} {"cmd":"mute","on":true} {"cmd":"armed","on":true} {"cmd":"echo","on":false}
//      {"cmd":"pcm","on":true} {"cmd":"suspend"} {"cmd":"resume"} {"cmd":"devices"} {"cmd":"set_input","id":42}
//      {"cmd":"transcribe_file","id":"…","path":"/tmp/x.wav"}

// MARK: output

let outQueue = DispatchQueue(label: "ears.out")
func emit(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    data.append(0x0A)
    outQueue.async { FileHandle.standardOutput.write(data) }
}
func log(_ msg: String) { emit(["type": "log", "msg": msg]) }

var argLocale = "en-US", argVocab: [String] = [], argEngine = "analyzer"
do {
    let a = CommandLine.arguments
    var i = 1
    while i < a.count {
        if a[i] == "--locale", i + 1 < a.count { argLocale = a[i + 1]; i += 1 }
        else if a[i] == "--vocab", i + 1 < a.count { argVocab = a[i + 1].split(separator: "|").map(String.init); i += 1 }
        else if a[i] == "--engine", i + 1 < a.count { argEngine = a[i + 1]; i += 1 }
        i += 1
    }
}

// `jarvis-ears --permissions [--prompt]`: print microphone and speech-recognition access as JSON and exit.
// With --prompt, ask macOS to show its dialogs first. Setup uses this to check and ask on demand.
if CommandLine.arguments.contains("--permissions") {
    func word(_ a: AVAuthorizationStatus) -> String { a == .authorized ? "allowed" : a == .notDetermined ? "not-asked" : "denied" }
    func word(_ s: SFSpeechRecognizerAuthorizationStatus) -> String { s == .authorized ? "allowed" : s == .notDetermined ? "not-asked" : "denied" }
    let report = {
        let out: [String: Any] = ["mic": word(AVCaptureDevice.authorizationStatus(for: .audio)), "speech": word(SFSpeechRecognizer.authorizationStatus())]
        if let d = try? JSONSerialization.data(withJSONObject: out) { FileHandle.standardOutput.write(d); FileHandle.standardOutput.write(Data([0x0A])) }
        exit(0)
    }
    if CommandLine.arguments.contains("--prompt") {
        AVCaptureDevice.requestAccess(for: .audio) { _ in SFSpeechRecognizer.requestAuthorization { _ in report() } }
        RunLoop.main.run()
    }
    report()
}

// MARK: audio devices (CoreAudio)

enum AudioDevices {
    static func inputDevices() -> [(id: AudioDeviceID, name: String)] {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            guard inputChannels(id) > 0, let n = name(id) else { return nil }
            return (id, n)
        }
    }

    static func defaultInput() -> AudioDeviceID {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return id
    }

    @discardableResult
    static func setDefaultInput(_ id: AudioDeviceID) -> Bool {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value = id
        return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &value) == noErr
    }

    private static func name(_ id: AudioDeviceID) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var name: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &name) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
        return status == noErr ? (name as String) : nil
    }

    private static func inputChannels(_ id: AudioDeviceID) -> Int {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    static func emitList() {
        let d = defaultInput()
        emit(["type": "devices", "list": inputDevices().map { ["id": Int($0.id), "name": $0.name, "default": $0.id == d] }])
    }
}

// MARK: SpeechAnalyzer (macOS 26+)

// FoundationModels is new in the macOS 26 SDK, so it stands in for SpeechAnalyzer's availability.
#if canImport(FoundationModels)
@available(macOS 26, *)
final class ModernTranscriber {
    var onText: ((String, Bool) -> Void)?
    private let locale: Locale
    private let vocabulary: [String]
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzerFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var resultsTask: Task<Void, Never>?
    private var analyzer: SpeechAnalyzer?
    private let lock = NSLock()
    private var framesFed: Int64 = 0
    private var cutoff: Double = 0
    private var finals: [(start: Double, text: String)] = []
    private var volatile: (start: Double, text: String)?
    private var generation = 0
    private(set) var ready = false

    init(locale: Locale, vocabulary: [String]) { self.locale = locale; self.vocabulary = vocabulary }

    func setup() async throws {
        let supported = await SpeechTranscriber.supportedLocales
        let loc = supported.first { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
            ?? supported.first { $0.language.languageCode == locale.language.languageCode } ?? locale
        let t = SpeechTranscriber(locale: loc, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [.audioTimeRange])
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [t]) {
            log("downloading speech model for \(loc.identifier)…")
            try await req.downloadAndInstall()
        }
        let a = SpeechAnalyzer(modules: [t])
        let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [t])
        if !vocabulary.isEmpty {
            let ctx = AnalysisContext()
            ctx.contextualStrings[.general] = vocabulary
            try? await a.setContext(ctx)
        }
        let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
        try await a.start(inputSequence: stream)
        analyzer = a
        continuation = cont
        lock.withLock { analyzerFormat = fmt; converter = nil }
        resultsTask = Task { [weak self] in
            do {
                for try await r in t.results {
                    self?.consume(start: r.range.start.seconds, text: String(r.text.characters), final: r.isFinal)
                }
            } catch { log("analyzer results ended: \(error)") }
        }
        ready = true
        log("SpeechAnalyzer ready (\(loc.identifier), \(fmt.map { "\(Int($0.sampleRate)) Hz" } ?? "?"))")
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard ready, let cont = continuation else { return }
        lock.lock()
        guard let target = analyzerFormat else { lock.unlock(); return }
        if converter == nil || converter!.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: target) }
        let conv = converter
        lock.unlock()
        guard let conv, let out = convert(buffer, with: conv, to: target) else { return }
        lock.lock(); framesFed += Int64(out.frameLength); lock.unlock()
        cont.yield(AnalyzerInput(buffer: out))
    }

    func reset() {
        lock.lock()
        cutoff = Double(framesFed) / (analyzerFormat?.sampleRate ?? 16000)
        finals.removeAll(); volatile = nil; generation += 1
        lock.unlock()
    }

    private func consume(start: Double, text: String, final: Bool) {
        lock.lock()
        if final { finals.append((start, text)); volatile = nil } else { volatile = (start, text) }
        let c = cutoff
        var parts = finals.filter { $0.start >= c - 0.15 }.map { $0.text }
        if let v = volatile, v.start >= c - 0.15 { parts.append(v.text) }
        let gen = generation
        lock.unlock()
        let joined = parts.joined(separator: " ").replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
        guard !joined.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.lock.lock(); let cur = self.generation; self.lock.unlock()
            guard gen == cur else { return }
            self.onText?(joined, final)
        }
    }
}
#else
// Older SDKs lack SpeechAnalyzer. Only reached on a macOS 26 runtime; setup() throws so the legacy recogniser takes over.
@available(macOS 26, *)
final class ModernTranscriber {
    var onText: ((String, Bool) -> Void)?
    var ready: Bool { false }
    init(locale: Locale, vocabulary: [String]) {}
    func setup() async throws { throw NSError(domain: "JarvisEars", code: 1, userInfo: [NSLocalizedDescriptionKey: "built without the macOS 26 SDK"]) }
    func append(_ b: AVAudioPCMBuffer) {}
    func reset() {}
}
#endif

func convert(_ buffer: AVAudioPCMBuffer, with conv: AVAudioConverter, to target: AVAudioFormat) -> AVAudioPCMBuffer? {
    let ratio = target.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
    var fed = false
    var err: NSError?
    conv.convert(to: out, error: &err) { _, status in
        if fed { status.pointee = .noDataNow; return nil }
        fed = true; status.pointee = .haveData; return buffer
    }
    return (err == nil && out.frameLength > 0) ? out : nil
}

// MARK: listener

final class Ears: NSObject {
    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var modern: AnyObject?
    private var running = false
    private(set) var muted = false
    private var suspended = false
    private var armed = false
    var pcmOn = false
    private var generation = 0
    private var restartTimer: Timer?
    private var lastLevelAt = Date.distantPast
    private var pcmConverter: AVAudioConverter?
    private let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private var pcmPending = Data()
    // The sound gate, and the audio held back while it is shut. Used from the audio thread and main.
    private enum GateState { case open, opening, closed }
    private let gateLock = NSLock()
    private var gate = SoundGate()
    private var gateState = GateState.open
    // Echo cancellation (voice processing) costs about a quarter of a core, so JARVIS turns it on only
    // while it talks or music plays ({"cmd":"echo"}). On until told otherwise.
    private var echoOn = true
    private var preroll: [AVAudioPCMBuffer] = []
    private var prerollFrames: AVAudioFrameCount = 0

    override init() {
        super.init()
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: argLocale))
    }

    func start() {
        NotificationCenter.default.addObserver(self, selector: #selector(configChanged), name: .AVAudioEngineConfigurationChange, object: engine)
        do { try startEngine() } catch { emit(["type": "error", "msg": "microphone failed: \(error.localizedDescription)"]); return }
        resetGate()
        running = true
        do {
            if #available(macOS 26, *), argEngine != "dictation" {
                let m = ModernTranscriber(locale: Locale(identifier: argLocale), vocabulary: argVocab)
                m.onText = { [weak self] t, f in self?.text(t, f) }
                modern = m
                Task {
                    do {
                        try await m.setup()
                        await MainActor.run { self.endTask(); m.reset(); emit(["type": "restarted"]) }
                    } catch {
                        log("SpeechAnalyzer failed (\(error)), using legacy recogniser")
                        await MainActor.run { self.modern = nil; self.restartTask() }
                    }
                }
            }
            beginTask()   // legacy covers the seconds until the analyzer is ready
        }
        emit(["type": "ready"])
    }

    private var modernIsReady: Bool {
        if #available(macOS 26, *), let m = modern as? ModernTranscriber { return m.ready }
        return false
    }
    private func modernAppend(_ b: AVAudioPCMBuffer) {
        if #available(macOS 26, *), let m = modern as? ModernTranscriber { m.append(b) }
    }
    private func modernReset() {
        if #available(macOS 26, *), let m = modern as? ModernTranscriber { m.reset() }
    }

    // MARK: commands

    func setMuted(_ on: Bool) {
        muted = on
        if on { resetGate() }
        if !on, running, !suspended { restartTask() }
    }

    func setArmed(_ on: Bool) { armed = on }

    /// Echo cancellation on or off. The engine restarts to switch, a gap of a fraction of a second.
    func setEcho(_ on: Bool) {
        guard on != echoOn else { return }
        echoOn = on
        guard running, !suspended else { return }
        endTask()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        do { try startEngine() } catch { log("engine restart failed: \(error)") }
        resetGate()
        restartTask()
        emit(["type": "restarted"])
        log("echo cancellation \(on ? "on" : "off")")
    }

    func reset() { if running { restartTask() } }

    func suspend() {
        guard running, !suspended else { return }
        suspended = true
        endTask()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        resetGate()
        log("audio suspended (mic released, echo cancellation off)")
    }

    func resume() {
        guard running, suspended else { return }
        suspended = false
        do { try startEngine() } catch { log("resume failed: \(error)") }
        resetGate()
        restartTask()
        log("audio resumed")
    }

    // MARK: engine

    private func startEngine() throws {
        let input = engine.inputNode
        do {
            try input.setVoiceProcessingEnabled(echoOn)
            if #available(macOS 14.0, *) {
                input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            }
        } catch { log("voice processing unavailable: \(error)") }
        let format = input.outputFormat(forBus: 0)
        let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)!
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self, !self.muted else { return }
            let b = Self.monoCopy(buffer, to: mono)
            let level = Self.rms(b)
            if self.pcmOn { self.pushPCM(b) }
            self.hear(b, level: level)
            // The HUD only shows the level while a command is being heard.
            let now = Date()
            if self.armed, now.timeIntervalSince(self.lastLevelAt) > 0.066 {
                self.lastLevelAt = now
                emit(["type": "level", "v": Double(level)])
            }
        }
        engine.prepare()
        try engine.start()
        let name = AudioDevices.inputDevices().first { $0.id == AudioDevices.defaultInput() }?.name ?? "?"
        log("engine started, input '\(name)' \(Int(format.sampleRate)) Hz x\(format.channelCount)")
    }

    @objc private func configChanged(_ n: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.running, !self.suspended else { return }
            log("audio configuration changed, restarting engine")
            self.endTask()
            self.engine.stop()
            do { try self.startEngine() } catch { log("engine restart failed: \(error)") }
            self.resetGate()   // what it held back may be in the old format
            self.restartTask()
            emit(["type": "restarted"])
            AudioDevices.emitList()
        }
    }

    /// pcm mode: 16 kHz mono s16le chunks (~100 ms) for cloud transcription.
    private func pushPCM(_ b: AVAudioPCMBuffer) {
        if pcmConverter == nil || pcmConverter!.inputFormat != b.format { pcmConverter = AVAudioConverter(from: b.format, to: pcmFormat) }
        guard let conv = pcmConverter, let out = convert(b, with: conv, to: pcmFormat), let ch = out.int16ChannelData else { return }
        pcmPending.append(Data(bytes: ch[0], count: Int(out.frameLength) * 2))
        if pcmPending.count >= 3200 {
            emit(["type": "pcm", "b64": pcmPending.base64EncodedString()])
            pcmPending.removeAll(keepingCapacity: true)
        }
    }

    // MARK: sound gate

    /// One buffer from the microphone: to the recogniser while the gate is open, held back while it is shut.
    private func hear(_ b: AVAudioPCMBuffer, level: Float) {
        gateLock.lock()
        let wanted = gate.hear(level, at: Date().timeIntervalSinceReferenceDate, busy: armed)
        switch gateState {
        case .open where wanted:
            gateLock.unlock()
            feed(b)
        case .open:
            gateState = .closed
            keep(b)
            gateLock.unlock()
            DispatchQueue.main.async { self.gateClosed() }
        case .opening:
            keep(b, trim: false)   // main is about to replay them
            gateLock.unlock()
        case .closed:
            keep(b)
            if wanted { gateState = .opening }
            gateLock.unlock()
            if wanted { DispatchQueue.main.async { self.gateOpened() } }
        }
    }

    private func feed(_ b: AVAudioPCMBuffer) {
        if modernIsReady { modernAppend(b) } else { request?.append(b) }
    }

    /// Keeps the last SoundGate.preroll seconds. Call with gateLock held.
    private func keep(_ b: AVAudioPCMBuffer, trim: Bool = true) {
        preroll.append(b)
        prerollFrames += b.frameLength
        let limit = AVAudioFrameCount(SoundGate.preroll * b.format.sampleRate)
        while trim, preroll.count > 1, prerollFrames - preroll[0].frameLength >= limit {
            prerollFrames -= preroll.removeFirst().frameLength
        }
    }

    /// A sound: a fresh task hears the second before it, then everything live.
    private func gateOpened() {
        gateLock.lock()
        defer { gateLock.unlock() }
        guard gateState == .opening else { return }
        if running && !muted && !suspended {
            endTask()
            beginTask()
            emit(["type": "restarted"])
            for b in preroll { feed(b) }
        }
        preroll.removeAll()
        prerollFrames = 0
        gateState = .open
    }

    /// Quiet for SoundGate.hold seconds: the task ends until the next sound.
    private func gateClosed() {
        gateLock.lock()
        let closed = gateState == .closed
        gateLock.unlock()
        if closed { endTask() }
    }

    /// Open, with nothing held back.
    private func resetGate() {
        gateLock.lock()
        gate.reset(at: Date().timeIntervalSinceReferenceDate)
        gateState = .open
        preroll.removeAll()
        prerollFrames = 0
        gateLock.unlock()
    }

    // MARK: recognition

    private func beginTask() {
        if modernIsReady { modernReset(); return }
        guard let recognizer, recognizer.isAvailable else { return }
        generation += 1
        let gen = generation
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.addsPunctuation = false
        req.contextualStrings = argVocab
        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self, gen == self.generation else { return }
            if let result { self.text(result.bestTranscription.formattedString, result.isFinal) }
            if let error {
                let code = (error as NSError).code
                if code != 216 && code != 301 { log("task error \(code): \(error.localizedDescription)") }
            }
            if error != nil || (result?.isFinal ?? false) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                    guard let self, self.running, !self.muted, gen == self.generation else { return }
                    self.restartTask()
                    emit(["type": "restarted"])
                }
            }
        }
        // A fresh legacy task every 50 s while nobody is mid-command keeps it responsive.
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in
            guard let self, !self.armed, !self.modernIsReady else { return }
            self.restartTask()
            emit(["type": "restarted"])
        }
    }

    private func endTask() {
        generation += 1
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        restartTimer?.invalidate(); restartTimer = nil
    }

    /// A fresh task, if the gate is open; a shut gate starts one when it next opens.
    private func restartTask() {
        endTask()
        gateLock.lock()
        let open = gateState == .open
        gateLock.unlock()
        if running && !muted && !suspended && open { beginTask() }
    }

    private func text(_ t: String, _ final: Bool) {
        guard !muted else { return }
        emit(["type": "text", "text": t, "final": final])
    }

    // MARK: helpers

    static func monoCopy(_ buffer: AVAudioPCMBuffer, to mono: AVAudioFormat) -> AVAudioPCMBuffer {
        let channels = Int(buffer.format.channelCount)
        guard channels > 1, let src = buffer.floatChannelData,
              let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
              let dst = out.floatChannelData else { return buffer }
        let n = Int(buffer.frameLength)
        out.frameLength = buffer.frameLength
        let scale = 1 / Float(channels)
        if buffer.format.isInterleaved {
            for i in 0..<n { var s: Float = 0; for c in 0..<channels { s += src[0][i * channels + c] }; dst[0][i] = s * scale }
        } else {
            for i in 0..<n { var s: Float = 0; for c in 0..<channels { s += src[c][i] }; dst[0][i] = s * scale }
        }
        return out
    }

    static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let ch = buffer.floatChannelData?[0] else { return 0 }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<n { sum += ch[i] * ch[i] }
        return min(1, sqrt(sum / Float(n)) * 8)
    }
}

// MARK: file transcription (Telegram voice notes)

func transcribeFile(id: String, path: String) {
    let rec = SFSpeechRecognizer(locale: Locale(identifier: argLocale))
    let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    req.requiresOnDeviceRecognition = true
    var done = false
    rec?.recognitionTask(with: req) { result, error in
        guard !done else { return }
        if let result, result.isFinal { done = true; emit(["type": "file_text", "id": id, "text": result.bestTranscription.formattedString]) }
        else if error != nil { done = true; emit(["type": "file_text", "id": id, "text": ""]) }
    }
}

// MARK: main

let ears = Ears()

func handle(_ obj: [String: Any]) {
    switch obj["cmd"] as? String ?? "" {
    case "reset": ears.reset()
    case "mute": ears.setMuted(obj["on"] as? Bool ?? true)
    case "pcm": ears.pcmOn = obj["on"] as? Bool ?? false
    case "armed": ears.setArmed(obj["on"] as? Bool ?? false)
    case "echo": ears.setEcho(obj["on"] as? Bool ?? true)
    case "suspend": ears.suspend()
    case "resume": ears.resume()
    case "devices": AudioDevices.emitList()
    case "set_input":
        if let id = (obj["id"] as? NSNumber)?.uint32Value { AudioDevices.setDefaultInput(id); AudioDevices.emitList() }
    case "transcribe_file":
        if let id = obj["id"] as? String, let path = obj["path"] as? String { transcribeFile(id: id, path: path) }
    case "quit": exit(0)
    default: break
    }
}

var stdinPending = Data()
FileHandle.standardInput.readabilityHandler = { h in
    let chunk = h.availableData
    if chunk.isEmpty { exit(0) }   // parent went away
    DispatchQueue.main.async {
        stdinPending.append(chunk)
        while let nl = stdinPending.firstIndex(of: 0x0A) {
            let line = stdinPending.subdata(in: stdinPending.startIndex..<nl)
            stdinPending.removeSubrange(stdinPending.startIndex...nl)
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { handle(obj) }
        }
    }
}

AVCaptureDevice.requestAccess(for: .audio) { micOK in
    guard micOK else { emit(["type": "error", "msg": "Microphone permission denied. Allow JARVIS in System Settings → Privacy & Security → Microphone."]); return }
    let go = { DispatchQueue.main.async { ears.start(); AudioDevices.emitList() } }
    SFSpeechRecognizer.requestAuthorization { st in
        if st != .authorized { emit(["type": "error", "msg": "Speech recognition permission denied. Allow JARVIS in System Settings → Privacy & Security → Speech Recognition."]); return }
        go()
    }
}

RunLoop.main.run()

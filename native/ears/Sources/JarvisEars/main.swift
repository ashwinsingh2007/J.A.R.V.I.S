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
// out: {"type":"ready"} {"type":"text","text":"…","final":false} {"type":"level","v":0.2}
//      {"type":"restarted"} {"type":"pcm","b64":"…"} (while pcm is on: 16 kHz s16le mono)
//      {"type":"devices","list":[{"id":1,"name":"…","default":true}]}
//      {"type":"file_text","id":"…","text":"…"} {"type":"log","msg":"…"} {"type":"error","msg":"…"}
// in:  {"cmd":"reset"} {"cmd":"mute","on":true} {"cmd":"armed","on":true}
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

    override init() {
        super.init()
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: argLocale))
    }

    func start() {
        NotificationCenter.default.addObserver(self, selector: #selector(configChanged), name: .AVAudioEngineConfigurationChange, object: engine)
        do { try startEngine() } catch { emit(["type": "error", "msg": "microphone failed: \(error.localizedDescription)"]); return }
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
                        await MainActor.run { self.modern = nil; if self.running && !self.muted { self.beginTask() } }
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
        if !on, running, !suspended { restartTask() }
    }

    func setArmed(_ on: Bool) { armed = on }

    func reset() { if running { restartTask() } }

    func suspend() {
        guard running, !suspended else { return }
        suspended = true
        endTask()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        log("audio suspended (mic released, echo cancellation off)")
    }

    func resume() {
        guard running, suspended else { return }
        suspended = false
        do { try startEngine() } catch { log("resume failed: \(error)") }
        if !muted { beginTask() }
        log("audio resumed")
    }

    // MARK: engine

    private func startEngine() throws {
        let input = engine.inputNode
        do {
            try input.setVoiceProcessingEnabled(true)
            if #available(macOS 14.0, *) {
                input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            }
        } catch { log("voice processing unavailable: \(error)") }
        let format = input.outputFormat(forBus: 0)
        let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)!
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let b = Self.monoCopy(buffer, to: mono)
            if !self.muted {
                if self.pcmOn { self.pushPCM(b) }
                if self.modernIsReady { self.modernAppend(b) }
                else { self.request?.append(b) }
            }
            let now = Date()
            if now.timeIntervalSince(self.lastLevelAt) > 0.066 {
                self.lastLevelAt = now
                emit(["type": "level", "v": Double(Self.rms(b))])
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
            if !self.muted { self.beginTask() }
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

    private func restartTask() {
        endTask()
        if running && !muted && !suspended { beginTask() }
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

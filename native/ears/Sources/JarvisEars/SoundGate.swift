import Foundation

/// When the speech recogniser needs the microphone. Feeding it a silent room all day costs CPU here
/// and in Apple's speech services, so it only hears what follows a sound: a level of at least
/// `threshold` in two of the last three buffers opens the gate, and `hold` seconds without one close
/// it again. While a command is being heard (`busy`) it stays open. The listener keeps the last
/// `preroll` seconds of audio and replays them when the gate opens, so the first word arrives whole.
struct SoundGate {
    /// On the listener's rms() scale (RMS × 8), about -52 dBFS. A quiet room with echo cancellation
    /// sits around 0.01; speech across a room is well above 0.05.
    static let threshold: Float = 0.02
    static let hold: TimeInterval = 4
    static let preroll: TimeInterval = 1

    private var before: (Bool, Bool) = (false, false)   // whether the two previous buffers were loud
    private(set) var lastSound: TimeInterval = -.infinity

    /// One buffer's level. Returns whether the recogniser should be hearing now.
    mutating func hear(_ level: Float, at now: TimeInterval, busy: Bool = false) -> Bool {
        let loud = level >= Self.threshold
        if busy || (loud && (before.0 || before.1)) { lastSound = now }
        before = (before.1, loud)
        return now - lastSound < Self.hold
    }

    /// Open, as if a sound had just been heard (start, resume, a new input device).
    mutating func reset(at now: TimeInterval) {
        before = (false, false)
        lastSound = now
    }
}

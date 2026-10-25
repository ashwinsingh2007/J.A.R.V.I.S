// jarvis-hands: lets JARVIS use Mac apps outside Chrome.
//
// Accessibility first: `tree` lists the buttons, fields and text of an app's
// window with a path for each, and `press` / `set` act on a path without
// moving the mouse. Mouse, keyboard and screenshots are the fallback for apps
// that expose nothing useful. Coordinates are screen points, top-left origin,
// the same as in `tree` and in `shot`.
//
// Needs Accessibility (and Screen Recording for `shot`) for JARVIS.app, which
// macOS treats as responsible for this helper.
import Cocoa
import ApplicationServices

let usage = """
jarvis-hands <command>
  check [--prompt]            permissions (with --prompt: ask macOS to show the dialogs)
  apps                        running apps, frontmost first
  focus <App>                 bring an app to the front
  tree [App] [--max N]        buttons, fields and text of the app's front window (default: frontmost app)
  press <path> [App]          press the element at <path> (from tree)
  set <path> <text> [App]     put text into the field at <path>
  click <x> <y> [right|double]
  type <text>                 type text into whatever has focus
  key <combo>                 e.g. return, escape, cmd+s, cmd+shift+t, down
  scroll <lines>              positive scrolls down
  shot                        screenshot in points; prints the PNG path
"""

func fail(_ s: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
  exit(code)
}

func axTrusted(prompt: Bool) -> Bool {
  AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
}

func needAX() {
  if !axTrusted(prompt: false) {
    fail("NEEDS_ACCESSIBILITY: allow JARVIS in System Settings > Privacy & Security > Accessibility, then try again.", 3)
  }
}

// ---------- accessibility helpers ----------

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}

func text(_ e: AXUIElement, _ a: String) -> String {
  if let s = attr(e, a) as? String { return s }
  if let n = attr(e, a) as? NSNumber { return n.stringValue }
  return ""
}

func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

func actions(_ e: AXUIElement) -> [String] {
  var names: CFArray?
  AXUIElementCopyActionNames(e, &names)
  return (names as? [String]) ?? []
}

func frame(_ e: AXUIElement) -> CGRect? {
  guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  return CGRect(origin: pt, size: sz)
}

func findApp(_ name: String?) -> NSRunningApplication {
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  if let n = name?.lowercased(), !n.isEmpty {
    if let a = apps.first(where: { $0.localizedName?.lowercased() == n }) ?? apps.first(where: { ($0.localizedName ?? "").lowercased().contains(n) }) { return a }
    fail("app not running: \(name!)")
  }
  guard let a = NSWorkspace.shared.frontmostApplication else { fail("no frontmost app") }
  return a
}

func window(_ app: NSRunningApplication) -> AXUIElement {
  let el = AXUIElementCreateApplication(app.processIdentifier)
  if let w = attr(el, kAXFocusedWindowAttribute) { return w as! AXUIElement }
  if let ws = attr(el, kAXWindowsAttribute) as? [AXUIElement], let w = ws.first { return w }
  fail("\(app.localizedName ?? "app") has no open window")
}

let ACTIONABLE: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea",
  "AXSearchField", "AXSecureTextField", "AXComboBox", "AXLink", "AXMenuItem", "AXSlider", "AXDisclosureTriangle", "AXIncrementor", "AXCell", "AXRow", "AXTab"]
let FIELDS: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField", "AXComboBox"]

func label(_ e: AXUIElement, _ role: String) -> String {
  var l = text(e, kAXTitleAttribute)
  if l.isEmpty { l = text(e, kAXDescriptionAttribute) }
  if l.isEmpty && role != "AXSecureTextField" { l = text(e, kAXValueAttribute) }
  if l.isEmpty { l = text(e, kAXHelpAttribute) }
  if l.isEmpty { l = text(e, "AXPlaceholderValue") }
  l = l.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
  return l.count > 90 ? String(l.prefix(90)) + "…" : l
}

func tree(_ app: NSRunningApplication, max: Int) {
  let root = window(app)
  print("\(app.localizedName ?? "?") — \(text(root, kAXTitleAttribute))")
  var lines = 0
  func walk(_ e: AXUIElement, _ path: String, _ depth: Int) {
    if lines >= max || depth > 40 { return }
    let role = text(e, kAXRoleAttribute)
    let l = label(e, role)
    let acts = actions(e)
    let isText = role == "AXStaticText" || role == "AXHeading"
    if (ACTIONABLE.contains(role) || acts.contains("AXPress") || isText) && (!l.isEmpty || FIELDS.contains(role)) && !path.isEmpty {
      var at = ""
      if let f = frame(e), f.width > 0 { at = "  @\(Int(f.midX)),\(Int(f.midY))" }
      let r = role.replacingOccurrences(of: "AX", with: "").lowercased()
      print("\(path)  \(r) \"\(l)\"\(at)")
      lines += 1
    }
    for (i, k) in kids(e).enumerated() { walk(k, path.isEmpty ? "\(i)" : "\(path).\(i)", depth + 1) }
  }
  walk(root, "", 0)
  if lines >= max { print("… more elements; use --max to see more") }
}

func element(_ app: NSRunningApplication, _ path: String) -> AXUIElement {
  var e = window(app)
  for part in path.split(separator: ".") {
    guard let i = Int(part) else { fail("bad path: \(path)") }
    let k = kids(e)
    guard i < k.count else { fail("path \(path) no longer exists; run tree again") }
    e = k[i]
  }
  return e
}

// ---------- mouse and keyboard ----------

func click(_ p: CGPoint, right: Bool = false, double: Bool = false) {
  let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: btn)?.post(tap: .cghidEventTap)
  for n in 1...(double ? 2 : 1) {
    let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: btn)
    let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: btn)
    d?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    u?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    d?.post(tap: .cghidEventTap); u?.post(tap: .cghidEventTap)
    usleep(40_000)
  }
}

func typeText(_ s: String) {
  for ch in s {
    let units = Array(String(ch).utf16)
    for down in [true, false] {
      let ev = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
      ev?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      ev?.flags = []          // never inherit a modifier still held from a shortcut
      ev?.post(tap: .cghidEventTap)
    }
    usleep(8_000)
  }
}

let KEYS: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "forwarddelete": 117,
  "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
  "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
  "n": 45, "m": 46, ".": 47, "`": 50,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func key(_ combo: String) {
  var flags: CGEventFlags = []
  var code: CGKeyCode?
  for part in combo.lowercased().split(separator: "+").map(String.init) {
    switch part {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default:
      guard let c = KEYS[part] else { fail("unknown key: \(part)") }
      code = c
    }
  }
  guard let c = code else { fail("no key in: \(combo)") }
  for down in [true, false] {
    let ev = CGEvent(keyboardEventSource: nil, virtualKey: c, keyDown: down)
    ev?.flags = flags
    ev?.post(tap: .cghidEventTap)
    usleep(20_000)
  }
  usleep(60_000)
}

// ---------- main ----------

var args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { print(usage); exit(0) }
args.removeFirst()
func arg(_ i: Int) -> String? { i < args.count ? args[i] : nil }

switch cmd {
case "check":
  let prompt = args.contains("--prompt")
  let ax = axTrusted(prompt: prompt)
  var screen = CGPreflightScreenCaptureAccess()
  if prompt && !screen { screen = CGRequestScreenCaptureAccess() }
  print("accessibility: \(ax ? "yes" : "no")")
  print("screen recording: \(screen ? "yes" : "no")")
case "apps":
  let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    .sorted { ($0.processIdentifier == front ? 0 : 1) < ($1.processIdentifier == front ? 0 : 1) }
  for a in apps { print((a.processIdentifier == front ? "* " : "  ") + (a.localizedName ?? "?")) }
case "focus":
  guard let n = arg(0) else { fail(usage) }
  let a = findApp(n)
  a.activate()
  usleep(300_000)
  print("focused \(a.localizedName ?? n)")
case "tree":
  needAX()
  var max = 250, name: String?
  var i = 0
  while i < args.count {
    if args[i] == "--max", let v = arg(i + 1), let n = Int(v) { max = n; i += 2 } else { name = args[i]; i += 1 }
  }
  tree(findApp(name), max: max)
case "press":
  needAX()
  guard let p = arg(0) else { fail(usage) }
  let app = findApp(arg(1))
  let e = element(app, p)
  let acts = actions(e)
  if acts.contains("AXPress") { AXUIElementPerformAction(e, "AXPress" as CFString) }
  else if acts.contains("AXConfirm") { AXUIElementPerformAction(e, "AXConfirm" as CFString) }
  else if let f = frame(e) { click(CGPoint(x: f.midX, y: f.midY)) }
  else { fail("element at \(p) can't be pressed") }
  print("pressed \(p) \"\(label(e, text(e, kAXRoleAttribute)))\"")
case "set":
  needAX()
  guard let p = arg(0), let t = arg(1) else { fail(usage) }
  let e = element(findApp(arg(2)), p)
  AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  let r = AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, t as CFString)
  if r != .success { fail("couldn't set text at \(p) (error \(r.rawValue)); try press then type") }
  print("set \(p)")
case "click":
  needAX()
  guard let x = Double(arg(0) ?? ""), let y = Double(arg(1) ?? "") else { fail(usage) }
  click(CGPoint(x: x, y: y), right: arg(2) == "right", double: arg(2) == "double")
  print("clicked \(Int(x)),\(Int(y))")
case "type":
  needAX()
  let t = args.joined(separator: " ")
  if t.isEmpty { fail(usage) }
  typeText(t)
  print("typed \(t.count) characters")
case "key":
  needAX()
  guard let c = arg(0) else { fail(usage) }
  key(c)
  print("pressed \(c)")
case "scroll":
  needAX()
  guard let n = Int32(arg(0) ?? "") else { fail(usage) }
  CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: -n, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
  print("scrolled \(n)")
case "shot":
  if !CGPreflightScreenCaptureAccess() { fail("NEEDS_SCREEN_RECORDING: allow JARVIS in System Settings > Privacy & Security > Screen Recording.", 3) }
  let dir = (NSHomeDirectory() as NSString).appendingPathComponent(".jarvis/agents/tmp")
  try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
  let f = "\(dir)/screen-\(Int(Date().timeIntervalSince1970)).png"
  let width = Int(NSScreen.screens.first?.frame.width ?? 1440)
  for (exe, a) in [("/usr/sbin/screencapture", ["-x", "-m", "-t", "png", f]), ("/usr/bin/sips", ["--resampleWidth", "\(width)", f])] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = a
    p.standardOutput = FileHandle.nullDevice
    try? p.run(); p.waitUntilExit()
  }
  print(f)
  print("1 pixel = 1 point; use these coordinates with click")
default:
  fail(usage)
}

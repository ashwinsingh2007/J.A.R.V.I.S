// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "JarvisEars",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "JarvisEars", path: "Sources/JarvisEars")]
)

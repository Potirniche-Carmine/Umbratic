// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UmbraticModelsFolder",
    platforms: [.macOS("15.0")],
    products: [.executable(name: "models-folder", targets: ["UmbraticModelsFolder"])],
    targets: [
        .executableTarget(
            name: "UmbraticModelsFolder",
            path: "infrastructure/veil-console/deploy/models-folder",
            exclude: ["Info.plist"],
            sources: ["main.swift"]
        ),
    ]
)

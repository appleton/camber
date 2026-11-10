// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "CamberMLXSidecar",
    platforms: [.macOS("14.0")],
    products: [
        .executable(name: "camber-mlx-sidecar", targets: ["CamberMLXSidecar"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.88.0"),
        .package(
            url: "https://github.com/osaurus-ai/vmlx-swift",
            revision: "9e0b60f8288ca682913e0e33c20287af6f57281d"
        ),
    ],
    targets: [
        .executableTarget(
            name: "CamberMLXSidecar",
            dependencies: [
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "MLXLMCommon", package: "vmlx-swift"),
                .product(name: "MLXPress", package: "vmlx-swift"),
            ]
        )
    ]
)

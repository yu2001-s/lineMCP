import AppKit
import ImageIO
import SwiftUI

extension Color {
	private static func dynamic(light: NSColor, dark: NSColor) -> Color {
		Color(nsColor: NSColor(name: nil) { appearance in
			appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
		})
	}

	/// Other people's bubbles, the neutral gray of Messages.
	static let bubbleTheirs = dynamic(
		light: NSColor(red: 0.914, green: 0.914, blue: 0.922, alpha: 1),
		dark: NSColor(red: 0.231, green: 0.231, blue: 0.239, alpha: 1),
	)
	/// Your bubbles follow the system accent colour.
	static let bubbleMine = Color.accentColor
}

/// A circular profile picture, or the name's first character on a colour that
/// stays the same for each person, so people without a picture are still told apart.
struct Avatar: View {
	let name: String
	let url: URL?
	let seed: String
	var size: CGFloat = 36

	@State private var image: NSImage?

	var body: some View {
		ZStack {
			if let image {
				Image(nsImage: image).resizable().scaledToFill()
			} else {
				Circle().fill(Self.color(for: seed).gradient)
				Text(initial)
					.font(.system(size: size * 0.42, weight: .medium, design: .rounded))
					.foregroundStyle(.white)
			}
		}
		.frame(width: size, height: size)
		.clipShape(Circle())
		.task(id: url) {
			guard let url else {
				image = nil
				return
			}
			image = await ImagePipeline.shared.publicImage(url, maxPixel: size * 2)
		}
	}

	private var initial: String {
		name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
	}

	private static let palette: [Color] = [.blue, .green, .orange, .pink, .purple, .teal, .indigo, .mint, .cyan, .brown, .red]

	static func color(for seed: String) -> Color {
		let hash = seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
		return palette[Int(hash % UInt32(palette.count))]
	}
}

/// A public CDN image (stickers, profile pictures).
struct RemoteImage: View {
	let url: URL
	var maxPixel: CGFloat = 300

	@State private var image: NSImage?

	var body: some View {
		Group {
			if let image {
				Image(nsImage: image).resizable().scaledToFit()
			} else {
				Color.clear
			}
		}
		.task(id: url) {
			image = await ImagePipeline.shared.publicImage(url, maxPixel: maxPixel)
		}
	}
}

/// Plays an animated sticker (APNG) once when it appears; click to replay.
struct StickerView: View {
	let sticker: Sticker
	var size: CGFloat = 120

	@State private var player = FramePlayer()

	var body: some View {
		ZStack {
			if let frame = player.frame {
				Image(decorative: frame, scale: 2).resizable().scaledToFit()
			} else {
				RemoteImage(url: sticker.staticURL, maxPixel: size * 2)
			}
		}
		.frame(width: size, height: size)
		.pressable("貼圖") {
			if sticker.animated { Task { await play() } }
		}
		.task(id: sticker.stickerId) {
			if sticker.animated { await play() }
		}
		.onDisappear { player.halt() }
	}

	private func play() async {
		guard let data = try? await MediaStore.shared.publicData(sticker.url) else { return }
		player.play(data)
	}
}

@MainActor
@Observable
final class FramePlayer {
	private(set) var frame: CGImage?
	@ObservationIgnored private var generation = 0

	func play(_ data: Data) {
		generation += 1
		let current = generation
		let options = [kCGImageAnimationLoopCount: 1] as CFDictionary
		CGAnimateImageDataWithBlock(data as CFData, options) { [weak self] _, image, stop in
			MainActor.assumeIsolated {
				guard let self, self.generation == current else {
					stop.pointee = true
					return
				}
				// ImageIO recycles the frame it hands over: kept as is, it turns
				// blank once playback ends, so keep a copy instead.
				self.frame = Self.copy(image) ?? image
			}
		}
	}

	func halt() {
		generation += 1
	}

	private static func copy(_ image: CGImage) -> CGImage? {
		let space = image.colorSpace.flatMap { $0.model == .rgb ? $0 : nil } ?? CGColorSpace(name: CGColorSpace.sRGB)!
		guard let context = CGContext(
			data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
			space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
		) else { return nil }
		context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
		return context.makeImage()
	}
}

/// A one-line notice: connection problems, errors, hints.
struct InfoStrip: View {
	enum Tone { case info, warning, error }

	let text: String
	var tone: Tone = .info
	var systemImage: String?
	var onClose: (() -> Void)?

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 8) {
			if let systemImage {
				Image(systemName: systemImage).foregroundStyle(color)
			}
			Text(text)
				.foregroundStyle(.primary)
				.lineLimit(3)
				.fixedSize(horizontal: false, vertical: true)
			Spacer(minLength: 0)
			if let onClose {
				Button(action: onClose) {
					Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
				}
				.buttonStyle(.borderless)
				.help("關閉")
			}
		}
		.font(.callout)
		.padding(.horizontal, 10)
		.padding(.vertical, 7)
		.background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
	}

	private var color: Color {
		switch tone {
		case .info: .secondary
		case .warning: .orange
		case .error: .red
		}
	}
}

extension View {
	/// Custom content as a plain button: clickable, and pressable with VoiceOver.
	func pressable(_ label: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(label)
	}
}
